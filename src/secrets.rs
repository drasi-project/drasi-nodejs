// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Host-side config/secret resolver for cdylib plugins.
//!
//! Plugins resolve `ConfigValue::Secret` / `ConfigValue::EnvironmentVariable`
//! references by serializing the value to JSON and calling back into the host
//! through a `#[repr(C)]` callback. This mirrors `drasi-server`'s factories.rs:
//! a dedicated resolver thread owns the SDK resolvers (env + secret store) so the
//! `extern "C"` callback — which is invoked from a plugin's own runtime — never
//! has to `block_on` the host runtime.

use std::ffi::c_void;
use std::sync::Arc;

use drasi_host_sdk::{ConfigResolverFn, SecretStoreValueResolverAdapter};
use drasi_lib::secret_store::SecretStoreProvider;
use drasi_plugin_sdk::ffi::secret_store::FfiGetSecretResult;
use drasi_plugin_sdk::ffi::FfiStr;
use drasi_plugin_sdk::resolver::{EnvironmentVariableResolver, ValueResolver};
use drasi_plugin_sdk::ConfigValue as SdkConfigValue;

/// Context passed to the host config resolver callback. Holds a channel to a
/// dedicated resolver thread that owns the SDK resolvers.
///
/// The sender is wrapped in `Mutex<Option<..>>` so the owning engine can drop it
/// at shutdown (see [`ConfigResolverContext::shutdown`]) — terminating the
/// resolver thread — while leaving this struct itself intact. That matters
/// because a plugin cdylib stores a raw pointer to this context in a
/// process-global static that outlives the engine and the (never-unloaded)
/// cdylib; the box must therefore stay leaked, but its thread need not.
pub struct ConfigResolverContext {
    resolver_tx: std::sync::Mutex<Option<std::sync::mpsc::SyncSender<ResolveRequest>>>,
}

impl ConfigResolverContext {
    /// Terminate the dedicated resolver thread by dropping its sender. Idempotent.
    ///
    /// The context itself is intentionally NOT freed: a plugin cdylib holds a raw
    /// pointer to it for the life of the process. After shutdown the resolver
    /// callback returns a clean error instead of dereferencing freed memory.
    pub fn shutdown(&self) {
        // Dropping the SyncSender makes the resolver thread's `rx.recv()` return
        // Err, ending its loop.
        let _ = self.resolver_tx.lock().unwrap().take();
    }
}

struct ResolveRequest {
    config_value: SdkConfigValue<String>,
    response_tx: std::sync::mpsc::SyncSender<Result<String, String>>,
}

/// Host-side `extern "C"` callback that plugins invoke (via `DtoMapper`) to
/// resolve `ConfigValue` references (secrets, env vars) back through the host.
pub extern "C" fn host_resolve_config_value(
    ctx: *const c_void,
    config_value_json: FfiStr,
) -> FfiGetSecretResult {
    if ctx.is_null() {
        return FfiGetSecretResult::err("Config resolver context is null".to_string());
    }

    let context = unsafe { &*(ctx as *const ConfigResolverContext) };
    let json_str = unsafe { config_value_json.to_string() };

    let config_value: SdkConfigValue<String> = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => return FfiGetSecretResult::err(format!("Invalid config value JSON: {e}")),
    };

    if let SdkConfigValue::Static(ref s) = config_value {
        return FfiGetSecretResult::ok(s.clone());
    }

    let (response_tx, response_rx) = std::sync::mpsc::sync_channel(1);
    let request = ResolveRequest {
        config_value,
        response_tx,
    };

    // Clone the sender out from under the lock so we never hold it across the
    // blocking round-trip below. A `None` sender means the host has shut the
    // resolver down (see `ConfigResolverContext::shutdown`).
    let sender = match context.resolver_tx.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(tx) => tx.clone(),
            None => return FfiGetSecretResult::err("Config resolver has been shut down".to_string()),
        },
        Err(_) => return FfiGetSecretResult::err("Config resolver lock poisoned".to_string()),
    };

    if sender.send(request).is_err() {
        return FfiGetSecretResult::err("Config resolver thread is no longer running".to_string());
    }

    match response_rx.recv() {
        Ok(Ok(value)) => FfiGetSecretResult::ok(value),
        Ok(Err(e)) => FfiGetSecretResult::err(e),
        Err(_) => {
            FfiGetSecretResult::err("Config resolver thread dropped response channel".to_string())
        }
    }
}

/// The config resolver callback function pointer to inject into plugins.
pub fn config_resolver_callback() -> ConfigResolverFn {
    host_resolve_config_value
}

/// Build a leaked `ConfigResolverContext` pointer for injection into plugins.
///
/// Spawns a dedicated OS thread that resolves `ConfigValue` variants using the
/// SDK's env + secret-store resolvers. The pointer is intentionally leaked
/// (process-lifetime) because plugins store it globally.
pub fn build_config_resolver_context(
    provider: Arc<dyn SecretStoreProvider>,
    runtime_handle: tokio::runtime::Handle,
) -> *mut c_void {
    let (tx, rx) = std::sync::mpsc::sync_channel::<ResolveRequest>(64);

    let env_resolver = EnvironmentVariableResolver;
    let secret_resolver = SecretStoreValueResolverAdapter::new(provider);

    std::thread::Builder::new()
        .name("drasi-config-resolver".to_string())
        .spawn(move || {
            while let Ok(req) = rx.recv() {
                let result = match &req.config_value {
                    SdkConfigValue::EnvironmentVariable { .. } => runtime_handle
                        .block_on(env_resolver.resolve_to_string(&req.config_value))
                        .map_err(|e| e.to_string()),
                    SdkConfigValue::Secret { .. } => runtime_handle
                        .block_on(secret_resolver.resolve_to_string(&req.config_value))
                        .map_err(|e| e.to_string()),
                    SdkConfigValue::Static(s) => Ok(s.clone()),
                };
                let _ = req.response_tx.send(result);
            }
        })
        .expect("Failed to spawn config-resolver thread");

    let ctx = Box::new(ConfigResolverContext {
        resolver_tx: std::sync::Mutex::new(Some(tx)),
    });
    Box::into_raw(ctx) as *mut c_void
}
