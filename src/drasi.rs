// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! The `Drasi` napi class — embeds a `DrasiLib` engine, dynamically loads
//! cdylib plugins, and supports JavaScript-defined sources and reactions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use napi::bindgen_prelude::PromiseRaw;
use napi::Env;
use napi_derive::napi;
use serde_json::Value;
use tokio::sync::mpsc;

use drasi_core::models::{SourceChange, SourceMiddlewareConfig};
use drasi_host_sdk::callbacks;
use drasi_host_sdk::loader::{PluginLoader, PluginLoaderConfig};
use drasi_host_sdk::plugin_types::PluginFileEvent;
use drasi_host_sdk::watcher::{PluginWatcher, PluginWatcherConfig};
use drasi_lib::secret_store::SecretStoreProvider;
use drasi_lib::identity::{
    ApplicationIdentityProvider, Credentials, IdentityProvider, PasswordIdentityProvider,
};
use drasi_lib::{DrasiLib, MemorySecretStoreProvider, Query};
use drasi_plugin_sdk::{
    BootstrapPluginDescriptor, IdentityProviderPluginDescriptor, ReactionPluginDescriptor,
    SourcePluginDescriptor,
};
use drasi_plugin_sdk::prelude::SecretStorePluginDescriptor;

use crate::components::{JsDurableResultFn, JsReaction, JsResultFn, JsSource};
use crate::conversions::{json_to_source_change, plugin_config_schema, resolve_query_language};
use crate::error::{coded_message, throw_coded, to_napi, CodedReason, DrasiErrorCode};
use crate::secrets::{
    build_config_resolver_context, config_resolver_callback, ConfigResolverContext,
    SwappableSecretStoreProvider,
};
use crate::verification::{verification_decision, verification_to_json};

/// File patterns for discovering cdylib plugins (Unix + Windows naming).
const PLUGIN_FILE_PATTERNS: &[&str] = &[
    "libdrasi_source_*",
    "libdrasi_reaction_*",
    "libdrasi_bootstrap_*",
    "libdrasi_secret_store_*",
    "libdrasi_secret-store_*",
    "libdrasi_identity_*",
    "drasi_source_*",
    "drasi_reaction_*",
    "drasi_bootstrap_*",
    "drasi_secret_store_*",
    "drasi_secret-store_*",
    "drasi_identity_*",
];

/// Kinds registered from a single plugin file, for deregistration on removal.
#[derive(Default, Clone)]
struct PluginFileKinds {
    sources: Vec<String>,
    reactions: Vec<String>,
    bootstrap: Vec<String>,
    secret_stores: Vec<String>,
    identity_providers: Vec<String>,
}

/// Shared, interior-mutable state behind the JS `Drasi` object.
struct Inner {
    drasi: Arc<DrasiLib>,
    sources: Mutex<HashMap<String, Arc<dyn SourcePluginDescriptor>>>,
    reactions: Mutex<HashMap<String, Arc<dyn ReactionPluginDescriptor>>>,
    bootstrap: Mutex<HashMap<String, Arc<dyn BootstrapPluginDescriptor>>>,
    secret_stores: Mutex<HashMap<String, Arc<dyn SecretStorePluginDescriptor>>>,
    identity_providers: Mutex<HashMap<String, Arc<dyn IdentityProviderPluginDescriptor>>>,
    js_source_senders: Mutex<HashMap<String, mpsc::Sender<SourceChange>>>,
    watchers: Mutex<Vec<PluginWatcher>>,
    /// Maps a plugin file path to the kinds it registered (for watcher removal).
    plugin_files: Mutex<HashMap<String, PluginFileKinds>>,
    /// The active secret store provider, swappable at runtime via `useSecretStore`.
    ///
    /// Starts as the in-memory store seeded from `create`/`fromConfig` options.
    /// `useSecretStore` replaces the inner `Arc` so the resolver thread, which
    /// holds an `Arc<SwappableSecretStoreProvider>` pointing at the same
    /// `RwLock`, picks up the new provider on its next request.
    active_secret_provider: Arc<RwLock<Arc<dyn SecretStoreProvider>>>,
    /// This engine instance's id, used when lazily building the callback context.
    instance_id: String,
    /// Whether a durable (disk-backed) state store is configured — required for
    /// durable JS reactions (audit gap G7).
    has_durable_state_store: bool,
    /// Leaked `ConfigResolverContext` pointer (process-lifetime) injected into
    /// plugins so they can resolve `ConfigValue::Secret`/`EnvironmentVariable`.
    ///
    /// Created lazily (only when cdylib plugins are actually loaded) so pure-JS
    /// instances allocate nothing and spawn no resolver thread. The box stays
    /// leaked for the life of the process because plugins retain a raw pointer to
    /// it, but its OS thread is reclaimed on drop via `shutdown_config_resolver`.
    resolver_ctx: OnceLock<usize>,
    /// Leaked `CallbackContext` pointer routing plugin logs/lifecycle events into
    /// DrasiLib's log registry. Created lazily alongside `resolver_ctx`.
    callback_ctx: OnceLock<usize>,
}

impl Inner {
    /// Lazily build (exactly once) the leaked config-resolver and callback
    /// contexts that cdylib plugins require, returning their raw pointers.
    ///
    /// These are created only when plugins are actually loaded, so pure-JS
    /// instances never allocate them or spawn a resolver thread. A loaded plugin
    /// stores the returned pointers in process-global statics that outlive this
    /// instance and the never-unloaded cdylib, so the boxes must stay leaked for
    /// the life of the process. The resolver's OS thread, however, is reclaimed
    /// on drop/close via [`Inner::shutdown_config_resolver`].
    fn ensure_plugin_contexts(&self) -> (usize, usize) {
        let resolver_ctx = *self.resolver_ctx.get_or_init(|| {
            // Wrap active_secret_provider in a SwappableSecretStoreProvider so
            // the resolver thread automatically uses whatever provider is current
            // when useSecretStore later replaces the inner Arc.
            let swappable = SwappableSecretStoreProvider {
                inner: self.active_secret_provider.clone(),
            };
            build_config_resolver_context(
                Arc::new(swappable),
                tokio::runtime::Handle::current(),
            ) as usize
        });
        let callback_ctx = *self.callback_ctx.get_or_init(|| {
            Arc::new(drasi_host_sdk::CallbackContext {
                instance_id: self.instance_id.clone(),
                runtime_handle: tokio::runtime::Handle::current(),
                log_registry: self.drasi.log_registry(),
                source_event_history: Arc::new(tokio::sync::RwLock::new(
                    drasi_lib::managers::ComponentEventHistory::new(),
                )),
                reaction_event_history: Arc::new(tokio::sync::RwLock::new(
                    drasi_lib::managers::ComponentEventHistory::new(),
                )),
            })
            .into_raw() as usize
        });
        (resolver_ctx, callback_ctx)
    }

    /// Terminate the config-resolver OS thread if one was started. Idempotent, so
    /// it is safe to call from both `close()` and `Drop`.
    fn shutdown_config_resolver(&self) {
        if let Some(&ptr) = self.resolver_ctx.get() {
            // SAFETY: the context box is intentionally leaked (never freed) for
            // the life of the process, so this pointer is always valid.
            unsafe { &*(ptr as *const ConfigResolverContext) }.shutdown();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Reclaim the per-instance resolver thread when the engine is dropped.
        // The leaked context boxes remain (a plugin cdylib holds raw pointers to
        // them for the life of the process); only the OS thread is reclaimed.
        self.shutdown_config_resolver();
    }
}

/// The embedded Drasi engine, exposed to JavaScript.
#[napi]
pub struct Drasi {
    inner: Arc<Inner>,
}

#[napi]
impl Drasi {
    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    /// Create a new embedded Drasi engine instance (not yet started).
    ///
    /// `options` may include `{ secrets: { NAME: "value", ... } }` to seed an
    /// in-memory secret store used to resolve `ConfigValue::Secret` references.
    ///
    /// Option validation (`stateStore`) is performed synchronously and throws a
    /// typed error (`err.code`); the engine build itself resolves asynchronously.
    #[napi(ts_args_type = "id: string, options?: CreateOptions")]
    pub fn create<'a>(
        env: &'a Env,
        id: String,
        options: Option<Value>,
    ) -> napi::Result<PromiseRaw<'a, Drasi>> {
        // Build an in-memory secret store, seeded from options.secrets.
        let mut store = MemorySecretStoreProvider::new();
        if let Some(opts) = options.as_ref() {
            if let Some(secrets) = opts.get("secrets").and_then(|v| v.as_object()) {
                for (name, value) in secrets {
                    if let Some(s) = value.as_str() {
                        store = store.with_secret(name, s);
                    }
                }
            }
        }
        let provider: Arc<dyn SecretStoreProvider> = Arc::new(store);

        // Validate the optional persistent state store synchronously so callers
        // get a typed `err.code`, e.g. { stateStore: { kind: 'redb', path: '...' } }.
        let state_path = parse_state_store(env, options.as_ref())?;
        // Optional RocksDB persistent query-index backend (gap G6) and identity
        // provider (gap G8) — both validated synchronously for typed errors.
        let index_store = parse_index_store(env, options.as_ref())?;
        let identity = parse_identity(env, options.as_ref())?;

        env.spawn_future(async move {
            build_engine(
                id,
                provider,
                EngineParams { state_path, index_store, identity },
            )
            .await
        })
    }

    /// Build and start an engine from a declarative config object:
    /// ```json
    /// { "id": "app", "secrets": {…}, "stateStore": {…}, "pluginsDir": "./plugins",
    ///   "sources":   [{ "kind": "mock", "id": "s", "config": {…}, "bootstrap"?: {…} }],
    ///   "queries":   [{ "id": "q", "query": "…", "sources": ["s"], "language"?: "cypher", "joins"?: [{ "id": "REL", "keys": [{ "label": "a", "property": "k" }] }] }],
    ///   "reactions": [{ "kind": "log", "id": "r", "queries": ["q"], "config": {…} }] }
    /// ```
    /// The returned engine is already started; components auto-start as they are added.
    ///
    /// Required-field and `stateStore` validation is performed synchronously and
    /// throws a typed error (`err.code`); the engine build, plugin load, start,
    /// and component creation resolve asynchronously.
    #[napi(ts_args_type = "config: DrasiConfig", ts_return_type = "Promise<Drasi>")]
    pub fn from_config<'a>(env: &'a Env, config: Value) -> napi::Result<PromiseRaw<'a, Drasi>> {
        let id = config
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("drasi")
            .to_string();

        // Seed the secret store and validate the state store synchronously.
        let mut store = MemorySecretStoreProvider::new();
        if let Some(secrets) = config.get("secrets").and_then(|v| v.as_object()) {
            for (name, value) in secrets {
                if let Some(s) = value.as_str() {
                    store = store.with_secret(name, s);
                }
            }
        }
        let provider: Arc<dyn SecretStoreProvider> = Arc::new(store);
        let state_path = parse_state_store(env, Some(&config))?;
        let index_store = parse_index_store(env, Some(&config))?;
        let identity = parse_identity(env, Some(&config))?;

        // Validate required fields synchronously so callers get a typed `err.code`.
        let arr = |key: &str| -> Vec<Value> {
            config
                .get(key)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        };
        let req_str = |v: &Value, key: &str| -> napi::Result<String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| {
                    throw_coded(
                        env,
                        DrasiErrorCode::MissingConfigField,
                        format!("config entry is missing '{key}'"),
                    )
                })
        };
        let str_vec = |v: &Value, key: &str| -> Vec<String> {
            v.get(key)
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };

        type SourceSpec = (String, String, Value, Option<bool>, Option<Value>);
        type QuerySpec = (String, String, ParsedQueryParts, bool, Option<Value>);
        type ReactionSpec = (String, String, Vec<String>, Value);

        let mut sources: Vec<SourceSpec> = Vec::new();
        for s in arr("sources") {
            let kind = req_str(&s, "kind")?;
            let sid = req_str(&s, "id")?;
            let cfg = s.get("config").cloned().unwrap_or_else(|| Value::Object(Default::default()));
            let auto = s.get("autoStart").and_then(|v| v.as_bool());
            let bootstrap = s.get("bootstrap").cloned();
            sources.push((kind, sid, cfg, auto, bootstrap));
        }
        let mut queries: Vec<QuerySpec> = Vec::new();
        for q in arr("queries") {
            let qid = req_str(&q, "id")?;
            let text = req_str(&q, "query")?;
            let language = q.get("language").and_then(|v| v.as_str()).map(String::from);
            // Validate the language synchronously so a typo throws a typed
            // `err.code` up front instead of silently becoming Cypher (gap G10).
            let is_gql = resolve_query_language(language.as_deref())
                .map_err(|r| throw_coded(env, r.code, r.message))?;
            // `sources` accepts `string | { id, pipeline? }` entries; `middleware`
            // is an optional `{ kind, name, config? }[]`. Parse + cross-validate
            // synchronously so pipeline/middleware mistakes throw a typed code. A
            // present-but-non-array `sources` is a typed error rather than a silent
            // empty list.
            let srcs = query_sources_from_config(q.get("sources"))
                .map_err(|r| throw_coded(env, r.code, r.message))?;
            let middleware = q.get("middleware").cloned();
            let parts = parse_query_parts(srcs, middleware)
                .map_err(|r| throw_coded(env, r.code, r.message))?;
            let joins = q.get("joins").cloned();
            queries.push((qid, text, parts, is_gql, joins));
        }
        let mut reactions: Vec<ReactionSpec> = Vec::new();
        for r in arr("reactions") {
            let kind = req_str(&r, "kind")?;
            let rid = req_str(&r, "id")?;
            let qs = str_vec(&r, "queries");
            let cfg = r.get("config").cloned().unwrap_or_else(|| Value::Object(Default::default()));
            reactions.push((kind, rid, qs, cfg));
        }
        let plugins_dir = config.get("pluginsDir").and_then(|v| v.as_str()).map(String::from);

        env.spawn_future(async move {
            let drasi = build_engine(
                id,
                provider,
                EngineParams { state_path, index_store, identity },
            )
            .await?;

            if let Some(dir) = plugins_dir {
                drasi.load_plugins(dir, None).await?;
            }
            drasi.start().await?;

            for (kind, sid, cfg, auto, bootstrap) in sources {
                add_source_full(drasi.inner.clone(), kind, sid, cfg, auto.unwrap_or(true), bootstrap)
                    .await?;
            }
            for (qid, text, parts, is_gql, joins) in queries {
                let def = build_query_def(qid, text, parts, is_gql, joins)?;
                drasi.inner.drasi.add_query(def).await.map_err(to_napi)?;
            }
            for (kind, rid, qs, cfg) in reactions {
                add_reaction_full(drasi.inner.clone(), kind, rid, qs, cfg).await?;
            }

            Ok(drasi)
        })
    }

    // ------------------------------------------------------------------
    // Plugin discovery
    // ------------------------------------------------------------------

    /// Discover and load all cdylib plugins from `dir`, registering their
    /// descriptors. Returns `{ plugins, sources, reactions, bootstrap,
    /// secretStores, identityProviders }`.
    ///
    /// When `verify` is provided as `{ filename: sha256hex }`, only plugin files
    /// whose contents hash to the expected value are loaded (an integrity allowlist).
    #[napi(
        ts_args_type = "dir: string, verify?: Record<string, string>",
        ts_return_type = "Promise<LoadPluginsResult>"
    )]
    pub async fn load_plugins(&self, dir: String, verify: Option<Value>) -> napi::Result<Value> {
        let verify_map: Option<HashMap<String, String>> = verify.as_ref().and_then(|v| {
            v.as_object().map(|o| {
                o.iter()
                    .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
        });
        let (plugins, sources, reactions, bootstrap, secret_stores, identity_providers) =
            load_dir_into(&self.inner, &dir, verify_map.as_ref()).map_err(to_napi)?;
        Ok(serde_json::json!({
            "plugins": plugins,
            "sources": sources,
            "reactions": reactions,
            "bootstrap": bootstrap,
            "secretStores": secret_stores,
            "identityProviders": identity_providers,
        }))
    }

    /// Watch `dir` for plugin file changes and automatically (re)load plugins as
    /// they are added or changed. Newly registered kinds become available for
    /// `addSource`/`addReaction` without restarting the process.
    #[napi]
    pub async fn watch_plugins(&self, dir: String) -> napi::Result<()> {
        let mut watcher = PluginWatcher::new(PluginWatcherConfig {
            plugins_dir: std::path::PathBuf::from(&dir),
            debounce: std::time::Duration::from_secs(1),
        });
        let mut rx = watcher.subscribe();
        watcher.start().map_err(to_napi)?;

        let inner = self.inner.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                match event {
                    PluginFileEvent::Added(_) | PluginFileEvent::Changed(_) => {
                        if let Err(e) = load_dir_into(&inner, &dir, None) {
                            log::warn!("plugin reload failed: {e}");
                        }
                    }
                    PluginFileEvent::Removed(path) => {
                        let key = path.to_string_lossy().to_string();
                        let rec = inner.plugin_files.lock().unwrap().remove(&key);
                        if let Some(rec) = rec {
                            for k in &rec.sources {
                                inner.sources.lock().unwrap().remove(k);
                            }
                            for k in &rec.reactions {
                                inner.reactions.lock().unwrap().remove(k);
                            }
                            for k in &rec.bootstrap {
                                inner.bootstrap.lock().unwrap().remove(k);
                            }
                            for k in &rec.secret_stores {
                                inner.secret_stores.lock().unwrap().remove(k);
                            }
                            for k in &rec.identity_providers {
                                inner.identity_providers.lock().unwrap().remove(k);
                            }
                            log::info!(
                                "plugin removed; deregistered its kinds (the cdylib stays mapped): {key}"
                            );
                        }
                    }
                }
            }
        });

        self.inner.watchers.lock().unwrap().push(watcher);
        Ok(())
    }

    /// List available tags for a plugin repository in the configured OCI registry
    /// (default `ghcr.io/drasi-project`), e.g. `listPluginTags("source/postgres")`.
    #[napi(ts_return_type = "Promise<string[]>")]
    pub async fn list_plugin_tags(&self, repository: String) -> napi::Result<Value> {
        use drasi_host_sdk::registry::{OciRegistryClient, RegistryConfig};
        let client = OciRegistryClient::new(RegistryConfig::default());
        let tags = client.list_tags(&repository).await.map_err(to_napi)?;
        Ok(serde_json::json!(tags))
    }

    /// Download a plugin artifact from an OCI registry to `destDir` as `filename`.
    ///
    /// `reference` is a full OCI reference, e.g.
    /// `"ghcr.io/drasi-project/source/postgres:0.1.13-windows-msvc-amd64"`.
    ///
    /// Cosign verification is opt-in via `options` (audit gap G5). With none (or
    /// `verify: false`) the artifact is downloaded and `verification.status` is
    /// `"unsigned"`. When `verify` is set, the signature is checked and its status
    /// surfaced; a `"tampered"` artifact is always rejected — its file is removed
    /// and the promise rejects with `PLUGIN_SIGNATURE_INVALID`. With `requireSigned`
    /// an `"unsigned"` artifact is likewise rejected.
    ///
    /// Returns `{ path, verification }`. After pulling, call `loadPlugins(destDir)`
    /// (or `watchPlugins`) to register it.
    #[napi(
        ts_args_type = "reference: string, destDir: string, filename: string, options?: PullPluginOptions",
        ts_return_type = "Promise<PullPluginResult>"
    )]
    pub async fn pull_plugin(
        &self,
        reference: String,
        dest_dir: String,
        filename: String,
        options: Option<Value>,
    ) -> napi::Result<Value> {
        let (path, verification) =
            download_and_verify(&reference, &dest_dir, &filename, options.as_ref()).await?;
        Ok(serde_json::json!({ "path": path, "verification": verification }))
    }

    /// Resolve a (possibly tag-less) plugin `reference` to the specific artifact
    /// for this host — without downloading it.
    ///
    /// This is the platform- and version-aware resolution `drasi-server`'s
    /// auto-install uses: given a bare ref like `"source/postgres"` (the default
    /// registry `ghcr.io/drasi-project` is assumed), it selects the OCI tag for
    /// the build target, verifies the plugin's SDK/core/lib versions are
    /// compatible with the versions this addon was built against, and returns a
    /// digest-pinned reference plus the exact `filename` to save the cdylib as
    /// (so `loadPlugins` discovers it). Rejects incompatible or missing builds
    /// with a typed error. Pass the result's `reference` + `filename` to
    /// `pullPlugin`, or use `installPlugin` to do both in one call.
    #[napi(ts_args_type = "reference: string", ts_return_type = "Promise<ResolvedPlugin>")]
    pub async fn resolve_plugin(&self, reference: String) -> napi::Result<Value> {
        Ok(resolved_plugin_to_json(&resolve_for_host(&reference).await?))
    }

    /// Resolve `reference` for this host and download the resulting artifact into
    /// `destDir` in one call — the high-level counterpart to `pullPlugin`.
    ///
    /// Unlike `pullPlugin` (which needs an exact platform-tagged reference and
    /// filename), this accepts a bare ref like `"source/postgres"`, resolves it
    /// with [`resolvePlugin`](Self::resolve_plugin) (platform + version
    /// compatibility), downloads the compatible artifact under the resolver's
    /// derived filename, applies the same opt-in cosign verification as
    /// `pullPlugin`, and returns `{ path, resolved, verification }`. After it
    /// resolves, call `loadPlugins(destDir)` (or `watchPlugins`) to register the
    /// plugin.
    #[napi(
        ts_args_type = "reference: string, destDir: string, options?: PullPluginOptions",
        ts_return_type = "Promise<InstallPluginResult>"
    )]
    pub async fn install_plugin(
        &self,
        reference: String,
        dest_dir: String,
        options: Option<Value>,
    ) -> napi::Result<Value> {
        let resolved = resolve_for_host(&reference).await?;
        let (path, verification) = download_and_verify(
            &resolved.reference,
            &dest_dir,
            &resolved.filename,
            options.as_ref(),
        )
        .await?;
        Ok(serde_json::json!({
            "path": path,
            "resolved": resolved_plugin_to_json(&resolved),
            "verification": verification,
        }))
    }

    /// Return the registered plugin kinds: `{ sources, reactions, bootstrap,
    /// secretStores, identityProviders }`.
    #[napi(ts_return_type = "PluginKinds")]
    pub fn plugin_kinds(&self) -> Value {
        let sources: Vec<String> = self.inner.sources.lock().unwrap().keys().cloned().collect();
        let reactions: Vec<String> =
            self.inner.reactions.lock().unwrap().keys().cloned().collect();
        let bootstrap: Vec<String> =
            self.inner.bootstrap.lock().unwrap().keys().cloned().collect();
        let secret_stores: Vec<String> =
            self.inner.secret_stores.lock().unwrap().keys().cloned().collect();
        let identity_providers: Vec<String> =
            self.inner.identity_providers.lock().unwrap().keys().cloned().collect();
        serde_json::json!({
            "sources": sources,
            "reactions": reactions,
            "bootstrap": bootstrap,
            "secretStores": secret_stores,
            "identityProviders": identity_providers,
        })
    }

    /// Return the config schema advertised by a registered **source** plugin kind
    /// as `{ name, schema }` (audit gap G9). `name` is the root config DTO key
    /// within `schema`, an object of OpenAPI (utoipa) schema definitions. Throws a
    /// typed `UNKNOWN_SOURCE_KIND` error if the kind is not registered.
    ///
    /// Config is still marshaled as opaque JSON at runtime; this exposes the
    /// plugin's declared schema so callers can validate config (e.g. with ajv)
    /// before `addSource`. Malformed config is also surfaced as a typed
    /// `CONFIG_INVALID` error from `addSource`/`updateSource`.
    #[napi(ts_return_type = "PluginConfigSchema")]
    pub fn source_config_schema(&self, env: &Env, kind: String) -> napi::Result<Value> {
        let descriptor = { self.inner.sources.lock().unwrap().get(&kind).cloned() }.ok_or_else(
            || throw_coded(env, DrasiErrorCode::UnknownSourceKind, format!("unknown source kind '{kind}'")),
        )?;
        Ok(plugin_config_schema(
            descriptor.config_schema_name(),
            &descriptor.config_schema_json(),
        ))
    }

    /// Return the config schema advertised by a registered **reaction** plugin
    /// kind as `{ name, schema }` (audit gap G9). Throws a typed
    /// `UNKNOWN_REACTION_KIND` error if the kind is not registered.
    #[napi(ts_return_type = "PluginConfigSchema")]
    pub fn reaction_config_schema(&self, env: &Env, kind: String) -> napi::Result<Value> {
        let descriptor = { self.inner.reactions.lock().unwrap().get(&kind).cloned() }.ok_or_else(
            || throw_coded(env, DrasiErrorCode::UnknownReactionKind, format!("unknown reaction kind '{kind}'")),
        )?;
        Ok(plugin_config_schema(
            descriptor.config_schema_name(),
            &descriptor.config_schema_json(),
        ))
    }

    /// Return the config schema advertised by a registered **bootstrap** plugin
    /// kind as `{ name, schema }` (audit gap G9). Throws a typed
    /// `UNKNOWN_BOOTSTRAP_KIND` error if the kind is not registered.
    #[napi(ts_return_type = "PluginConfigSchema")]
    pub fn bootstrap_config_schema(&self, env: &Env, kind: String) -> napi::Result<Value> {
        let descriptor = { self.inner.bootstrap.lock().unwrap().get(&kind).cloned() }.ok_or_else(
            || throw_coded(env, DrasiErrorCode::UnknownBootstrapKind, format!("unknown bootstrap kind '{kind}'")),
        )?;
        Ok(plugin_config_schema(
            descriptor.config_schema_name(),
            &descriptor.config_schema_json(),
        ))
    }

    /// Return the config schema advertised by a registered **secret store** plugin
    /// kind as `{ name, schema }`. Throws a typed `UNKNOWN_SECRET_STORE_KIND`
    /// error if the kind is not registered.
    #[napi(ts_return_type = "PluginConfigSchema")]
    pub fn secret_store_config_schema(&self, env: &Env, kind: String) -> napi::Result<Value> {
        let descriptor = {
            self.inner.secret_stores.lock().unwrap().get(&kind).cloned()
        }
        .ok_or_else(|| {
            throw_coded(
                env,
                DrasiErrorCode::UnknownSecretStoreKind,
                format!("unknown secret store kind '{kind}'"),
            )
        })?;
        Ok(plugin_config_schema(
            descriptor.config_schema_name(),
            &descriptor.config_schema_json(),
        ))
    }

    /// Return the config schema advertised by a registered **identity provider**
    /// plugin kind as `{ name, schema }`. Throws a typed
    /// `UNKNOWN_IDENTITY_PROVIDER_KIND` error if the kind is not registered.
    #[napi(ts_return_type = "PluginConfigSchema")]
    pub fn identity_provider_config_schema(
        &self,
        env: &Env,
        kind: String,
    ) -> napi::Result<Value> {
        let descriptor = {
            self.inner
                .identity_providers
                .lock()
                .unwrap()
                .get(&kind)
                .cloned()
        }
        .ok_or_else(|| {
            throw_coded(
                env,
                DrasiErrorCode::UnknownIdentityProviderKind,
                format!("unknown identity provider kind '{kind}'"),
            )
        })?;
        Ok(plugin_config_schema(
            descriptor.config_schema_name(),
            &descriptor.config_schema_json(),
        ))
    }

    /// Activate a plugin-provided secret store.
    ///
    /// Creates a [`SecretStoreProvider`] from the registered plugin `kind` with
    /// the given `config` and replaces the active store used by the config
    /// resolver. Subsequent `ConfigValue::Secret` references in plugin configs
    /// resolve through the new store.
    ///
    /// Must be called after `loadPlugins` has registered the plugin and before
    /// any component whose config references a `Secret` value is started.
    /// Throws a typed `UNKNOWN_SECRET_STORE_KIND` error if the kind is not
    /// registered.
    #[napi(
        ts_args_type = "kind: string, config?: Record<string, unknown>",
    )]
    pub async fn use_secret_store(
        &self,
        kind: String,
        config: Option<Value>,
    ) -> napi::Result<()> {
        let config = config.unwrap_or_else(|| Value::Object(Default::default()));
        let descriptor = {
            self.inner.secret_stores.lock().unwrap().get(&kind).cloned()
        }
        .ok_or_else(|| {
            coded_message(
                DrasiErrorCode::UnknownSecretStoreKind,
                format!("unknown secret store kind '{kind}'"),
            )
        })?;

        let provider: Box<dyn SecretStoreProvider> = descriptor
            .create_secret_store(&config)
            .await
            .map_err(|e| {
                coded_message(DrasiErrorCode::ConfigInvalid, e.to_string())
            })?;

        // Swap the active provider. The resolver thread picks up the new
        // provider on its next request because SwappableSecretStoreProvider
        // reads through the same RwLock.
        *self
            .inner
            .active_secret_provider
            .write()
            .expect("active_secret_provider lock poisoned") = Arc::from(provider);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Sources
    // ------------------------------------------------------------------

    /// Add a source instance of the given plugin `kind` with a JSON config.
    ///
    /// `bootstrap`, when provided as `{ kind, config }`, attaches a bootstrap
    /// provider so subscribing queries receive an initial snapshot.
    ///
    /// The `kind` and `bootstrap.kind` are validated synchronously (typed
    /// `err.code`); creating and registering the source resolves asynchronously.
    #[napi(
        ts_args_type = "kind: string, id: string, config: Record<string, unknown>, autoStart?: boolean, bootstrap?: BootstrapConfig",
        ts_return_type = "Promise<void>"
    )]
    pub fn add_source<'a>(
        &self,
        env: &'a Env,
        kind: String,
        id: String,
        config: Value,
        auto_start: Option<bool>,
        bootstrap: Option<Value>,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        validate_source_kind(env, &self.inner, &kind)?;
        validate_bootstrap(env, &self.inner, bootstrap.as_ref())?;
        let inner = self.inner.clone();
        env.spawn_future(add_source_full(
            inner,
            kind,
            id,
            config,
            auto_start.unwrap_or(true),
            bootstrap,
        ))
    }

    /// Add a programmatic source that JavaScript pushes changes into via
    /// [`push_change`](Self::push_change).
    #[napi]
    pub async fn add_js_source(&self, id: String, auto_start: Option<bool>) -> napi::Result<()> {
        let (source, tx) = JsSource::new(id.clone(), auto_start.unwrap_or(true)).map_err(to_napi)?;
        self.inner
            .js_source_senders
            .lock()
            .unwrap()
            .insert(id.clone(), tx);

        let mut meta = HashMap::new();
        meta.insert("kind".to_string(), "js-source".to_string());
        self.inner
            .drasi
            .add_source_with_metadata(source, meta)
            .await
            .map_err(to_napi)
    }

    /// Push a change into a JavaScript source created with
    /// [`add_js_source`](Self::add_js_source).
    ///
    /// `change` shape: `{ op, id, labels?, properties? }` for nodes, or include
    /// `startId`/`endId` for a relation. Awaits if the source's buffer is full
    /// (backpressure).
    ///
    /// The source id and change shape are validated synchronously (typed
    /// `err.code`); enqueueing the change resolves asynchronously.
    #[napi(
        ts_args_type = "sourceId: string, change: SourceChangeInput",
        ts_return_type = "Promise<void>"
    )]
    pub fn push_change<'a>(
        &self,
        env: &'a Env,
        source_id: String,
        change: Value,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        let tx = {
            let map = self.inner.js_source_senders.lock().unwrap();
            map.get(&source_id).cloned()
        }
        .ok_or_else(|| {
            throw_coded(
                env,
                DrasiErrorCode::NoJsSource,
                format!("no JS source '{source_id}'"),
            )
        })?;

        // If the source's receiver is already gone, fail fast with a typed code.
        if tx.is_closed() {
            return Err(throw_coded(
                env,
                DrasiErrorCode::JsSourceClosed,
                format!("JS source '{source_id}' is not accepting changes"),
            ));
        }

        let sc = json_to_source_change(&source_id, &change)
            .map_err(|r| throw_coded(env, r.code, r.message))?;

        env.spawn_future(async move {
            tx.send(sc).await.map_err(|_| {
                coded_message(
                    DrasiErrorCode::JsSourceClosed,
                    format!("JS source '{source_id}' is not accepting changes"),
                )
            })
        })
    }

    /// Remove a source. When `cleanup` is true, external state is also torn down.
    #[napi]
    pub async fn remove_source(&self, id: String, cleanup: Option<bool>) -> napi::Result<()> {
        self.inner
            .js_source_senders
            .lock()
            .unwrap()
            .remove(&id);
        self.inner
            .drasi
            .remove_source(&id, cleanup.unwrap_or(false))
            .await
            .map_err(to_napi)
    }

    /// Replace a source's configuration in place (same id).
    #[napi(
        ts_args_type = "kind: string, id: string, config: Record<string, unknown>, autoStart?: boolean",
        ts_return_type = "Promise<void>"
    )]
    pub fn update_source<'a>(
        &self,
        env: &'a Env,
        kind: String,
        id: String,
        config: Value,
        auto_start: Option<bool>,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        validate_source_kind(env, &self.inner, &kind)?;
        let inner = self.inner.clone();
        env.spawn_future(async move {
            let descriptor = { inner.sources.lock().unwrap().get(&kind).cloned() }
                .ok_or_else(|| coded_message(DrasiErrorCode::UnknownSourceKind, format!("unknown source kind '{kind}'")))?;
            let source = descriptor
                .create_source(&id, &config, auto_start.unwrap_or(true))
                .await
                .map_err(|e| coded_message(DrasiErrorCode::ConfigInvalid, e.to_string()))?;
            inner.drasi.update_source(&id, source).await.map_err(to_napi)
        })
    }

    /// Start a source by id.
    #[napi]
    pub async fn start_source(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.start_source(&id).await.map_err(to_napi)
    }

    /// Stop a source by id.
    #[napi]
    pub async fn stop_source(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.stop_source(&id).await.map_err(to_napi)
    }

    /// List sources as `[{ id, status }]`.
    #[napi(ts_return_type = "Promise<ComponentStatusEntry[]>")]
    pub async fn list_sources(&self) -> napi::Result<Value> {
        let items = self.inner.drasi.list_sources().await.map_err(to_napi)?;
        Ok(statuses_to_json(items))
    }

    /// Get the best-effort graph schema a source reports about the data flowing
    /// through it — node/relation labels, their properties, and property-type
    /// hints — or `null` when the source doesn't describe one. Sources implement
    /// this on a best-effort basis via `Source::describe_schema()`; it is
    /// informational, not enforced (drasi-core#416).
    #[napi(ts_return_type = "Promise<SourceSchema | null>")]
    pub async fn get_source_schema(&self, id: String) -> napi::Result<Value> {
        let schema = self
            .inner
            .drasi
            .get_source_schema(&id)
            .await
            .map_err(to_napi)?;
        match schema {
            Some(s) => serde_json::to_value(s).map_err(to_napi),
            None => Ok(Value::Null),
        }
    }

    /// Get the merged graph schema across all sources and queries: for each
    /// node/relation label, which sources provide it and which queries reference
    /// it, plus known properties, and any `sourcesWithoutSchema`. Useful for
    /// inspection, validation, and LLM/MCP tooling (drasi-core#416).
    #[napi(ts_return_type = "Promise<GraphSchema>")]
    pub async fn get_graph_schema(&self) -> napi::Result<Value> {
        let schema = self.inner.drasi.get_graph_schema().await.map_err(to_napi)?;
        serde_json::to_value(schema).map_err(to_napi)
    }

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    /// Add a continuous query over the given sources.
    ///
    /// `sources` entries are each either a bare source-id `string` (no middleware)
    /// or a `{ id, pipeline? }` object, where `pipeline` is an ordered list of
    /// middleware `name`s applied to changes from that source before they reach the
    /// query. `middleware` is an optional array of `{ kind, name, config? }`
    /// definitions the pipelines reference; `kind` selects a compiled-in factory
    /// (`map`, `unwind`, `parse_json`, `promote`, `relabel`, `decoder`).
    ///
    /// `language` is `"cypher"` (default) or `"gql"`. `joins` is an optional array of
    /// synthetic join definitions (`[{ id, keys: [{ label, property }] }]`) used to
    /// relate elements across sources that have no explicit relationship.
    ///
    /// `language`, the `sources`/`middleware` shapes, and pipeline references are
    /// validated synchronously (each throws a typed `err.code`:
    /// `UNKNOWN_QUERY_LANGUAGE`, `QUERY_SOURCE_INVALID`, `MIDDLEWARE_INVALID`,
    /// `UNKNOWN_MIDDLEWARE_REF`); building and registering the query resolves
    /// asynchronously.
    #[napi(
        ts_args_type = "id: string, query: string, sources: Array<string | SourceSubscription>, language?: 'cypher' | 'gql', joins?: QueryJoin[], middleware?: QueryMiddleware[]",
        ts_return_type = "Promise<void>"
    )]
    #[allow(clippy::too_many_arguments)]
    pub fn add_query<'a>(
        &self,
        env: &'a Env,
        id: String,
        query: String,
        sources: Vec<Value>,
        language: Option<String>,
        joins: Option<Value>,
        middleware: Option<Value>,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        let is_gql = resolve_query_language(language.as_deref())
            .map_err(|r| throw_coded(env, r.code, r.message))?;
        let parts = parse_query_parts(sources, middleware)
            .map_err(|r| throw_coded(env, r.code, r.message))?;
        let inner = self.inner.clone();
        env.spawn_future(async move {
            let def = build_query_def(id, query, parts, is_gql, joins)?;
            inner.drasi.add_query(def).await.map_err(to_napi)
        })
    }

    /// Remove a query by id.
    #[napi]
    pub async fn remove_query(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.remove_query(&id).await.map_err(to_napi)
    }

    /// Replace a query's definition in place (same id).
    ///
    /// `sources`, `joins`, and `middleware` match `addQuery` (source pipelines and
    /// query middleware definitions are supported). `language`, the
    /// `sources`/`middleware` shapes, and pipeline references are validated
    /// synchronously (typed `err.code`); the replacement resolves asynchronously.
    #[napi(
        ts_args_type = "id: string, query: string, sources: Array<string | SourceSubscription>, language?: 'cypher' | 'gql', joins?: QueryJoin[], middleware?: QueryMiddleware[]",
        ts_return_type = "Promise<void>"
    )]
    #[allow(clippy::too_many_arguments)]
    pub fn update_query<'a>(
        &self,
        env: &'a Env,
        id: String,
        query: String,
        sources: Vec<Value>,
        language: Option<String>,
        joins: Option<Value>,
        middleware: Option<Value>,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        let is_gql = resolve_query_language(language.as_deref())
            .map_err(|r| throw_coded(env, r.code, r.message))?;
        let parts = parse_query_parts(sources, middleware)
            .map_err(|r| throw_coded(env, r.code, r.message))?;
        let inner = self.inner.clone();
        env.spawn_future(async move {
            let def = build_query_def(id.clone(), query, parts, is_gql, joins)?;
            inner.drasi.update_query(&id, def).await.map_err(to_napi)
        })
    }

    /// Start a query by id.
    #[napi]
    pub async fn start_query(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.start_query(&id).await.map_err(to_napi)
    }

    /// Stop a query by id.
    #[napi]
    pub async fn stop_query(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.stop_query(&id).await.map_err(to_napi)
    }

    /// Get the current result set for a query as an array of objects.
    #[napi(ts_return_type = "Promise<Array<Record<string, unknown>>>")]
    pub async fn get_query_results(&self, id: String) -> napi::Result<Value> {
        let rows = self
            .inner
            .drasi
            .get_query_results(&id)
            .await
            .map_err(to_napi)?;
        Ok(Value::Array(rows))
    }

    /// List queries as `[{ id, status }]`.
    #[napi(ts_return_type = "Promise<ComponentStatusEntry[]>")]
    pub async fn list_queries(&self) -> napi::Result<Value> {
        let items = self.inner.drasi.list_queries().await.map_err(to_napi)?;
        Ok(statuses_to_json(items))
    }

    // ------------------------------------------------------------------
    // Reactions
    // ------------------------------------------------------------------

    /// Add a reaction instance of the given plugin `kind`, subscribing to
    /// `query_ids`, with a JSON config.
    ///
    /// The `kind` is validated synchronously (typed `err.code`); creating and
    /// registering the reaction resolves asynchronously.
    #[napi(
        ts_args_type = "kind: string, id: string, queryIds: Array<string>, config: Record<string, unknown>",
        ts_return_type = "Promise<void>"
    )]
    pub fn add_reaction<'a>(
        &self,
        env: &'a Env,
        kind: String,
        id: String,
        query_ids: Vec<String>,
        config: Value,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        validate_reaction_kind(env, &self.inner, &kind)?;
        let inner = self.inner.clone();
        env.spawn_future(add_reaction_full(inner, kind, id, query_ids, config))
    }

    /// Add a JavaScript-defined reaction. `callback` is a value-only function
    /// `(result) => void` invoked once per non-empty query-result batch, where
    /// `result` is the structured query result
    /// `{ query_id, sequence, timestamp, results, metadata }`. The callback is
    /// registered unref'd, so it does not keep the Node.js event loop alive.
    #[napi(
        ts_args_type = "id: string, queryIds: Array<string>, callback: (result: QueryResultEvent) => void"
    )]
    pub async fn add_js_reaction(
        &self,
        id: String,
        query_ids: Vec<String>,
        callback: JsResultFn,
    ) -> napi::Result<()> {
        let reaction = JsReaction::new(id, query_ids, callback);
        let mut meta = HashMap::new();
        meta.insert("kind".to_string(), "js-callback".to_string());
        self.inner
            .drasi
            .add_reaction_with_metadata(reaction, meta)
            .await
            .map_err(to_napi)
    }

    /// Add a **durable** JavaScript-defined reaction (audit gap G7).
    ///
    /// Unlike [`add_js_reaction`](Self::add_js_reaction), `callback` must be an
    /// async function `(result) => Promise<void>`; the reaction awaits its promise
    /// and persists a per-query checkpoint after each successfully processed
    /// result. On restart it resumes **after the last checkpointed sequence**.
    ///
    /// Behavior when the promise **rejects** is set by `options.onError`
    /// (issue #21):
    /// - `'retry'` (default): re-invoke the callback with exponential backoff until
    ///   it resolves. The reaction stays parked on the failed event, so the
    ///   checkpoint never advances past it — **per-event at-least-once**. Tunable
    ///   via `maxRetries` (finite budget escalates to `halt` once exhausted),
    ///   `retryDelayMs` (base), and `maxRetryDelayMs` (cap).
    /// - `'halt'`: stop the reaction (status `Error`) leaving the checkpoint at the
    ///   last success, so a failed sequence is never buried (head-of-line).
    /// - `'skip'`: log and advance to the next result without checkpointing the
    ///   failed one (drasi-lib's stock behavior; a later success can bury it, so
    ///   this is at-most-once for a transiently-failing callback).
    ///
    /// Requires a durable state store (`{ stateStore: { kind: 'redb', path } }`) —
    /// validated synchronously with `DURABLE_REQUIRES_STATE_STORE`. Pair with a
    /// persistent `indexStore` (rocksdb) for cross-process outbox replay.
    ///
    /// `options.recoveryPolicy` is `"skipGap"` (default) or `"strict"`.
    #[napi(
        ts_args_type = "id: string, queryIds: Array<string>, callback: (result: QueryResultEvent) => Promise<void>, options?: DurableReactionOptions",
        ts_return_type = "Promise<void>"
    )]
    pub fn add_durable_js_reaction<'a>(
        &self,
        env: &'a Env,
        id: String,
        query_ids: Vec<String>,
        callback: JsDurableResultFn,
        options: Option<Value>,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        if !self.inner.has_durable_state_store {
            return Err(throw_coded(
                env,
                DrasiErrorCode::DurableRequiresStateStore,
                "durable reactions require a durable state store — create the engine with { stateStore: { kind: 'redb', path } }",
            ));
        }
        let policy = match options
            .as_ref()
            .and_then(|o| o.get("recoveryPolicy"))
            .and_then(|v| v.as_str())
        {
            Some("strict") => drasi_lib::recovery::ReactionRecoveryPolicy::Strict,
            _ => drasi_lib::recovery::ReactionRecoveryPolicy::AutoSkipGap,
        };
        let error_policy = crate::retry::DurableErrorPolicy::from_options(options.as_ref());
        let inner = self.inner.clone();
        env.spawn_future(async move {
            let reaction = JsReaction::new_durable(id, query_ids, callback, policy, error_policy);
            let mut meta = HashMap::new();
            meta.insert("kind".to_string(), "js-callback".to_string());
            meta.insert("durable".to_string(), "true".to_string());
            inner
                .drasi
                .add_reaction_with_metadata(reaction, meta)
                .await
                .map_err(to_napi)
        })
    }

    /// Remove a reaction by id.
    #[napi]
    pub async fn remove_reaction(&self, id: String, cleanup: Option<bool>) -> napi::Result<()> {
        self.inner
            .drasi
            .remove_reaction(&id, cleanup.unwrap_or(false))
            .await
            .map_err(to_napi)
    }

    /// Replace a reaction's configuration in place (same id).
    #[napi(
        ts_args_type = "kind: string, id: string, queryIds: Array<string>, config: Record<string, unknown>",
        ts_return_type = "Promise<void>"
    )]
    pub fn update_reaction<'a>(
        &self,
        env: &'a Env,
        kind: String,
        id: String,
        query_ids: Vec<String>,
        config: Value,
    ) -> napi::Result<PromiseRaw<'a, ()>> {
        validate_reaction_kind(env, &self.inner, &kind)?;
        let inner = self.inner.clone();
        env.spawn_future(async move {
            let descriptor = { inner.reactions.lock().unwrap().get(&kind).cloned() }
                .ok_or_else(|| coded_message(DrasiErrorCode::UnknownReactionKind, format!("unknown reaction kind '{kind}'")))?;
            let reaction = descriptor
                .create_reaction(&id, query_ids, &config, true)
                .await
                .map_err(|e| coded_message(DrasiErrorCode::ConfigInvalid, e.to_string()))?;
            inner.drasi.update_reaction(&id, reaction).await.map_err(to_napi)
        })
    }

    /// Start a reaction by id.
    #[napi]
    pub async fn start_reaction(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.start_reaction(&id).await.map_err(to_napi)
    }

    /// Stop a reaction by id.
    #[napi]
    pub async fn stop_reaction(&self, id: String) -> napi::Result<()> {
        self.inner.drasi.stop_reaction(&id).await.map_err(to_napi)
    }

    /// List reactions as `[{ id, status }]`.
    #[napi(ts_return_type = "Promise<ComponentStatusEntry[]>")]
    pub async fn list_reactions(&self) -> napi::Result<Value> {
        let items = self.inner.drasi.list_reactions().await.map_err(to_napi)?;
        Ok(statuses_to_json(items))
    }

    /// Get output metrics for a query.
    #[napi(ts_return_type = "Promise<QueryMetrics>")]
    pub async fn get_query_metrics(&self, id: String) -> napi::Result<Value> {
        let m = self
            .inner
            .drasi
            .get_query_output_metrics(&id)
            .await
            .map_err(to_napi)?;
        Ok(serde_json::json!({
            "outboxSize": m.outbox_size,
            "outboxEarliestSeq": m.outbox_earliest_seq,
            "outboxLatestSeq": m.outbox_latest_seq,
            "resultSeqAdvances": m.result_seq_advances,
            "liveResultsCount": m.live_results_count,
            "outerTransactionDurationNsLast": m.outer_transaction_duration_ns_last,
            "outerTransactionDurationNsMax": m.outer_transaction_duration_ns_max,
            "snapshotFetchCount": m.snapshot_fetch_count,
        }))
    }

    /// Get per-query metrics for a reaction (`{ queryId: metrics }`).
    #[napi(ts_return_type = "Promise<Record<string, ReactionQueryMetrics>>")]
    pub async fn get_reaction_metrics(&self, id: String) -> napi::Result<Value> {
        let map = self
            .inner
            .drasi
            .get_reaction_metrics(&id)
            .await
            .map_err(to_napi)?;
        let obj: serde_json::Map<String, Value> = map
            .into_iter()
            .map(|(qid, m)| {
                (
                    qid,
                    serde_json::json!({
                        "checkpointSequence": m.checkpoint_sequence,
                        "checkpointLag": m.checkpoint_lag,
                        "dedupSkipCount": m.dedup_skip_count,
                        "gapDetectionCount": m.gap_detection_count,
                        "recoveryStrictCount": m.recovery_strict_count,
                        "recoveryAutoResetCount": m.recovery_auto_reset_count,
                        "recoveryAutoSkipGapCount": m.recovery_auto_skip_gap_count,
                        "fetchSnapshotCount": m.fetch_snapshot_count,
                        "fetchOutboxCount": m.fetch_outbox_count,
                    }),
                )
            })
            .collect();
        Ok(Value::Object(obj))
    }

    /// Get global lifecycle metrics for this instance.
    #[napi(ts_return_type = "Promise<LifecycleMetrics>")]
    pub async fn get_lifecycle_metrics(&self) -> napi::Result<Value> {
        let m = self
            .inner
            .drasi
            .get_lifecycle_metrics()
            .await
            .map_err(to_napi)?;
        Ok(serde_json::json!({
            "startupRejectionDurableNoStore": m.startup_rejection_durable_no_store,
            "startupRejectionDurableOnVolatile": m.startup_rejection_durable_on_volatile,
            "startupRejectionSnapshotSkipGap": m.startup_rejection_snapshot_skip_gap,
            "startupRejectionNoSnapshotAutoReset": m.startup_rejection_no_snapshot_auto_reset,
            "autoResetCompletions": m.auto_reset_completions,
            "hashMismatchCount": m.hash_mismatch_count,
        }))
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// Stream **all** component lifecycle events to a JS callback `(event) => …`.
    #[napi(ts_args_type = "callback: (event: Record<string, unknown>) => void")]
    pub async fn on_all_events(&self, callback: JsResultFn) -> napi::Result<()> {
        let stream = self.inner.drasi.get_all_events().await.map_err(to_napi)?;
        spawn_event_forwarder(stream, callback);
        Ok(())
    }

    /// Stream lifecycle/status events for a specific query to a JS callback.
    #[napi(ts_args_type = "id: string, callback: (event: Record<string, unknown>) => void")]
    pub async fn on_query_events(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let stream = self.inner.drasi.get_query_events(&id).await.map_err(to_napi)?;
        spawn_event_forwarder(stream, callback);
        Ok(())
    }

    /// Stream lifecycle/status events for a specific source to a JS callback.
    #[napi(ts_args_type = "id: string, callback: (event: Record<string, unknown>) => void")]
    pub async fn on_source_events(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let stream = self.inner.drasi.get_source_events(&id).await.map_err(to_napi)?;
        spawn_event_forwarder(stream, callback);
        Ok(())
    }

    /// Stream lifecycle/status events for a specific reaction to a JS callback.
    #[napi(ts_args_type = "id: string, callback: (event: Record<string, unknown>) => void")]
    pub async fn on_reaction_events(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let stream = self
            .inner
            .drasi
            .get_reaction_events(&id)
            .await
            .map_err(to_napi)?;
        spawn_event_forwarder(stream, callback);
        Ok(())
    }

    /// Stream log messages for a specific source (including its plugin's logs).
    #[napi(ts_args_type = "id: string, callback: (log: LogMessage) => void")]
    pub async fn on_source_logs(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let (history, rx) = self
            .inner
            .drasi
            .subscribe_source_logs(&id)
            .await
            .map_err(to_napi)?;
        spawn_log_forwarder(history, rx, callback);
        Ok(())
    }

    /// Stream log messages for a specific query.
    #[napi(ts_args_type = "id: string, callback: (log: LogMessage) => void")]
    pub async fn on_query_logs(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let (history, rx) = self
            .inner
            .drasi
            .subscribe_query_logs(&id)
            .await
            .map_err(to_napi)?;
        spawn_log_forwarder(history, rx, callback);
        Ok(())
    }

    /// Stream log messages for a specific reaction.
    #[napi(ts_args_type = "id: string, callback: (log: LogMessage) => void")]
    pub async fn on_reaction_logs(&self, id: String, callback: JsResultFn) -> napi::Result<()> {
        let (history, rx) = self
            .inner
            .drasi
            .subscribe_reaction_logs(&id)
            .await
            .map_err(to_napi)?;
        spawn_log_forwarder(history, rx, callback);
        Ok(())
    }

    /// Start the engine (begins running all auto-start components).
    #[napi]
    pub async fn start(&self) -> napi::Result<()> {
        self.inner.drasi.start().await.map_err(to_napi)
    }

    /// Stop the engine. No-op if the engine is not running.
    #[napi]
    pub async fn stop(&self) -> napi::Result<()> {
        if self.inner.drasi.is_running().await {
            self.inner.drasi.stop().await.map_err(to_napi)?;
        }
        Ok(())
    }

    /// Stop the engine and release host resources (plugin watchers, JS source
    /// channels, and the config-resolver thread). After `close()`, the instance
    /// should not be used further.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        if self.inner.drasi.is_running().await {
            let _ = self.inner.drasi.stop().await;
        }
        self.inner.watchers.lock().unwrap().clear();
        self.inner.js_source_senders.lock().unwrap().clear();
        // Terminate the resolver thread now (deterministic reclaim). `Drop`
        // repeats this for the GC path; both calls are idempotent.
        self.inner.shutdown_config_resolver();
        Ok(())
    }
}

fn statuses_to_json(items: Vec<(String, drasi_lib::ComponentStatus)>) -> Value {
    Value::Array(
        items
            .into_iter()
            .map(|(id, status)| serde_json::json!({ "id": id, "status": format!("{status:?}") }))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Synchronous validation helpers (raise typed `err.code` before async work)
// ---------------------------------------------------------------------------

/// Validate the optional `stateStore` option synchronously, returning the redb
/// path if configured. Raises a typed error for an unknown kind or missing path.
fn parse_state_store(env: &Env, options: Option<&Value>) -> napi::Result<Option<String>> {
    let Some(ss) = options.and_then(|o| o.get("stateStore")) else {
        return Ok(None);
    };
    let kind = ss.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "redb" => {
            let path = ss.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
                throw_coded(
                    env,
                    DrasiErrorCode::StateStorePathRequired,
                    "stateStore.path is required for redb",
                )
            })?;
            Ok(Some(path.to_string()))
        }
        other => Err(throw_coded(
            env,
            DrasiErrorCode::UnknownStateStoreKind,
            format!("unknown stateStore kind '{other}'"),
        )),
    }
}

/// Configuration for a persistent RocksDB query-index backend (audit gap G6).
struct RocksIndexConfig {
    path: String,
    enable_archive: bool,
    direct_io: bool,
}

/// Validate the optional `indexStore` option synchronously (audit gap G6),
/// returning the RocksDB index config if configured. Unlike `stateStore` (which
/// persists plugin runtime state via redb), `indexStore` persists the continuous-
/// query indexes (element/result indexes, future queue) so query state — and the
/// reaction outbox that durable reactions replay — survives restarts. Raises a
/// typed error for an unknown kind or a missing path.
fn parse_index_store(env: &Env, options: Option<&Value>) -> napi::Result<Option<RocksIndexConfig>> {
    let Some(is) = options.and_then(|o| o.get("indexStore")) else {
        return Ok(None);
    };
    let kind = is.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "rocksdb" => {
            let path = is.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
                throw_coded(
                    env,
                    DrasiErrorCode::IndexStorePathRequired,
                    "indexStore.path is required for rocksdb",
                )
            })?;
            Ok(Some(RocksIndexConfig {
                path: path.to_string(),
                enable_archive: is
                    .get("enableArchive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                direct_io: is.get("directIo").and_then(|v| v.as_bool()).unwrap_or(false),
            }))
        }
        other => Err(throw_coded(
            env,
            DrasiErrorCode::UnknownIndexStoreKind,
            format!("unknown indexStore kind '{other}'"),
        )),
    }
}

/// A built-in identity provider configuration (audit gap G8). Credentials are
/// injected into sources/reactions that connect to external systems.
enum IdentityConfig {
    Password { username: String, password: String },
    Token { username: String, token: String },
}

/// Construct the drasi-lib identity provider for a parsed [`IdentityConfig`].
/// `Password` uses the built-in [`PasswordIdentityProvider`]; `Token` wraps a
/// static [`Credentials::Token`] in an [`ApplicationIdentityProvider`].
fn build_identity_provider(config: IdentityConfig) -> Arc<dyn IdentityProvider> {
    match config {
        IdentityConfig::Password { username, password } => {
            Arc::new(PasswordIdentityProvider::new(username, password))
        }
        IdentityConfig::Token { username, token } => {
            Arc::new(ApplicationIdentityProvider::new_sync(move |_ctx| {
                Ok(Credentials::Token {
                    username: username.clone(),
                    token: token.clone(),
                })
            }))
        }
    }
}

/// Validate the optional `identity` option synchronously (audit gap G8),
/// returning the built-in identity provider config if present. Raises a typed
/// error for a missing/unknown kind or missing required credentials.
fn parse_identity(env: &Env, options: Option<&Value>) -> napi::Result<Option<IdentityConfig>> {
    let Some(id) = options.and_then(|o| o.get("identity")) else {
        return Ok(None);
    };
    let kind = id.get("kind").and_then(|v| v.as_str()).ok_or_else(|| {
        throw_coded(env, DrasiErrorCode::IdentityKindRequired, "identity.kind is required")
    })?;
    let field = |name: &str| id.get(name).and_then(|v| v.as_str()).map(String::from);
    let require = |env: &Env, name: &str| -> napi::Result<String> {
        field(name).ok_or_else(|| {
            throw_coded(
                env,
                DrasiErrorCode::IdentityConfigInvalid,
                format!("identity.{name} is required for kind '{kind}'"),
            )
        })
    };
    match kind {
        "password" => Ok(Some(IdentityConfig::Password {
            username: require(env, "username")?,
            password: require(env, "password")?,
        })),
        "token" => Ok(Some(IdentityConfig::Token {
            username: field("username").unwrap_or_default(),
            token: require(env, "token")?,
        })),
        other => Err(throw_coded(
            env,
            DrasiErrorCode::UnknownIdentityKind,
            format!("unknown identity kind '{other}' (expected 'password' or 'token')"),
        )),
    }
}

/// Fail fast with a typed error if `kind` is not a registered source kind.
fn validate_source_kind(env: &Env, inner: &Inner, kind: &str) -> napi::Result<()> {
    if inner.sources.lock().unwrap().contains_key(kind) {
        Ok(())
    } else {
        Err(throw_coded(
            env,
            DrasiErrorCode::UnknownSourceKind,
            format!("unknown source kind '{kind}'"),
        ))
    }
}

/// Fail fast with a typed error if `kind` is not a registered reaction kind.
fn validate_reaction_kind(env: &Env, inner: &Inner, kind: &str) -> napi::Result<()> {
    if inner.reactions.lock().unwrap().contains_key(kind) {
        Ok(())
    } else {
        Err(throw_coded(
            env,
            DrasiErrorCode::UnknownReactionKind,
            format!("unknown reaction kind '{kind}'"),
        ))
    }
}

/// Fail fast with a typed error if a provided `bootstrap` is missing its `kind`
/// or names an unregistered bootstrap kind.
fn validate_bootstrap(env: &Env, inner: &Inner, bootstrap: Option<&Value>) -> napi::Result<()> {
    let Some(bs) = bootstrap else {
        return Ok(());
    };
    let bs_kind = bs.get("kind").and_then(|v| v.as_str()).ok_or_else(|| {
        throw_coded(
            env,
            DrasiErrorCode::BootstrapKindRequired,
            "bootstrap.kind is required",
        )
    })?;
    if inner.bootstrap.lock().unwrap().contains_key(bs_kind) {
        Ok(())
    } else {
        Err(throw_coded(
            env,
            DrasiErrorCode::UnknownBootstrapKind,
            format!("unknown bootstrap kind '{bs_kind}'"),
        ))
    }
}

// ---------------------------------------------------------------------------
// Async engine helpers (shared by the `#[napi]` wrappers and `fromConfig`)
// ---------------------------------------------------------------------------

/// Optional persistence/identity providers wired into a new engine, parsed
/// synchronously from `create`/`fromConfig` options so validation errors carry a
/// typed `err.code`.
#[derive(Default)]
struct EngineParams {
    /// redb state-store path (plugin runtime state) — audit gap none/existing.
    state_path: Option<String>,
    /// RocksDB persistent query-index backend — audit gap G6.
    index_store: Option<RocksIndexConfig>,
    /// Identity provider for credential injection — audit gap G8.
    identity: Option<IdentityConfig>,
}

/// Build and wrap a `DrasiLib` engine instance.
///
/// The config-resolver and callback contexts are built lazily on first plugin
/// load (see `Inner::ensure_plugin_contexts`), so instances that never load
/// cdylib plugins spawn no resolver thread and leak nothing.
async fn build_engine(
    id: String,
    provider: Arc<dyn SecretStoreProvider>,
    params: EngineParams,
) -> napi::Result<Drasi> {
    let mut builder = DrasiLib::builder()
        .with_id(id.clone())
        .with_secret_store_provider(provider.clone());
    let has_durable_state_store = params.state_path.is_some();
    if let Some(path) = params.state_path {
        let p = drasi_state_store_redb::RedbStateStoreProvider::new(&path).map_err(to_napi)?;
        builder = builder.with_state_store_provider(Arc::new(p));
    }
    // Persistent RocksDB query indexes: make it the default backend so every
    // query persists its element/result indexes and reaction outbox (gap G6).
    if let Some(idx) = params.index_store {
        let provider =
            drasi_index_rocksdb::RocksDbIndexProvider::new(idx.path, idx.enable_archive, idx.direct_io);
        builder = builder.with_default_index_provider("rocksdb", Arc::new(provider));
    }
    // Identity provider for credential injection into sources/reactions (gap G8).
    if let Some(identity) = params.identity {
        builder = builder.with_identity_provider(build_identity_provider(identity));
    }
    let core = builder.build().await.map_err(to_napi)?;
    let active_secret_provider = Arc::new(RwLock::new(provider));
    Ok(Drasi {
        inner: Arc::new(Inner {
            drasi: Arc::new(core),
            sources: Mutex::new(HashMap::new()),
            reactions: Mutex::new(HashMap::new()),
            bootstrap: Mutex::new(HashMap::new()),
            secret_stores: Mutex::new(HashMap::new()),
            identity_providers: Mutex::new(HashMap::new()),
            js_source_senders: Mutex::new(HashMap::new()),
            watchers: Mutex::new(Vec::new()),
            plugin_files: Mutex::new(HashMap::new()),
            active_secret_provider,
            instance_id: id,
            has_durable_state_store,
            resolver_ctx: OnceLock::new(),
            callback_ctx: OnceLock::new(),
        }),
    })
}

/// Create and register a source of the given `kind`, optionally attaching a
/// bootstrap provider. Kind/bootstrap validation is expected to have run
/// synchronously already (see [`validate_source_kind`] / [`validate_bootstrap`]);
/// any lookup failure here surfaces as a generic engine error.
async fn add_source_full(
    inner: Arc<Inner>,
    kind: String,
    id: String,
    config: Value,
    auto_start: bool,
    bootstrap: Option<Value>,
) -> napi::Result<()> {
    let descriptor = { inner.sources.lock().unwrap().get(&kind).cloned() }
        .ok_or_else(|| coded_message(DrasiErrorCode::UnknownSourceKind, format!("unknown source kind '{kind}'")))?;

    let source = descriptor
        .create_source(&id, &config, auto_start)
        .await
        .map_err(|e| coded_message(DrasiErrorCode::ConfigInvalid, e.to_string()))?;

    if let Some(bs) = bootstrap {
        let bs_kind = bs
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| coded_message(DrasiErrorCode::BootstrapKindRequired, "bootstrap.kind is required"))?
            .to_string();
        let bs_config = bs
            .get("config")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let bs_descriptor = { inner.bootstrap.lock().unwrap().get(&bs_kind).cloned() }
            .ok_or_else(|| coded_message(DrasiErrorCode::UnknownBootstrapKind, format!("unknown bootstrap kind '{bs_kind}'")))?;
        let provider = bs_descriptor
            .create_bootstrap_provider(&bs_config, &config)
            .await
            .map_err(|e| coded_message(DrasiErrorCode::ConfigInvalid, e.to_string()))?;
        source.set_bootstrap_provider(provider).await;
    }

    let mut meta = HashMap::new();
    meta.insert("kind".to_string(), kind);
    inner
        .drasi
        .add_source_with_metadata(source, meta)
        .await
        .map_err(to_napi)
}

/// Create and register a reaction of the given `kind`. Kind validation is
/// expected to have run synchronously already (see [`validate_reaction_kind`]).
async fn add_reaction_full(
    inner: Arc<Inner>,
    kind: String,
    id: String,
    query_ids: Vec<String>,
    config: Value,
) -> napi::Result<()> {
    let descriptor = { inner.reactions.lock().unwrap().get(&kind).cloned() }
        .ok_or_else(|| coded_message(DrasiErrorCode::UnknownReactionKind, format!("unknown reaction kind '{kind}'")))?;

    let reaction = descriptor
        .create_reaction(&id, query_ids, &config, true)
        .await
        .map_err(|e| coded_message(DrasiErrorCode::ConfigInvalid, e.to_string()))?;

    let mut meta = HashMap::new();
    meta.insert("kind".to_string(), kind);
    inner
        .drasi
        .add_reaction_with_metadata(reaction, meta)
        .await
        .map_err(to_napi)
}

/// Parse the optional `joins` JSON (`[{ id, keys: [{ label, property }] }]`) into the
/// drasi-lib `QueryJoinConfig` list consumed by `Query::with_joins`.
fn parse_joins(joins: Value) -> napi::Result<Vec<drasi_lib::config::QueryJoinConfig>> {
    serde_json::from_value(joins).map_err(to_napi)
}

/// A parsed query source subscription: a source id plus an (possibly empty)
/// ordered middleware pipeline (a list of middleware `name`s).
#[derive(Debug, PartialEq, Eq)]
struct ParsedSource {
    id: String,
    pipeline: Vec<String>,
}

/// The parsed + cross-validated `sources` and `middleware` query arguments shared
/// by `addQuery` / `updateQuery` / `fromConfig`.
#[derive(Debug)]
struct ParsedQueryParts {
    sources: Vec<ParsedSource>,
    middleware: Vec<SourceMiddlewareConfig>,
}

/// Extract a query's `sources` value from a declarative `fromConfig` entry into
/// the `Vec<Value>` [`parse_query_sources`] expects. An absent or `null` value
/// means "no sources"; a present-but-non-array value is a typed
/// `QUERY_SOURCE_INVALID` error rather than a silent empty list. (The
/// `addQuery`/`updateQuery` paths receive `Vec<Value>` directly, so napi already
/// rejects a non-array there at the FFI boundary.)
fn query_sources_from_config(value: Option<&Value>) -> Result<Vec<Value>, CodedReason> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(_) => Err(CodedReason::new(
            DrasiErrorCode::QuerySourceInvalid,
            "query 'sources' must be an array of source-id strings or { id, pipeline? } objects",
        )),
    }
}

/// Parse the query `sources` argument: an array whose entries are each either a
/// bare source-id `string` (no pipeline) or an object `{ id, pipeline? }`, where
/// `pipeline` is an ordered array of middleware-name strings.
fn parse_query_sources(sources: Vec<Value>) -> Result<Vec<ParsedSource>, CodedReason> {
    let invalid = |msg: &str| CodedReason::new(DrasiErrorCode::QuerySourceInvalid, msg.to_string());
    let mut out = Vec::with_capacity(sources.len());
    for entry in sources {
        match entry {
            Value::String(id) => out.push(ParsedSource {
                id,
                pipeline: Vec::new(),
            }),
            Value::Object(map) => {
                let id = map
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| invalid("query source object is missing a string 'id'"))?
                    .to_string();
                let pipeline = match map.get("pipeline") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|item| {
                            item.as_str().map(String::from).ok_or_else(|| {
                                invalid(
                                    "query source 'pipeline' must be an array of middleware-name strings",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    Some(_) => {
                        return Err(invalid(
                            "query source 'pipeline' must be an array of middleware-name strings",
                        ))
                    }
                };
                out.push(ParsedSource { id, pipeline });
            }
            _ => {
                return Err(invalid(
                    "each query source must be a source-id string or a { id, pipeline? } object",
                ))
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Plugin resolution helpers (shared by pullPlugin / resolvePlugin /
// installPlugin).
// ---------------------------------------------------------------------------

/// The Drasi crate versions this addon was built against, plus the build target
/// triple. The plugin resolver uses these to select a compatible plugin
/// artifact. Values are captured at build time (see `build.rs`).
fn host_version_info() -> drasi_host_sdk::registry::HostVersionInfo {
    drasi_host_sdk::registry::HostVersionInfo {
        sdk_version: env!("DRASI_SDK_VERSION").to_string(),
        core_version: env!("DRASI_CORE_VERSION").to_string(),
        lib_version: env!("DRASI_LIB_VERSION").to_string(),
        target_triple: env!("DRASI_TARGET_TRIPLE").to_string(),
    }
}

/// Resolve a (possibly tag-less) plugin `reference` to the specific,
/// version-compatible artifact for this host and platform.
async fn resolve_for_host(
    reference: &str,
) -> napi::Result<drasi_host_sdk::registry::ResolvedPlugin> {
    use drasi_host_sdk::registry::{OciRegistryClient, PluginResolver, RegistryConfig};
    let config = RegistryConfig::default();
    let default_registry = config.default_registry.clone();
    let client = OciRegistryClient::new(config);
    let host_info = host_version_info();
    let resolver = PluginResolver::new(&client, &host_info);
    resolver
        .resolve(reference, &default_registry)
        .await
        .map_err(to_napi)
}

/// Shape a resolved plugin as the camelCase `ResolvedPlugin` TS object.
fn resolved_plugin_to_json(p: &drasi_host_sdk::registry::ResolvedPlugin) -> Value {
    serde_json::json!({
        "reference": p.reference,
        "version": p.version,
        "sdkVersion": p.sdk_version,
        "coreVersion": p.core_version,
        "libVersion": p.lib_version,
        "platform": p.platform,
        "digest": p.digest,
        "filename": p.filename,
    })
}

/// Download `reference` into `dest_dir` as `filename`, applying the same opt-in
/// cosign verification policy as `pullPlugin`. Returns `(path, verificationJson)`.
///
/// `options` is the parsed `PullPluginOptions` object (`verify`, `requireSigned`,
/// `trustedIdentities`). When verification is enabled, a tampered / untrusted
/// (or, with `requireSigned`, unsigned) artifact is deleted and rejected with a
/// typed `PLUGIN_SIGNATURE_INVALID` error.
async fn download_and_verify(
    reference: &str,
    dest_dir: &str,
    filename: &str,
    options: Option<&Value>,
) -> napi::Result<(String, Value)> {
    use drasi_host_sdk::registry::{
        CosignVerifier, OciRegistryClient, RegistryConfig, TrustedIdentity, VerificationConfig,
    };

    // Parse opt-in verification options. `requireSigned` implies verification.
    let require_signed = options
        .and_then(|o| o.get("requireSigned"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let verify = require_signed
        || options
            .and_then(|o| o.get("verify"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    let trusted_identities: Vec<TrustedIdentity> = options
        .and_then(|o| o.get("trustedIdentities"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let issuer = t.get("issuer").and_then(|v| v.as_str())?;
                    let subject = t.get("subjectPattern").and_then(|v| v.as_str())?;
                    Some(TrustedIdentity {
                        issuer: issuer.to_string(),
                        subject_pattern: subject.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let config = VerificationConfig {
        enabled: verify,
        trusted_identities,
    };
    // The effective allowlist (falls back to the drasi-project identity when the
    // caller configures none) — enforced by the binding since the SDK's
    // `Verified` status does not itself check the signer against any allowlist.
    let effective_identities = config.effective_identities();
    let verifier = CosignVerifier::new(config);
    let client = OciRegistryClient::with_verifier(RegistryConfig::default(), verifier);
    let result = client
        .download_plugin(reference, std::path::Path::new(dest_dir), filename)
        .await
        .map_err(to_napi)?;

    // Enforce the verification policy when verification is enabled: a tampered,
    // untrusted-signer (or, with requireSigned, unsigned) artifact is deleted
    // and rejected.
    if verify {
        if let Err(reason) =
            verification_decision(&result.verification, require_signed, &effective_identities)
        {
            // Best-effort removal of the rejected artifact; if it fails, tell the
            // caller so they don't assume a rejected file was cleaned up.
            let reason = match tokio::fs::remove_file(&result.path).await {
                Ok(()) => reason,
                Err(e) => format!(
                    "{reason} (warning: failed to remove the downloaded artifact at {}: {e})",
                    result.path.display()
                ),
            };
            return Err(coded_message(DrasiErrorCode::PluginSignatureInvalid, reason));
        }
    }

    Ok((
        result.path.to_string_lossy().to_string(),
        verification_to_json(&result.verification),
    ))
}

/// Parse the optional query `middleware` argument: an array of
/// `{ kind, name, config? }` definitions. An omitted `config` defaults to `{}`.
fn parse_query_middleware(
    middleware: Option<Value>,
) -> Result<Vec<SourceMiddlewareConfig>, CodedReason> {
    let invalid = |msg: String| CodedReason::new(DrasiErrorCode::MiddlewareInvalid, msg);
    let value = match middleware {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(v) => v,
    };
    let entries = value.as_array().ok_or_else(|| {
        invalid("query 'middleware' must be an array of { kind, name, config? } objects".into())
    })?;
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let obj = entry
            .as_object()
            .ok_or_else(|| invalid("each query middleware must be a { kind, name, config? } object".into()))?;
        let kind = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("query middleware is missing a string 'kind'".into()))?;
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("query middleware is missing a string 'name'".into()))?;
        let config = match obj.get("config") {
            None | Some(Value::Null) => serde_json::Map::new(),
            Some(Value::Object(m)) => m.clone(),
            Some(_) => {
                return Err(invalid(format!(
                    "query middleware '{name}' 'config' must be an object"
                )))
            }
        };
        out.push(SourceMiddlewareConfig::new(kind, name, config));
    }
    Ok(out)
}

/// Ensure every middleware name referenced by a source `pipeline` is defined in
/// the query's `middleware` list (middleware is query-scoped in drasi-lib).
fn validate_pipeline_refs(
    sources: &[ParsedSource],
    middleware: &[SourceMiddlewareConfig],
) -> Result<(), CodedReason> {
    for source in sources {
        for name in &source.pipeline {
            if !middleware.iter().any(|m| m.name.as_ref() == name.as_str()) {
                return Err(CodedReason::new(
                    DrasiErrorCode::UnknownMiddlewareRef,
                    format!(
                        "source '{}' pipeline references undefined middleware '{}'",
                        source.id, name
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Parse and cross-validate the `sources` + `middleware` query arguments into the
/// structured parts consumed by [`build_query_def`].
fn parse_query_parts(
    sources: Vec<Value>,
    middleware: Option<Value>,
) -> Result<ParsedQueryParts, CodedReason> {
    let sources = parse_query_sources(sources)?;
    let middleware = parse_query_middleware(middleware)?;
    validate_pipeline_refs(&sources, &middleware)?;
    Ok(ParsedQueryParts {
        sources,
        middleware,
    })
}

/// Build a drasi-lib [`Query`] definition from validated parts. `is_gql` selects
/// the GQL builder (already validated by [`resolve_query_language`]); everything
/// else uses Cypher. Source subscriptions with a non-empty pipeline use
/// `from_source_with_pipeline`; query middleware is registered via
/// `with_middleware`. Shared by `addQuery`/`updateQuery` and `fromConfig`.
fn build_query_def(
    id: String,
    query: String,
    parts: ParsedQueryParts,
    is_gql: bool,
    joins: Option<Value>,
) -> napi::Result<drasi_lib::QueryConfig> {
    let mut builder = if is_gql { Query::gql(id) } else { Query::cypher(id) };
    builder = builder.query(query);
    for source in parts.sources {
        builder = if source.pipeline.is_empty() {
            builder.from_source(source.id)
        } else {
            builder.from_source_with_pipeline(source.id, source.pipeline)
        };
    }
    if let Some(joins) = joins {
        builder = builder.with_joins(parse_joins(joins)?);
    }
    for middleware in parts.middleware {
        builder = builder.with_middleware(middleware);
    }
    Ok(builder.build())
}

/// Scan `dir` for cdylib plugins and register their descriptors into `inner`.
/// Returns `(plugins, sources, reactions, bootstrap, secret_stores,
/// identity_providers)` counts.
///
/// When `verify` is `Some(map)` of `filename -> sha256hex`, only files whose
/// contents hash to the expected value are loaded.
fn load_dir_into(
    inner: &Inner,
    dir: &str,
    verify: Option<&HashMap<String, String>>,
) -> anyhow::Result<(usize, usize, usize, usize, usize, usize)> {
    let file_patterns: Vec<String> = if let Some(expected) = verify {
        // Build an allowlist of exact filenames whose hash matches.
        let mut allow = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(exp) = expected.get(&name) {
                    match drasi_host_sdk::compute_file_hash(&entry.path()) {
                        Ok(h) if &h == exp => allow.push(name),
                        Ok(h) => log::warn!(
                            "plugin '{name}' hash mismatch (expected {exp}, got {h}); skipping"
                        ),
                        Err(e) => log::warn!("could not hash plugin '{name}': {e}; skipping"),
                    }
                }
            }
        }
        allow
    } else {
        PLUGIN_FILE_PATTERNS.iter().map(|s| s.to_string()).collect()
    };

    let config = PluginLoaderConfig {
        plugin_dir: std::path::PathBuf::from(dir),
        file_patterns,
    };
    let loader = PluginLoader::new(config);

    // Build (once) and fetch the leaked contexts plugins need to route logs and
    // resolve config values back through this host instance.
    let (resolver_ctx, callback_ctx) = inner.ensure_plugin_contexts();

    let loaded = loader.load_all(
        callback_ctx as *mut std::ffi::c_void,
        callbacks::default_log_callback_fn(),
        callback_ctx as *mut std::ffi::c_void,
        callbacks::default_lifecycle_callback_fn(),
    )?;

    let (mut plugins, mut sources, mut reactions, mut bootstrap, mut secret_stores, mut identity_providers) =
        (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);

    for mut plugin in loaded {
        plugins += 1;
        let file = plugin.file_path.to_string_lossy().to_string();
        let mut rec = PluginFileKinds::default();
        // Wire the plugin to resolve ConfigValue::Secret / EnvironmentVariable
        // references through the host before any source/reaction is created.
        plugin.inject_config_resolver(
            resolver_ctx as *mut std::ffi::c_void,
            config_resolver_callback(),
        );
        for proxy in std::mem::take(&mut plugin.source_plugins) {
            let kind = proxy.kind().to_string();
            rec.sources.push(kind.clone());
            inner.sources.lock().unwrap().insert(kind, Arc::new(proxy));
            sources += 1;
        }
        for proxy in std::mem::take(&mut plugin.reaction_plugins) {
            let kind = proxy.kind().to_string();
            rec.reactions.push(kind.clone());
            inner.reactions.lock().unwrap().insert(kind, Arc::new(proxy));
            reactions += 1;
        }
        for proxy in std::mem::take(&mut plugin.bootstrap_plugins) {
            let kind = proxy.kind().to_string();
            rec.bootstrap.push(kind.clone());
            inner.bootstrap.lock().unwrap().insert(kind, Arc::new(proxy));
            bootstrap += 1;
        }
        for proxy in std::mem::take(&mut plugin.secret_store_plugins) {
            let kind = proxy.kind().to_string();
            rec.secret_stores.push(kind.clone());
            inner.secret_stores.lock().unwrap().insert(kind, Arc::new(proxy));
            secret_stores += 1;
        }
        for proxy in std::mem::take(&mut plugin.identity_provider_plugins) {
            let kind = proxy.kind().to_string();
            rec.identity_providers.push(kind.clone());
            inner.identity_providers.lock().unwrap().insert(kind, Arc::new(proxy));
            identity_providers += 1;
        }
        inner.plugin_files.lock().unwrap().insert(file, rec);
        // `plugin` (LoadedPlugin) drops here, intentionally leaking the
        // underlying library so the cdylib stays mapped for the process.
    }

    Ok((plugins, sources, reactions, bootstrap, secret_stores, identity_providers))
}

/// Spawn a task that forwards a stream of `ComponentEvent`s to a JS callback.
fn spawn_event_forwarder<S>(stream: S, callback: JsResultFn)
where
    S: tokio_stream::Stream<Item = drasi_lib::ComponentEvent> + Send + 'static,
{
    let cb = Arc::new(callback);
    tokio::spawn(async move {
        use tokio_stream::StreamExt;
        let mut stream = Box::pin(stream);
        while let Some(event) = stream.next().await {
            let value = serde_json::to_value(&event).unwrap_or(Value::Null);
            cb.call(
                value,
                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });
}

/// Forward log history + a live broadcast receiver of `LogMessage`s to JS.
fn spawn_log_forwarder(
    history: Vec<drasi_lib::LogMessage>,
    mut rx: tokio::sync::broadcast::Receiver<drasi_lib::LogMessage>,
    callback: JsResultFn,
) {
    use napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking;
    let cb = Arc::new(callback);
    for msg in history {
        let value = serde_json::to_value(&msg).unwrap_or(Value::Null);
        cb.call(value, NonBlocking);
    }
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    let value = serde_json::to_value(&msg).unwrap_or(Value::Null);
                    cb.call(value, NonBlocking);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_joins_accepts_well_formed_definitions() {
        let joins = parse_joins(json!([
            {
                "id": "HAS_PRICE",
                "keys": [
                    { "label": "stocks", "property": "symbol" },
                    { "label": "stock_prices", "property": "symbol" }
                ]
            }
        ]))
        .expect("well-formed joins should parse");

        assert_eq!(joins.len(), 1);
        assert_eq!(joins[0].id, "HAS_PRICE");
        assert_eq!(joins[0].keys.len(), 2);
        assert_eq!(joins[0].keys[0].label, "stocks");
        assert_eq!(joins[0].keys[0].property, "symbol");
    }

    #[test]
    fn parse_joins_accepts_an_empty_list() {
        let joins = parse_joins(json!([])).expect("empty list is valid");
        assert!(joins.is_empty());
    }

    #[test]
    fn parse_joins_rejects_a_non_array() {
        assert!(parse_joins(json!({ "id": "x" })).is_err());
        assert!(parse_joins(json!("nope")).is_err());
    }

    #[test]
    fn parse_joins_rejects_entries_missing_required_fields() {
        // `keys` is required, so an entry without it must fail.
        assert!(parse_joins(json!([{ "id": "HAS_PRICE" }])).is_err());
        // A key missing `property` must fail.
        assert!(parse_joins(json!([
            { "id": "j", "keys": [{ "label": "a" }] }
        ]))
        .is_err());
    }

    fn vals(v: Value) -> Vec<Value> {
        v.as_array().cloned().unwrap()
    }

    #[test]
    fn parse_query_sources_accepts_strings_objects_and_pipelines() {
        let parsed = parse_query_sources(vals(json!([
            "plain",
            { "id": "with-empty" },
            { "id": "with-pipe", "pipeline": ["a", "b"] }
        ])))
        .expect("well-formed sources should parse");

        assert_eq!(
            parsed,
            vec![
                ParsedSource { id: "plain".into(), pipeline: vec![] },
                ParsedSource { id: "with-empty".into(), pipeline: vec![] },
                ParsedSource {
                    id: "with-pipe".into(),
                    pipeline: vec!["a".into(), "b".into()]
                },
            ]
        );
    }

    #[test]
    fn query_sources_from_config_defaults_and_validates() {
        // Absent or null -> empty (backward compatible).
        assert!(query_sources_from_config(None).unwrap().is_empty());
        assert!(query_sources_from_config(Some(&Value::Null)).unwrap().is_empty());
        // An array passes through unchanged.
        let arr = json!(["a", { "id": "b", "pipeline": ["m"] }]);
        assert_eq!(query_sources_from_config(Some(&arr)).unwrap(), vals(arr.clone()));
        // A present-but-non-array value is a typed error, not a silent empty list.
        for bad in [json!("s"), json!({ "id": "s" }), json!(42)] {
            assert_eq!(
                query_sources_from_config(Some(&bad)).unwrap_err().code,
                DrasiErrorCode::QuerySourceInvalid
            );
        }
    }

    #[test]
    fn parse_query_sources_rejects_bad_shapes() {
        // Entry that is neither a string nor an object.
        let err = parse_query_sources(vals(json!([42]))).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::QuerySourceInvalid);
        // Object missing `id`.
        assert_eq!(
            parse_query_sources(vals(json!([{ "pipeline": ["a"] }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::QuerySourceInvalid
        );
        // `pipeline` not an array of strings.
        assert_eq!(
            parse_query_sources(vals(json!([{ "id": "s", "pipeline": [1] }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::QuerySourceInvalid
        );
        assert_eq!(
            parse_query_sources(vals(json!([{ "id": "s", "pipeline": "a" }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::QuerySourceInvalid
        );
    }

    #[test]
    fn parse_query_middleware_parses_and_defaults_config() {
        let mw = parse_query_middleware(Some(json!([
            { "kind": "promote", "name": "p", "config": { "mappings": [] } },
            { "kind": "unwind", "name": "u" }
        ])))
        .expect("well-formed middleware should parse");

        assert_eq!(mw.len(), 2);
        assert_eq!(mw[0].kind.as_ref(), "promote");
        assert_eq!(mw[0].name.as_ref(), "p");
        assert!(mw[0].config.contains_key("mappings"));
        // Omitted `config` defaults to an empty object.
        assert_eq!(mw[1].name.as_ref(), "u");
        assert!(mw[1].config.is_empty());
    }

    #[test]
    fn parse_query_middleware_treats_none_as_empty() {
        assert!(parse_query_middleware(None).unwrap().is_empty());
        assert!(parse_query_middleware(Some(Value::Null)).unwrap().is_empty());
    }

    #[test]
    fn parse_query_middleware_rejects_bad_shapes() {
        // Not an array.
        assert_eq!(
            parse_query_middleware(Some(json!({ "kind": "promote", "name": "p" })))
                .unwrap_err()
                .code,
            DrasiErrorCode::MiddlewareInvalid
        );
        // Missing `kind`.
        assert_eq!(
            parse_query_middleware(Some(json!([{ "name": "p" }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::MiddlewareInvalid
        );
        // Missing `name`.
        assert_eq!(
            parse_query_middleware(Some(json!([{ "kind": "promote" }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::MiddlewareInvalid
        );
        // `config` not an object.
        assert_eq!(
            parse_query_middleware(Some(json!([{ "kind": "promote", "name": "p", "config": 1 }])))
                .unwrap_err()
                .code,
            DrasiErrorCode::MiddlewareInvalid
        );
    }

    #[test]
    fn validate_pipeline_refs_accepts_defined_and_rejects_unknown() {
        let sources = vec![ParsedSource {
            id: "s".into(),
            pipeline: vec!["p".into()],
        }];
        let defined = vec![SourceMiddlewareConfig::new("promote", "p", serde_json::Map::new())];
        assert!(validate_pipeline_refs(&sources, &defined).is_ok());

        let none: Vec<SourceMiddlewareConfig> = vec![];
        let err = validate_pipeline_refs(&sources, &none).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::UnknownMiddlewareRef);
    }

    #[test]
    fn parse_query_parts_cross_validates_pipeline_refs() {
        // A pipeline referencing an undefined middleware name is rejected up front.
        let err = parse_query_parts(
            vals(json!([{ "id": "s", "pipeline": ["missing"] }])),
            Some(json!([{ "kind": "promote", "name": "present" }])),
        )
        .unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::UnknownMiddlewareRef);
    }

    #[test]
    fn build_query_def_wires_pipelines_and_middleware() {
        let parts = parse_query_parts(
            vals(json!([{ "id": "people", "pipeline": ["promote-user"] }])),
            Some(json!([{
                "kind": "promote",
                "name": "promote-user",
                "config": { "mappings": [{ "path": "$.user.id", "target_name": "id" }] }
            }])),
        )
        .expect("parts parse");

        let def = build_query_def(
            "q".into(),
            "MATCH (p:Person) RETURN p.id AS id".into(),
            parts,
            false,
            None,
        )
        .expect("build succeeds");

        assert_eq!(def.sources.len(), 1);
        assert_eq!(def.sources[0].source_id, "people");
        assert_eq!(def.sources[0].pipeline, vec!["promote-user".to_string()]);
        assert_eq!(def.middleware.len(), 1);
        assert_eq!(def.middleware[0].kind.as_ref(), "promote");
        assert_eq!(def.middleware[0].name.as_ref(), "promote-user");
    }

    #[test]
    fn build_query_def_bare_string_source_has_no_pipeline() {
        let parts = parse_query_parts(vals(json!(["src"])), None).expect("parts parse");
        let def = build_query_def("q".into(), "MATCH (n) RETURN n".into(), parts, false, None)
            .expect("build succeeds");
        assert_eq!(def.sources.len(), 1);
        assert_eq!(def.sources[0].source_id, "src");
        assert!(def.sources[0].pipeline.is_empty());
        assert!(def.middleware.is_empty());
    }
}
