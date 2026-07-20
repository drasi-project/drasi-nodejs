// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Error-handling policy for durable JS reactions (audit gap G7, issue #21).
//!
//! This module is **pure**: it only parses `DurableReactionOptions` and computes
//! backoff delays. It contains no engine or loop logic — the durable reaction in
//! [`crate::components`] applies these decisions while running on drasi-lib's
//! stock `ReactionBase::run_standard_loop`, keeping this crate a thin wrapper.

use std::time::Duration;

use serde_json::Value;

/// Default exponential-backoff base delay (first retry) in milliseconds.
pub const DEFAULT_BASE_DELAY_MS: u64 = 100;
/// Default exponential-backoff cap in milliseconds.
pub const DEFAULT_MAX_DELAY_MS: u64 = 30_000;

/// What a durable reaction does when its JS callback's promise rejects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnError {
    /// Log the failure and move on to the next event **without** advancing the
    /// checkpoint. This is drasi-lib's stock `run_standard_loop` behavior: a
    /// later success for the same query advances the checkpoint past the failed
    /// sequence, so the failed event can be buried (at-most-once). Opt-in only.
    Skip,
    /// Re-invoke the callback with exponential backoff **until it succeeds**
    /// (default). Because the reaction loop stays parked on the failed event
    /// until the handler returns, the checkpoint cannot leapfrog it — true
    /// per-event at-least-once. If a finite [`DurableErrorPolicy::max_retries`]
    /// is exhausted, the reaction escalates to [`OnError::Halt`].
    Retry,
    /// Stop making progress: leave the checkpoint at the last success so the
    /// failed event (and everything after it) is redelivered on restart
    /// (head-of-line semantics for the whole reaction).
    Halt,
}

impl OnError {
    /// Parse the `onError` option string. Returns `None` for unrecognized values
    /// (callers fall back to the default policy).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skip" => Some(OnError::Skip),
            "retry" => Some(OnError::Retry),
            "halt" => Some(OnError::Halt),
            _ => None,
        }
    }
}

/// A fully-resolved durable-reaction error policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DurableErrorPolicy {
    /// Behavior on callback rejection.
    pub on_error: OnError,
    /// Maximum number of retries before escalating to halt. `None` means retry
    /// forever (only meaningful for [`OnError::Retry`]).
    pub max_retries: Option<u64>,
    /// Base delay for the first retry.
    pub base_delay: Duration,
    /// Upper bound the exponential backoff is capped at.
    pub max_delay: Duration,
}

impl Default for DurableErrorPolicy {
    fn default() -> Self {
        Self {
            on_error: OnError::Retry,
            max_retries: None,
            base_delay: Duration::from_millis(DEFAULT_BASE_DELAY_MS),
            max_delay: Duration::from_millis(DEFAULT_MAX_DELAY_MS),
        }
    }
}

impl DurableErrorPolicy {
    /// Build a policy from the optional `DurableReactionOptions` object passed
    /// from JavaScript. Missing or malformed fields fall back to defaults, so an
    /// omitted `options` yields the default policy (retry forever with backoff).
    pub fn from_options(options: Option<&Value>) -> Self {
        let mut policy = DurableErrorPolicy::default();
        let Some(obj) = options else {
            return policy;
        };

        if let Some(on_error) = obj.get("onError").and_then(|v| v.as_str()) {
            if let Some(parsed) = OnError::parse(on_error) {
                policy.on_error = parsed;
            }
        }

        // `maxRetries` <= 0 means "no retries" (halt on first failure); a missing
        // or non-numeric value keeps the default (unlimited).
        if let Some(v) = obj.get("maxRetries") {
            if let Some(n) = parse_non_negative_u64(v) {
                policy.max_retries = Some(n);
            }
        }

        if let Some(ms) = obj.get("retryDelayMs").and_then(parse_non_negative_u64) {
            policy.base_delay = Duration::from_millis(ms.max(1));
        }

        if let Some(ms) = obj.get("maxRetryDelayMs").and_then(parse_non_negative_u64) {
            policy.max_delay = Duration::from_millis(ms);
        }

        // Keep the cap coherent with the base so backoff is monotonic.
        if policy.max_delay < policy.base_delay {
            policy.max_delay = policy.base_delay;
        }

        policy
    }

    /// Exponential backoff delay for the given 1-based retry attempt, capped at
    /// [`Self::max_delay`]. Attempt 1 returns the base delay, attempt 2 doubles
    /// it, and so on. Saturating math avoids overflow for large attempts.
    pub fn backoff_delay(&self, attempt: u64) -> Duration {
        let base_ms = self.base_delay.as_millis().max(1);
        let max_ms = self.max_delay.as_millis().max(base_ms);
        let shift = attempt.saturating_sub(1).min(127) as u32;
        let factor = 1u128.checked_shl(shift).unwrap_or(u128::MAX);
        let delay_ms = base_ms.saturating_mul(factor).min(max_ms);
        Duration::from_millis(delay_ms as u64)
    }

    /// Whether a `Retry` policy has exhausted its finite retry budget after
    /// `retries_done` attempts. Always `false` when `max_retries` is `None`.
    pub fn retries_exhausted(&self, retries_done: u64) -> bool {
        matches!(self.max_retries, Some(max) if retries_done >= max)
    }
}

/// Parse a JSON value as a non-negative integer, tolerating both integer- and
/// float-encoded numbers (napi marshals JS numbers as f64). Returns `None` for
/// negative, non-finite, or non-numeric values.
fn parse_non_negative_u64(v: &Value) -> Option<u64> {
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= 0.0 {
            return Some(f as u64);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn on_error_parses_known_values() {
        assert_eq!(OnError::parse("skip"), Some(OnError::Skip));
        assert_eq!(OnError::parse("retry"), Some(OnError::Retry));
        assert_eq!(OnError::parse("halt"), Some(OnError::Halt));
        assert_eq!(OnError::parse("nope"), None);
        assert_eq!(OnError::parse(""), None);
    }

    #[test]
    fn default_policy_is_unlimited_retry_with_backoff() {
        let p = DurableErrorPolicy::default();
        assert_eq!(p.on_error, OnError::Retry);
        assert_eq!(p.max_retries, None);
        assert_eq!(p.base_delay, Duration::from_millis(DEFAULT_BASE_DELAY_MS));
        assert_eq!(p.max_delay, Duration::from_millis(DEFAULT_MAX_DELAY_MS));
    }

    #[test]
    fn from_options_none_yields_default() {
        assert_eq!(DurableErrorPolicy::from_options(None), DurableErrorPolicy::default());
    }

    #[test]
    fn from_options_ignores_recovery_policy_and_unknown_keys() {
        // recoveryPolicy is parsed elsewhere; unknown/irrelevant keys are ignored.
        let opts = json!({ "recoveryPolicy": "strict", "somethingElse": 1 });
        assert_eq!(
            DurableErrorPolicy::from_options(Some(&opts)),
            DurableErrorPolicy::default()
        );
    }

    #[test]
    fn from_options_parses_halt() {
        let opts = json!({ "onError": "halt" });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.on_error, OnError::Halt);
    }

    #[test]
    fn from_options_unknown_on_error_falls_back_to_default() {
        let opts = json!({ "onError": "bogus" });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.on_error, OnError::Retry);
    }

    #[test]
    fn from_options_parses_retry_knobs() {
        let opts = json!({
            "onError": "retry",
            "maxRetries": 5,
            "retryDelayMs": 250,
            "maxRetryDelayMs": 5000,
        });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.on_error, OnError::Retry);
        assert_eq!(p.max_retries, Some(5));
        assert_eq!(p.base_delay, Duration::from_millis(250));
        assert_eq!(p.max_delay, Duration::from_millis(5000));
    }

    #[test]
    fn from_options_tolerates_float_encoded_numbers() {
        // napi marshals JS numbers as f64, so integral floats must still parse.
        let opts = json!({ "maxRetries": 3.0, "retryDelayMs": 200.0 });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.max_retries, Some(3));
        assert_eq!(p.base_delay, Duration::from_millis(200));
    }

    #[test]
    fn from_options_max_retries_zero_means_no_retries() {
        let opts = json!({ "onError": "retry", "maxRetries": 0 });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.max_retries, Some(0));
        assert!(p.retries_exhausted(0));
    }

    #[test]
    fn from_options_rejects_negative_numbers() {
        let opts = json!({ "maxRetries": -1, "retryDelayMs": -5 });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        // Negatives are ignored -> defaults retained.
        assert_eq!(p.max_retries, None);
        assert_eq!(p.base_delay, Duration::from_millis(DEFAULT_BASE_DELAY_MS));
    }

    #[test]
    fn from_options_clamps_max_delay_below_base() {
        let opts = json!({ "retryDelayMs": 1000, "maxRetryDelayMs": 100 });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.base_delay, Duration::from_millis(1000));
        // Cap raised to the base so backoff stays monotonic.
        assert_eq!(p.max_delay, Duration::from_millis(1000));
    }

    #[test]
    fn from_options_zero_retry_delay_floors_at_one_ms() {
        let opts = json!({ "retryDelayMs": 0 });
        let p = DurableErrorPolicy::from_options(Some(&opts));
        assert_eq!(p.base_delay, Duration::from_millis(1));
    }

    #[test]
    fn backoff_grows_exponentially_then_caps() {
        let p = DurableErrorPolicy {
            on_error: OnError::Retry,
            max_retries: None,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_millis(30_000),
        };
        assert_eq!(p.backoff_delay(1), Duration::from_millis(100));
        assert_eq!(p.backoff_delay(2), Duration::from_millis(200));
        assert_eq!(p.backoff_delay(3), Duration::from_millis(400));
        assert_eq!(p.backoff_delay(4), Duration::from_millis(800));
        // Eventually saturates at the cap and never exceeds it.
        assert_eq!(p.backoff_delay(20), Duration::from_millis(30_000));
        assert_eq!(p.backoff_delay(u64::MAX), Duration::from_millis(30_000));
    }

    #[test]
    fn backoff_attempt_zero_returns_base() {
        let p = DurableErrorPolicy::default();
        assert_eq!(p.backoff_delay(0), p.base_delay);
    }

    #[test]
    fn retries_exhausted_respects_budget() {
        let unlimited = DurableErrorPolicy::default();
        assert!(!unlimited.retries_exhausted(1_000_000));

        let bounded = DurableErrorPolicy {
            max_retries: Some(3),
            ..DurableErrorPolicy::default()
        };
        assert!(!bounded.retries_exhausted(0));
        assert!(!bounded.retries_exhausted(2));
        assert!(bounded.retries_exhausted(3));
        assert!(bounded.retries_exhausted(4));
    }
}
