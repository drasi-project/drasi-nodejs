// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Public TypeScript shapes for the generated `index.d.ts`.
//!
//! These `#[napi(object)]` structs exist so that napi-rs emits concrete
//! `export interface` definitions into the generated `index.d.ts`, replacing the
//! bare `any` that every config/result parameter and return used to carry
//! (audit gap G2). They are **type-only**: the runtime methods on [`crate::Drasi`]
//! still marshal `serde_json::Value` under the hood, so this changes only the
//! published TypeScript contract, not behavior. Fields that carry arbitrary JSON
//! use `#[napi(ts_type = ...)]` to emit `unknown` / `Record<string, unknown>`
//! instead of `any`, and payload fields use `#[napi(js_name = ...)]` to preserve
//! the snake_case shape produced by the engine's serde serialization.
//!
//! Because they are referenced only from `ts_args_type` / `ts_return_type`
//! overrides (never as actual Rust parameter/return types), none of these structs
//! is constructed in Rust; napi-rs still emits every `#[napi(object)]` into the
//! `.d.ts`, and its generated field impls keep clippy quiet.

#![allow(dead_code)]

use napi_derive::napi;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Construction inputs
// ---------------------------------------------------------------------------

/// Persistent plugin state-store options.
#[napi(object)]
pub struct StateStoreOptions {
    #[napi(ts_type = "'redb'")]
    pub kind: String,
    pub path: String,
}

/// Persistent RocksDB query-index backend options (audit gap G6).
///
/// Unlike `stateStore` (redb, plugin runtime state), this persists the
/// continuous-query indexes and the reaction outbox, so query state — and a
/// durable reaction's checkpoint/outbox for crash recovery — survives process
/// restarts.
#[napi(object)]
pub struct IndexStoreOptions {
    #[napi(ts_type = "'rocksdb'")]
    pub kind: String,
    pub path: String,
    /// Enable the archive index for point-in-time queries (default false).
    pub enable_archive: Option<bool>,
    /// Use direct I/O (recommended for SSDs; default false).
    pub direct_io: Option<bool>,
}

/// Built-in identity-provider options for credential injection (audit gap G8).
///
/// `kind: 'password'` supplies static username/password credentials; `kind:
/// 'token'` supplies a bearer token (with an optional username). Credentials are
/// injected into sources/reactions that connect to external systems.
#[napi(object)]
pub struct IdentityOptions {
    #[napi(ts_type = "'password' | 'token'")]
    pub kind: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
}

/// Options accepted by `Drasi.create`.
#[napi(object)]
pub struct CreateOptions {
    #[napi(ts_type = "Record<string, string>")]
    pub secrets: Option<Value>,
    pub state_store: Option<StateStoreOptions>,
    pub index_store: Option<IndexStoreOptions>,
    pub identity: Option<IdentityOptions>,
}

/// A declarative source entry in [`DrasiConfig`].
#[napi(object)]
pub struct SourceConfig {
    pub kind: String,
    pub id: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub config: Option<Value>,
    pub auto_start: Option<bool>,
    pub bootstrap: Option<BootstrapConfig>,
}

/// A declarative query entry in [`DrasiConfig`].
#[napi(object)]
pub struct QueryConfig {
    pub id: String,
    pub query: String,
    pub sources: Vec<String>,
    #[napi(ts_type = "'cypher' | 'gql'")]
    pub language: Option<String>,
    pub joins: Option<Vec<QueryJoin>>,
}

/// A declarative reaction entry in [`DrasiConfig`].
#[napi(object)]
pub struct ReactionConfig {
    pub kind: String,
    pub id: String,
    pub queries: Vec<String>,
    #[napi(ts_type = "Record<string, unknown>")]
    pub config: Option<Value>,
}

/// The declarative topology accepted by `Drasi.fromConfig`.
#[napi(object)]
pub struct DrasiConfig {
    pub id: Option<String>,
    #[napi(ts_type = "Record<string, string>")]
    pub secrets: Option<Value>,
    pub state_store: Option<StateStoreOptions>,
    pub index_store: Option<IndexStoreOptions>,
    pub identity: Option<IdentityOptions>,
    pub plugins_dir: Option<String>,
    pub sources: Option<Vec<SourceConfig>>,
    pub queries: Option<Vec<QueryConfig>>,
    pub reactions: Option<Vec<ReactionConfig>>,
}

/// The optional bootstrap provider attached to a source.
#[napi(object)]
pub struct BootstrapConfig {
    pub kind: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub config: Option<Value>,
}

/// Options for a durable JavaScript reaction (`addDurableJsReaction`, audit gap G7).
#[napi(object)]
pub struct DurableReactionOptions {
    /// Recovery policy applied on gap detection: `"skipGap"` (default) resumes
    /// from the latest available sequence; `"strict"` fails if the checkpointed
    /// position is unavailable.
    #[napi(ts_type = "'skipGap' | 'strict'")]
    pub recovery_policy: Option<String>,
}

/// A synthetic join key (`{ label, property }`).
#[napi(object)]
pub struct QueryJoinKey {
    pub label: String,
    pub property: String,
}

/// A synthetic join definition relating elements across sources.
#[napi(object)]
pub struct QueryJoin {
    pub id: String,
    pub keys: Vec<QueryJoinKey>,
}

/// A change pushed into a JavaScript source via `pushChange`.
#[napi(object)]
pub struct SourceChangeInput {
    #[napi(ts_type = "'insert' | 'update' | 'delete'")]
    pub op: String,
    pub id: String,
    pub labels: Option<Vec<String>>,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: Option<Value>,
    pub start_id: Option<String>,
    pub end_id: Option<String>,
    pub effective_from: Option<f64>,
}

// ---------------------------------------------------------------------------
// Plugin discovery returns
// ---------------------------------------------------------------------------

/// Counts returned by `loadPlugins`.
#[napi(object)]
pub struct LoadPluginsResult {
    pub plugins: f64,
    pub sources: f64,
    pub reactions: f64,
    pub bootstrap: f64,
}

/// The registered plugin kinds returned by `pluginKinds`.
#[napi(object)]
pub struct PluginKinds {
    pub sources: Vec<String>,
    pub reactions: Vec<String>,
    pub bootstrap: Vec<String>,
}

/// A plugin kind's declared config schema (audit gap G9), returned by
/// `sourceConfigSchema` / `reactionConfigSchema` / `bootstrapConfigSchema`.
///
/// `name` is the root config DTO key within `schema`, a `Record` of OpenAPI
/// (utoipa) schema definitions keyed by schema name. Config is still marshaled as
/// opaque JSON at runtime; this exposes the declared shape so callers can validate
/// config (e.g. with a JSON-schema validator) before adding a component.
#[napi(object)]
pub struct PluginConfigSchema {
    pub name: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub schema: Value,
}

/// Cosign verification outcome returned by `pullPlugin` (audit gap G5).
///
/// A tagged union on `status`:
/// - `"unsigned"` — no signature was found (or verification was not requested).
/// - `"verified"` — a valid signature chaining to the Sigstore root; `issuer`
///   and `subject` identify the signer.
/// - `"tampered"` — a signature exists but failed verification; `reason` explains
///   why. When verification is enforced the artifact is deleted and the pull rejects.
#[napi(object)]
pub struct PullPluginVerification {
    #[napi(ts_type = "'unsigned' | 'verified' | 'tampered'")]
    pub status: String,
    pub issuer: Option<String>,
    pub subject: Option<String>,
    pub reason: Option<String>,
}

/// The result of `pullPlugin`.
#[napi(object)]
pub struct PullPluginResult {
    pub path: String,
    pub verification: PullPluginVerification,
}

/// Options for `pullPlugin` cosign signature enforcement (audit gap G5).
///
/// Verification is opt-in: with no options (or `verify: false`) the artifact is
/// downloaded as before and `verification.status` is `"unsigned"`. When enabled,
/// a `"tampered"` artifact is always rejected (and its file removed); an
/// `"unsigned"` artifact is rejected only when `requireSigned` is set.
#[napi(object)]
pub struct PullPluginOptions {
    /// Enable cosign signature verification (records status; rejects tampered).
    pub verify: Option<bool>,
    /// Require a valid signature — reject unsigned artifacts. Implies `verify`.
    pub require_signed: Option<bool>,
    /// Trusted signing identities. Defaults to the drasi-project GitHub identity.
    pub trusted_identities: Option<Vec<TrustedIdentityOption>>,
}

/// A trusted cosign signing identity (`{ issuer, subjectPattern }`).
#[napi(object)]
pub struct TrustedIdentityOption {
    /// OIDC issuer URL (matched exactly), e.g. `https://token.actions.githubusercontent.com`.
    pub issuer: String,
    /// Glob pattern matched against the certificate subject, e.g.
    /// `https://github.com/drasi-project/*`.
    pub subject_pattern: String,
}

// ---------------------------------------------------------------------------
// Component status
// ---------------------------------------------------------------------------

/// A `{ id, status }` entry from `listSources` / `listQueries` / `listReactions`.
///
/// `status` is a debug-formatted `ComponentStatus` string (e.g. `"Running"`);
/// the exact variant set is engine-defined and not a stable typed contract yet.
#[napi(object)]
pub struct ComponentStatusEntry {
    pub id: String,
    pub status: String,
}

// ---------------------------------------------------------------------------
// Metrics returns
// ---------------------------------------------------------------------------

/// Output metrics for a query (`getQueryMetrics`).
#[napi(object)]
pub struct QueryMetrics {
    pub outbox_size: f64,
    pub outbox_earliest_seq: f64,
    pub outbox_latest_seq: f64,
    pub result_seq_advances: f64,
    pub live_results_count: f64,
    pub outer_transaction_duration_ns_last: f64,
    pub outer_transaction_duration_ns_max: f64,
    pub snapshot_fetch_count: f64,
}

/// Per-query metrics for a reaction (`getReactionMetrics`, keyed by query id).
#[napi(object)]
pub struct ReactionQueryMetrics {
    pub checkpoint_sequence: f64,
    pub checkpoint_lag: f64,
    pub dedup_skip_count: f64,
    pub gap_detection_count: f64,
    pub recovery_strict_count: f64,
    pub recovery_auto_reset_count: f64,
    pub recovery_auto_skip_gap_count: f64,
    pub fetch_snapshot_count: f64,
    pub fetch_outbox_count: f64,
}

/// Global lifecycle metrics (`getLifecycleMetrics`).
#[napi(object)]
pub struct LifecycleMetrics {
    pub startup_rejection_durable_no_store: f64,
    pub startup_rejection_durable_on_volatile: f64,
    pub startup_rejection_snapshot_skip_gap: f64,
    pub startup_rejection_no_snapshot_auto_reset: f64,
    pub auto_reset_completions: f64,
    pub hash_mismatch_count: f64,
}

// ---------------------------------------------------------------------------
// Callback payloads (delivered as raw serde-serialized JSON; snake_case)
// ---------------------------------------------------------------------------

/// A single result diff inside a [`QueryResultEvent`].
///
/// A tagged union on `type`: `ADD`/`DELETE` carry `data`; `UPDATE` and
/// `aggregation` carry `before`/`after`; `noop` carries nothing.
#[napi(object)]
pub struct ResultDiff {
    #[napi(ts_type = "'ADD' | 'DELETE' | 'UPDATE' | 'aggregation' | 'noop'")]
    pub r#type: String,
    #[napi(ts_type = "unknown")]
    pub data: Option<Value>,
    #[napi(ts_type = "unknown")]
    pub before: Option<Value>,
    #[napi(ts_type = "unknown")]
    pub after: Option<Value>,
    #[napi(js_name = "row_signature")]
    pub row_signature: Option<f64>,
}

/// The structured query result delivered to a JS reaction (`addJsReaction`).
#[napi(object)]
pub struct QueryResultEvent {
    #[napi(js_name = "query_id")]
    pub query_id: String,
    pub sequence: f64,
    pub timestamp: String,
    pub results: Vec<ResultDiff>,
    #[napi(ts_type = "Record<string, unknown>")]
    pub metadata: Value,
}

/// A log message delivered to `onSourceLogs` / `onQueryLogs` / `onReactionLogs`.
#[napi(object)]
pub struct LogMessage {
    pub timestamp: String,
    pub level: String,
    pub message: String,
    #[napi(js_name = "instance_id")]
    pub instance_id: String,
    #[napi(js_name = "component_id")]
    pub component_id: String,
    #[napi(js_name = "component_type")]
    pub component_type: String,
}
