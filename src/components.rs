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
use tokio::sync::{mpsc, Mutex};

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
/// **awaits** before advancing its checkpoint (audit gap G7). If the promise
/// rejects, the failure is logged and that result's checkpoint is not advanced,
/// but processing continues with the next result (the engine loop does not retry
/// in-process — see #21). Durability is crash recovery of not-yet-checkpointed
/// results, not per-event at-least-once. Also unref'd (weak).
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
pub struct JsReaction {
    base: ReactionBase,
    callback: ReactionCallback,
    durable: bool,
    recovery_policy: ReactionRecoveryPolicy,
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
        }
    }

    /// A durable reaction: results are delivered to `callback` (whose promise is
    /// awaited) and a checkpoint is persisted after each success, so a restart
    /// resumes without redelivering already-processed results. Requires a durable
    /// state store on the engine.
    pub fn new_durable(
        id: String,
        query_ids: Vec<String>,
        callback: JsDurableResultFn,
        recovery_policy: ReactionRecoveryPolicy,
    ) -> Self {
        let params = ReactionBaseParams::new(id, query_ids).with_recovery_policy(recovery_policy);
        Self {
            base: ReactionBase::new(params),
            callback: ReactionCallback::Durable(Arc::new(callback)),
            durable: true,
            recovery_policy,
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
                // skipped, then run the engine's checkpoint-aware loop. The handler
                // awaits the JS promise; on success the checkpoint advances to that
                // sequence. On rejection the loop logs and moves on WITHOUT retrying
                // (see the type docs / #21): durability is crash recovery of
                // not-yet-checkpointed results, not per-event at-least-once.
                let checkpoints = self.base.read_all_checkpoints().await.unwrap_or_default();
                let base = self.base.clone_shared();
                let callback = cb.clone();
                tokio::spawn(async move {
                    let result = base
                        .run_standard_loop(shutdown_rx, checkpoints, move |event: Arc<QueryResult>| {
                            let callback = callback.clone();
                            async move {
                                if event.results.is_empty() {
                                    return Ok(());
                                }
                                let value = serde_json::to_value(&*event).unwrap_or(Value::Null);
                                // Await both the call and the returned promise so the
                                // checkpoint only advances once JS has finished
                                // processing this result.
                                let promise = callback.call_async(value).await?;
                                promise.await?;
                                Ok(())
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
