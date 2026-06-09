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
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use drasi_core::models::{Element, SourceChange};
use drasi_lib::bootstrap::{BootstrapContext, BootstrapProvider, BootstrapRequest, BootstrapResult};
use drasi_lib::channels::{BootstrapEvent, BootstrapEventSender, QueryResult, SubscriptionResponse};
use drasi_lib::{
    ComponentStatus, Reaction, ReactionBase, ReactionBaseParams, ReactionRuntimeContext, Source,
    SourceBase, SourceBaseParams, SourceRuntimeContext, SourceSubscriptionSettings,
};

/// A value-only (`(result) => …`), **unref'd** threadsafe callback delivering a
/// structured object to JavaScript. Unref'd (weak) so it does not keep the Node
/// event loop alive on its own — the host application controls process lifetime.
pub type JsResultFn = ThreadsafeFunction<Value, (), Value, napi::Status, false, true>;

// ============================================================================
// JS-defined reaction
// ============================================================================

/// A reaction that forwards every query result to a JavaScript callback.
///
/// The callback receives a structured query result object
/// `{ query_id, sequence, results: [{ type, data, before?, after? }] }`.
pub struct JsReaction {
    base: ReactionBase,
    callback: Arc<JsResultFn>,
}

impl JsReaction {
    pub fn new(id: String, query_ids: Vec<String>, callback: JsResultFn) -> Self {
        let params = ReactionBaseParams::new(id, query_ids);
        Self {
            base: ReactionBase::new(params),
            callback: Arc::new(callback),
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
        m
    }

    fn query_ids(&self) -> Vec<String> {
        self.base.queries.clone()
    }

    fn auto_start(&self) -> bool {
        self.base.get_auto_start()
    }

    async fn initialize(&self, context: ReactionRuntimeContext) {
        self.base.initialize(context).await;
    }

    async fn start(&self) -> Result<()> {
        self.base
            .set_status(ComponentStatus::Running, Some("JS reaction started".into()))
            .await;

        let priority_queue = self.base.priority_queue.clone();
        let callback = self.callback.clone();
        let mut shutdown_rx = self.base.create_shutdown_channel().await;

        let task = tokio::spawn(async move {
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
        });

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
            last_sequence: if count > 0 { Some(count - 1) } else { None },
            sequences_aligned: false,
            source_position: None,
        })
    }
}
