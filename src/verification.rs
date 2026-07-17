// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Cosign signature verification policy for OCI `pullPlugin` (audit gap G5).
//!
//! The host SDK verifies signatures **best-effort** and never enforces them —
//! [`OciRegistryClient::download_plugin`] returns a [`SignatureStatus`] but writes
//! the binary regardless. This module turns that status into (a) a stable,
//! structured JSON shape surfaced to JavaScript and (b) an enforcement decision
//! so the binding can reject (and delete) a tampered — or, when signatures are
//! required, an unsigned — artifact.

use drasi_host_sdk::registry::{matches_trusted_identity, SignatureStatus, TrustedIdentity};
use serde_json::{json, Value};

/// Serialize a [`SignatureStatus`] into the stable object surfaced as
/// `PullPluginResult.verification`:
///
/// - `{ status: "unsigned" }`
/// - `{ status: "verified", issuer, subject }`
/// - `{ status: "tampered", reason }`
pub fn verification_to_json(status: &SignatureStatus) -> Value {
    match status {
        SignatureStatus::Unsigned => json!({ "status": "unsigned" }),
        SignatureStatus::Verified(result) => json!({
            "status": "verified",
            "issuer": result.issuer,
            "subject": result.subject,
        }),
        SignatureStatus::Tampered(reason) => json!({
            "status": "tampered",
            "reason": reason,
        }),
    }
}

/// Decide whether a downloaded artifact with the given verification `status`
/// should be **accepted** when verification is enabled.
///
/// Returns `Ok(())` to keep the artifact, or `Err(reason)` (a human-readable
/// rejection reason) when it must be deleted and the pull rejected:
///
/// - `Verified` is accepted **only if** its signer identity is on the `trusted`
///   allowlist. The SDK's `Verified` merely means the signature is cryptographically
///   valid and chains to the Sigstore/Fulcio root — it does **not** check the
///   signer against any allowlist — so the binding must enforce trust here, or a
///   valid signature from *any* identity (e.g. an attacker's own GitHub Actions
///   workflow) would be accepted.
/// - `Unsigned` is rejected only when `require_signed` is set.
/// - `Tampered` is always rejected — a signature exists but did not verify.
///
/// `trusted` must be the **effective** allowlist (never empty — callers use
/// `VerificationConfig::effective_identities()`, which falls back to the
/// drasi-project identity when the caller configures none).
pub fn verification_decision(
    status: &SignatureStatus,
    require_signed: bool,
    trusted: &[TrustedIdentity],
) -> Result<(), String> {
    match status {
        SignatureStatus::Verified(result) => {
            if matches_trusted_identity(result, trusted) {
                Ok(())
            } else {
                Err(format!(
                    "plugin signature is valid but signed by an untrusted identity \
                     (issuer={}, subject={})",
                    result.issuer, result.subject
                ))
            }
        }
        SignatureStatus::Unsigned => {
            if require_signed {
                Err("plugin artifact is unsigned but a valid signature was required".to_string())
            } else {
                Ok(())
            }
        }
        SignatureStatus::Tampered(reason) => Err(format!(
            "plugin signature verification failed: {reason}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drasi_host_sdk::registry::VerificationResult;

    fn drasi_subject() -> String {
        "https://github.com/drasi-project/drasi-core/.github/workflows/x.yml@refs/tags/v1".to_string()
    }

    fn verified() -> SignatureStatus {
        SignatureStatus::Verified(VerificationResult {
            issuer: "https://token.actions.githubusercontent.com".to_string(),
            subject: drasi_subject(),
        })
    }

    /// The default drasi-project trusted identity (mirrors the SDK default used by
    /// `VerificationConfig::effective_identities()` when the caller configures none).
    fn drasi_trusted() -> Vec<TrustedIdentity> {
        vec![TrustedIdentity {
            issuer: "https://token.actions.githubusercontent.com".to_string(),
            subject_pattern: "https://github.com/drasi-project/*".to_string(),
        }]
    }

    #[test]
    fn json_unsigned() {
        let v = verification_to_json(&SignatureStatus::Unsigned);
        assert_eq!(v["status"], "unsigned");
        assert!(v.get("issuer").is_none());
        assert!(v.get("reason").is_none());
    }

    #[test]
    fn json_verified_carries_identity() {
        let v = verification_to_json(&verified());
        assert_eq!(v["status"], "verified");
        assert_eq!(v["issuer"], "https://token.actions.githubusercontent.com");
        assert!(v["subject"].as_str().unwrap().contains("drasi-project"));
    }

    #[test]
    fn json_tampered_carries_reason() {
        let v = verification_to_json(&SignatureStatus::Tampered("bad cert".to_string()));
        assert_eq!(v["status"], "tampered");
        assert_eq!(v["reason"], "bad cert");
    }

    #[test]
    fn verified_trusted_identity_is_accepted() {
        assert!(verification_decision(&verified(), false, &drasi_trusted()).is_ok());
        assert!(verification_decision(&verified(), true, &drasi_trusted()).is_ok());
    }

    #[test]
    fn verified_but_untrusted_identity_is_rejected() {
        // A cryptographically valid signature from an identity NOT on the allowlist
        // (e.g. an attacker's own GitHub Actions workflow) must be rejected.
        let attacker = SignatureStatus::Verified(VerificationResult {
            issuer: "https://token.actions.githubusercontent.com".to_string(),
            subject: "https://github.com/evil-corp/malware/.github/workflows/x.yml@refs/tags/v1"
                .to_string(),
        });
        for require_signed in [false, true] {
            let err = verification_decision(&attacker, require_signed, &drasi_trusted()).unwrap_err();
            assert!(err.contains("untrusted identity"), "reason: {err}");
            assert!(err.contains("evil-corp"), "reason names the signer: {err}");
        }
    }

    #[test]
    fn verified_accepts_a_custom_trusted_identity() {
        let custom = vec![TrustedIdentity {
            issuer: "https://token.actions.githubusercontent.com".to_string(),
            subject_pattern: "https://github.com/drasi-project/drasi-core/*".to_string(),
        }];
        assert!(verification_decision(&verified(), true, &custom).is_ok());
    }

    #[test]
    fn unsigned_accepted_unless_required() {
        assert!(verification_decision(&SignatureStatus::Unsigned, false, &drasi_trusted()).is_ok());
        let err =
            verification_decision(&SignatureStatus::Unsigned, true, &drasi_trusted()).unwrap_err();
        assert!(err.contains("unsigned"), "reason mentions unsigned: {err}");
    }

    #[test]
    fn tampered_is_always_rejected() {
        for require_signed in [false, true] {
            let err = verification_decision(
                &SignatureStatus::Tampered("dsse mismatch".to_string()),
                require_signed,
                &drasi_trusted(),
            )
            .unwrap_err();
            assert!(err.contains("dsse mismatch"), "reason is surfaced: {err}");
        }
    }
}
