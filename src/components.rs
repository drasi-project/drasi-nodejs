// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! JavaScript-defined Drasi components:
//! - [`JsReaction`] — a reaction whose logic is a JS callback (streams query
//!   results to JavaScript).
//! - [`JsSource`] — a programmatic source that JavaScript pushes changes into.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;
use tokio::sync::{mpsc, watch, Mutex};

use crate::retry::{DurableErrorPolicy, OnError};
use drasi_core::models::{Element, SourceChange};
use drasi_lib::bootstrap::{BootstrapContext, BootstrapProvider, BootstrapRequest, BootstrapResult};
use drasi_lib::channels::{BootstrapEvent, BootstrapEventSender, QueryResult, SubscriptionResponse};
use drasi_lib::recovery::ReactionRecoveryPolicy;
use drasi_lib::{
    ComponentStatus, Reaction, ReactionBase, ReactionBaseParams, ReactionRuntimeContext, Source,
    SourceBase, SourceBaseParams, SourceRuntimeContext, SourceSubscriptionSettings,
};

/// A value-only (`(result) => …`), **unref'd** threadsafe callback delivering a
/// structured object to JavaScript. Unref'd (weak) so it does not keep the Node
/// event loop alive on its own — the host application controls process lifetime.
pub type JsResultFn = ThreadsafeFunction<Value, (), Value, napi::Status, false, true>;

/// A durable-reaction callback: like [`JsResultFn`] but the JS handler returns a
/// `Promise<void>` (`(result) => Promise<void>`) whose resolution the reaction
/// **awaits** before advancing its checkpoint (audit gap G7). How a *rejected*
/// promise is handled is governed by the reaction's [`DurableErrorPolicy`]
/// (`onError`): `retry` (the default) re-invokes the callback with backoff until
/// it resolves — because the reaction loop stays parked on the event until the
/// handler returns, the checkpoint cannot leapfrog a failed sequence, giving
/// true per-event at-least-once; `halt` stops the reaction without advancing the
/// checkpoint; `skip` moves on (drasi-lib's stock behavior). Also unref'd (weak).
pub type JsDurableResultFn = ThreadsafeFunction<Value, Promise<()>, Value, napi::Status, false, true>;

/// The callback backing a [`JsReaction`], selecting fire-and-forget delivery or
/// durable, checkpoint-after-completion delivery.
enum ReactionCallback {
    /// Fire-and-forget: results are dispatched to JS without awaiting (default).
    FireAndForget(Arc<JsResultFn>),
    /// Durable: each result is awaited (the JS handler returns a promise) and the
    /// checkpoint advances only on success.
    Durable(Arc<JsDurableResultFn>),
}

// ============================================================================
// JS-defined reaction
// ============================================================================

/// A reaction that forwards every query result to a JavaScript callback.
///
/// The callback receives a structured query result object
/// `{ query_id, sequence, results: [{ type, data, before?, after? }] }`.
///
/// A reaction may be **durable** (audit gap G7): when constructed with
/// [`JsReaction::new_durable`] it opts into the engine's checkpoint/recovery
/// machinery — it persists a per-query checkpoint after each successfully
/// processed result (awaiting the JS handler's returned promise), dedups already-
/// processed results on restart, and applies a recovery policy for gaps. Durable
/// reactions require a durable state store (redb); a persistent index backend
/// (rocksdb) additionally enables cross-process outbox replay.
///
/// On a callback rejection the reaction applies its [`DurableErrorPolicy`]
/// (`onError`, issue #21): `retry` (default), `halt`, or `skip`.
pub struct JsReaction {
    base: ReactionBase,
    callback: ReactionCallback,
    durable: bool,
    recovery_policy: ReactionRecoveryPolicy,
    error_policy: DurableErrorPolicy,
    /// Broadcast latch that tells the durable handler to stop retrying/parking
    /// so `stop()`/`close()` return promptly. `false` until shutdown.
    cancel_tx: watch::Sender<bool>,
}

impl JsReaction {
    /// A fire-and-forget reaction: results are dispatched to `callback` without
    /// awaiting and without checkpointing (the historical behavior).
    pub fn new(id: String, query_ids: Vec<String>, callback: JsResultFn) -> Self {
        let params = ReactionBaseParams::new(id, query_ids);
        Self {
            base: ReactionBase::new(params),
            callback: ReactionCallback::FireAndForget(Arc::new(callback)),
            durable: false,
            recovery_policy: ReactionRecoveryPolicy::AutoSkipGap,
            error_policy: DurableErrorPolicy::default(),
            cancel_tx: watch::channel(false).0,
        }
    }

    /// A durable reaction: results are delivered to `callback` (whose promise is
    /// awaited) and a checkpoint is persisted after each success, so a restart
    /// resumes without redelivering already-processed results. `error_policy`
    /// governs what happens when the callback rejects (issue #21). Requires a
    /// durable state store on the engine.
    pub fn new_durable(
        id: String,
        query_ids: Vec<String>,
        callback: JsDurableResultFn,
        recovery_policy: ReactionRecoveryPolicy,
        error_policy: DurableErrorPolicy,
    ) -> Self {
        let params = ReactionBaseParams::new(id, query_ids).with_recovery_policy(recovery_policy);
        Self {
            base: ReactionBase::new(params),
            callback: ReactionCallback::Durable(Arc::new(callback)),
            durable: true,
            recovery_policy,
            error_policy,
            cancel_tx: watch::channel(false).0,
        }
    }
}

#[async_trait]
impl Reaction for JsReaction {
    fn id(&self) -> &str {
        &self.base.id
    }

    fn type_name(&self) -> &str {
        "js-callback"
    }

    fn properties(&self) -> HashMap<String, serde_json::Value> {
        let mut m = HashMap::new();
        m.insert("queries".to_string(), serde_json::json!(self.base.queries));
        m.insert("durable".to_string(), serde_json::json!(self.durable));
        m
    }

    fn query_ids(&self) -> Vec<String> {
        self.base.queries.clone()
    }

    fn auto_start(&self) -> bool {
        self.base.get_auto_start()
    }

    fn is_durable(&self) -> bool {
        self.durable
    }

    fn default_recovery_policy(&self) -> ReactionRecoveryPolicy {
        self.recovery_policy
    }

    async fn initialize(&self, context: ReactionRuntimeContext) {
        self.base.initialize(context).await;
    }

    async fn start(&self) -> Result<()> {
        self.base
            .set_status(ComponentStatus::Running, Some("JS reaction started".into()))
            .await;

        let shutdown_rx = self.base.create_shutdown_channel().await;

        let task = match &self.callback {
            ReactionCallback::FireAndForget(cb) => {
                let priority_queue = self.base.priority_queue.clone();
                let callback = cb.clone();
                let mut shutdown_rx = shutdown_rx;
                tokio::spawn(async move {
                    loop {
                        let result_arc = tokio::select! {
                            biased;
                            _ = &mut shutdown_rx => break,
                            r = priority_queue.dequeue() => r,
                        };

                        if result_arc.results.is_empty() {
                            continue;
                        }

                        let value = serde_json::to_value(&*result_arc).unwrap_or(Value::Null);
                        callback.call(value, ThreadsafeFunctionCallMode::NonBlocking);
                    }
                })
            }
            ReactionCallback::Durable(cb) => {
                // Load persisted checkpoints so already-checkpointed results are
                // skipped, then run drasi-lib's stock checkpoint-aware loop. The
                // handler applies the configured error policy (issue #21):
                //   * `retry` (default) re-invokes the JS callback with backoff
                //     until it resolves. Because `run_standard_loop` stays parked
                //     on the event until the handler returns, the checkpoint can
                //     never leapfrog a failed sequence — true per-event
                //     at-least-once, using only stock machinery. A finite
                //     `maxRetries` escalates to halt once exhausted.
                //   * `halt` sets the reaction status to Error and parks until
                //     shutdown, leaving the checkpoint at the last success so a
                //     failed sequence is never buried (head-of-line for the
                //     reaction); recovery on restart follows the recovery policy.
                //   * `skip` returns an error so the loop advances to the next
                //     event without checkpointing (drasi-lib's stock behavior).
                let checkpoints = self.base.read_all_checkpoints().await.unwrap_or_default();
                let base_loop = self.base.clone_shared();
                let base_handler = self.base.clone_shared();
                let callback = cb.clone();
                let policy = self.error_policy;
                let cancel_tx = self.cancel_tx.clone();
                let reaction_id = self.base.id.clone();
                tokio::spawn(async move {
                    let result = base_loop
                        .run_standard_loop(shutdown_rx, checkpoints, move |event: Arc<QueryResult>| {
                            let callback = callback.clone();
                            let cancel_tx = cancel_tx.clone();
                            let base = base_handler.clone_shared();
                            let reaction_id = reaction_id.clone();
                            async move {
                                if event.results.is_empty() {
                                    return Ok(());
                                }
                                let value = serde_json::to_value(&*event).unwrap_or(Value::Null);
                                let query_id = event.query_id.clone();
                                let seq = event.sequence;

                                let mut retries: u64 = 0;
                                loop {
                                    // Await the JS handler, racing cancellation so
                                    // shutdown never blocks on a slow callback.
                                    let mut cancel_rx = cancel_tx.subscribe();
                                    let attempt: Result<()> = tokio::select! {
                                        biased;
                                        _ = cancel_rx.wait_for(|v| *v) => {
                                            return Err(anyhow::anyhow!(
                                                "durable reaction '{reaction_id}' cancelled while processing query={query_id} seq={seq}"
                                            ));
                                        }
                                        r = async {
                                            let promise = callback.call_async(value.clone()).await?;
                                            promise.await?;
                                            Ok::<(), anyhow::Error>(())
                                        } => r,
                                    };

                                    let err = match attempt {
                                        Ok(()) => return Ok(()),
                                        Err(e) => e,
                                    };

                                    match policy.on_error {
                                        OnError::Skip => {
                                            // Stock behavior: leave the checkpoint
                                            // unchanged and proceed to the next event.
                                            return Err(err);
                                        }
                                        OnError::Retry if !policy.retries_exhausted(retries) => {
                                            retries += 1;
                                            let delay = policy.backoff_delay(retries);
                                            log::warn!(
                                                "[{reaction_id}] durable callback rejected for query={query_id} seq={seq}: {err:#}; retry {retries} in {delay:?}"
                                            );
                                            let mut cancel_rx = cancel_tx.subscribe();
                                            tokio::select! {
                                                biased;
                                                _ = cancel_rx.wait_for(|v| *v) => {
                                                    return Err(anyhow::anyhow!(
                                                        "durable reaction '{reaction_id}' cancelled during backoff for query={query_id} seq={seq}"
                                                    ));
                                                }
                                                _ = tokio::time::sleep(delay) => {}
                                            }
                                            continue;
                                        }
                                        // `halt`, or `retry` whose budget is exhausted:
                                        // stop making progress so the failed event is
                                        // never buried by a later checkpoint.
                                        _ => {
                                            let msg = format!(
                                                "durable reaction '{reaction_id}' halted on query={query_id} seq={seq}: {err:#}"
                                            );
                                            log::error!("{msg}");
                                            base.set_status(ComponentStatus::Error, Some(msg)).await;
                                            let mut cancel_rx = cancel_tx.subscribe();
                                            let _ = cancel_rx.wait_for(|v| *v).await;
                                            return Err(err);
                                        }
                                    }
                                }
                            }
                        })
                        .await;
                    if let Err(e) = result {
                        log::error!("js durable reaction loop error: {e}");
                    }
                })
            }
        };

        self.base.set_processing_task(task).await;
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        // Wake any in-flight retry/backoff or halt-park so the loop unwinds and
        // stop_common()'s shutdown signal can break it promptly.
        let _ = self.cancel_tx.send(true);
        self.base.stop_common().await
    }

    async fn status(&self) -> ComponentStatus {
        self.base.get_status().await
    }

    async fn enqueue_query_result(&self, result: QueryResult) -> Result<()> {
        self.base.enqueue_query_result(result).await
    }
}

// ============================================================================
// JS programmatic source
// ============================================================================

/// A programmatic source that JavaScript pushes [`SourceChange`]s into.
///
/// Use [`JsSource::new`] to obtain both the source (to add to DrasiLib) and an
/// `UnboundedSender` the host keeps so JS `pushChange` calls can deliver changes.
/// Shared current-state snapshot of a JS source (element id -> latest element),
/// maintained by the dispatch task and replayed by [`JsSourceBootstrap`].
type ElementState = Arc<Mutex<HashMap<String, Element>>>;

pub struct JsSource {
    base: SourceBase,
    rx: Mutex<Option<mpsc::Receiver<SourceChange>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    auto_start: bool,
    state: ElementState,
}

impl JsSource {
    pub fn new(
        id: String,
        auto_start: bool,
    ) -> Result<(Self, mpsc::Sender<SourceChange>)> {
        let params = SourceBaseParams::new(id).with_auto_start(auto_start);
        let base = SourceBase::new(params)?;
        // Bounded channel applies backpressure to fast JS producers.
        let (tx, rx) = mpsc::channel(1024);
        Ok((
            Self {
                base,
                rx: Mutex::new(Some(rx)),
                task: Mutex::new(None),
                auto_start,
                state: Arc::new(Mutex::new(HashMap::new())),
            },
            tx,
        ))
    }
}

#[async_trait]
impl Source for JsSource {
    fn id(&self) -> &str {
        &self.base.id
    }

    fn type_name(&self) -> &str {
        "js-source"
    }

    fn properties(&self) -> HashMap<String, serde_json::Value> {
        let mut m = HashMap::new();
        m.insert("autoStart".to_string(), serde_json::json!(self.auto_start));
        m
    }

    fn auto_start(&self) -> bool {
        self.auto_start
    }

    async fn start(&self) -> Result<()> {
        self.base
            .set_status(ComponentStatus::Running, Some("JS source started".into()))
            .await;

        // Replay current state to queries that subscribe after data was pushed.
        self.base
            .set_bootstrap_provider(JsSourceBootstrap::new(
                self.base.id.clone(),
                self.state.clone(),
            ))
            .await;

        if let Some(mut rx) = self.rx.lock().await.take() {
            let base = self.base.clone_shared();
            let state = self.state.clone();
            let handle = tokio::spawn(async move {
                while let Some(change) = rx.recv().await {
                    // Maintain the current-state snapshot for bootstrap.
                    {
                        let id = change.get_reference().element_id.to_string();
                        let mut s = state.lock().await;
                        match &change {
                            SourceChange::Insert { element } | SourceChange::Update { element } => {
                                s.insert(id, element.clone());
                            }
                            SourceChange::Delete { .. } => {
                                s.remove(&id);
                            }
                            _ => {}
                        }
                    }
                    if let Err(e) = base.dispatch_source_change(change).await {
                        log::debug!("js-source dispatch error: {e}");
                    }
                }
            });
            *self.task.lock().await = Some(handle);
        }
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
        self.base.stop_common().await
    }

    async fn status(&self) -> ComponentStatus {
        self.base.get_status().await
    }

    async fn subscribe(
        &self,
        settings: SourceSubscriptionSettings,
    ) -> Result<SubscriptionResponse> {
        self.base.subscribe_with_bootstrap(&settings, "JsSource").await
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn initialize(&self, context: SourceRuntimeContext) {
        self.base.initialize(context).await;
    }
}

/// Bootstrap provider that replays a JS source's current-state snapshot as
/// `Insert` events when a query first subscribes.
pub struct JsSourceBootstrap {
    source_id: String,
    state: ElementState,
}

impl JsSourceBootstrap {
    pub fn new(source_id: String, state: ElementState) -> Self {
        Self { source_id, state }
    }
}

#[async_trait]
impl BootstrapProvider for JsSourceBootstrap {
    async fn bootstrap(
        &self,
        request: BootstrapRequest,
        _context: &BootstrapContext,
        event_tx: BootstrapEventSender,
        _settings: Option<&SourceSubscriptionSettings>,
    ) -> Result<BootstrapResult> {
        use std::collections::HashSet;
        let wanted: HashSet<&str> = request
            .node_labels
            .iter()
            .chain(request.relation_labels.iter())
            .map(|s| s.as_str())
            .collect();

        let state = self.state.lock().await;
        let mut count: u64 = 0;
        for element in state.values() {
            let include = wanted.is_empty()
                || element
                    .get_metadata()
                    .labels
                    .iter()
                    .any(|l| wanted.contains(l.as_ref()));
            if !include {
                continue;
            }
            let _ = event_tx
                .send(BootstrapEvent {
                    source_id: self.source_id.clone(),
                    change: SourceChange::Insert {
                        element: element.clone(),
                    },
                    timestamp: chrono::Utc::now(),
                    sequence: count,
                })
                .await;
            count += 1;
        }

        Ok(BootstrapResult {
            event_count: count as usize,
            source_position: None,
        })
    }
}
