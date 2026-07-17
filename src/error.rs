// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Error mapping helpers between Drasi/anyhow errors and napi errors.
//!
//! Two error channels are exposed to JavaScript:
//!
//! * **Typed validation errors** ([`throw_coded`]) carry a stable,
//!   machine-readable [`DrasiErrorCode`] on the thrown `Error`'s `code`
//!   property, so callers can branch on `err.code` instead of string-matching
//!   `err.message` (audit gap G4). Because napi-rs derives the JS `code` from a
//!   status string only on **synchronous** throws (async promise rejections are
//!   forced to napi's `Status` strings), every coded error here is raised
//!   synchronously — as an argument-validation failure — before the method
//!   returns the `Promise` for its async engine work. `throw_coded` builds a JS
//!   `Error` object and sets its `code` property directly, so the code survives
//!   regardless of napi's status mapping.
//! * **Engine errors** ([`to_napi`]) keep napi's default `GenericFailure` code;
//!   they originate deep in the engine and are not part of the typed taxonomy.
//!
//! The human-readable message is identical to what shipped before; only the
//! `code` property is added.

use napi::{Env, JsValue};
use napi_derive::napi;

/// Stable, machine-readable error codes surfaced on `err.code`.
///
/// Built with `#[napi(string_enum)]` and emitted into the generated `index.d.ts`
/// (via `napi build --no-const-enum --runtime-string-enum`) as a **regular
/// ambient `enum`** — never a `const enum`. This is safe under `isolatedModules`
/// (Babel/esbuild/swc/Vite), carries a real runtime value that matches the object
/// napi registers in `index.js`, and lets consumers compare
/// `err.code === DrasiErrorCode.UnknownSourceKind`.
#[napi(string_enum)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrasiErrorCode {
    #[napi(value = "UNKNOWN_SOURCE_KIND")]
    UnknownSourceKind,
    #[napi(value = "UNKNOWN_REACTION_KIND")]
    UnknownReactionKind,
    #[napi(value = "UNKNOWN_BOOTSTRAP_KIND")]
    UnknownBootstrapKind,
    #[napi(value = "BOOTSTRAP_KIND_REQUIRED")]
    BootstrapKindRequired,
    #[napi(value = "MISSING_CONFIG_FIELD")]
    MissingConfigField,
    #[napi(value = "NO_JS_SOURCE")]
    NoJsSource,
    #[napi(value = "JS_SOURCE_CLOSED")]
    JsSourceClosed,
    #[napi(value = "CHANGE_NOT_OBJECT")]
    ChangeNotObject,
    #[napi(value = "CHANGE_OP_REQUIRED")]
    ChangeOpRequired,
    #[napi(value = "CHANGE_ID_REQUIRED")]
    ChangeIdRequired,
    #[napi(value = "RELATION_REQUIRES_BOTH_ENDS")]
    RelationRequiresBothEnds,
    #[napi(value = "UNKNOWN_CHANGE_OP")]
    UnknownChangeOp,
    #[napi(value = "STATE_STORE_PATH_REQUIRED")]
    StateStorePathRequired,
    #[napi(value = "UNKNOWN_STATE_STORE_KIND")]
    UnknownStateStoreKind,
    #[napi(value = "UNKNOWN_QUERY_LANGUAGE")]
    UnknownQueryLanguage,
    #[napi(value = "CONFIG_INVALID")]
    ConfigInvalid,
    #[napi(value = "PLUGIN_SIGNATURE_INVALID")]
    PluginSignatureInvalid,
}

impl DrasiErrorCode {
    /// The stable string code as surfaced on the JS `Error`'s `code` property.
    pub fn as_str(self) -> &'static str {
        match self {
            DrasiErrorCode::UnknownSourceKind => "UNKNOWN_SOURCE_KIND",
            DrasiErrorCode::UnknownReactionKind => "UNKNOWN_REACTION_KIND",
            DrasiErrorCode::UnknownBootstrapKind => "UNKNOWN_BOOTSTRAP_KIND",
            DrasiErrorCode::BootstrapKindRequired => "BOOTSTRAP_KIND_REQUIRED",
            DrasiErrorCode::MissingConfigField => "MISSING_CONFIG_FIELD",
            DrasiErrorCode::NoJsSource => "NO_JS_SOURCE",
            DrasiErrorCode::JsSourceClosed => "JS_SOURCE_CLOSED",
            DrasiErrorCode::ChangeNotObject => "CHANGE_NOT_OBJECT",
            DrasiErrorCode::ChangeOpRequired => "CHANGE_OP_REQUIRED",
            DrasiErrorCode::ChangeIdRequired => "CHANGE_ID_REQUIRED",
            DrasiErrorCode::RelationRequiresBothEnds => "RELATION_REQUIRES_BOTH_ENDS",
            DrasiErrorCode::UnknownChangeOp => "UNKNOWN_CHANGE_OP",
            DrasiErrorCode::StateStorePathRequired => "STATE_STORE_PATH_REQUIRED",
            DrasiErrorCode::UnknownStateStoreKind => "UNKNOWN_STATE_STORE_KIND",
            DrasiErrorCode::UnknownQueryLanguage => "UNKNOWN_QUERY_LANGUAGE",
            DrasiErrorCode::ConfigInvalid => "CONFIG_INVALID",
            DrasiErrorCode::PluginSignatureInvalid => "PLUGIN_SIGNATURE_INVALID",
        }
    }
}

impl AsRef<str> for DrasiErrorCode {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

/// Build a typed validation error as a thrown JS `Error`.
///
/// The `code` becomes the JS `Error.code` (a stable [`DrasiErrorCode`] string);
/// `msg` becomes the unchanged human-readable `Error.message`. Constructing the
/// JS `Error` object here and setting its `code` property means the code is
/// preserved when this error is thrown synchronously, independent of napi's
/// `Status`→`code` mapping. Requires the current [`Env`], so callers must be on
/// the JS thread (all validation runs synchronously before any async work).
///
/// If building the JS object fails (never expected on the JS thread), this
/// degrades gracefully to a plain-reason error with the same message.
pub fn throw_coded(env: &Env, code: DrasiErrorCode, msg: impl Into<String>) -> napi::Error {
    let msg = msg.into();
    match env.create_error(napi::Error::from_reason(msg.clone())) {
        Ok(mut err) => {
            if err.set("code", code.as_str()).is_err() {
                return napi::Error::from_reason(msg);
            }
            napi::Error::from(err.to_unknown())
        }
        Err(_) => napi::Error::from_reason(msg),
    }
}

/// Build a generic (`GenericFailure`) napi error whose **message** embeds the
/// stable code token, for the few async paths where a real `err.code` cannot be
/// attached (napi forces async rejections to a `Status` string). This keeps a
/// single, consistent token consumers can match on even when `.code` is
/// `'GenericFailure'`: `<human message> [CODE]`. Used only on async fallbacks
/// (`fromConfig` component creation and the mid-send `JS_SOURCE_CLOSED` race);
/// the synchronous paths for these same codes carry a real `.code` and an
/// unchanged message.
pub fn coded_message(code: DrasiErrorCode, msg: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(format!("{} [{}]", msg.into(), code.as_str()))
}

/// A machine code + human message pair for a validation failure raised where an
/// [`Env`] is not directly available (e.g. in `conversions`). The caller, which
/// does have an `Env`, turns it into a thrown JS error via [`throw_coded`].
#[derive(Debug, PartialEq, Eq)]
pub struct CodedReason {
    pub code: DrasiErrorCode,
    pub message: String,
}

impl CodedReason {
    pub fn new(code: DrasiErrorCode, msg: impl Into<String>) -> Self {
        Self {
            code,
            message: msg.into(),
        }
    }
}

/// Convert any `Display` error (typically an engine/anyhow error) into a napi
/// error with the default `GenericFailure` code.
pub fn to_napi<E: std::fmt::Display>(e: E) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant round-trips to its documented stable string, and `as_ref`
    /// agrees with `as_str`. If a variant is added without a matching arm this
    /// list makes the omission obvious.
    #[test]
    fn error_codes_have_stable_strings() {
        let cases = [
            (DrasiErrorCode::UnknownSourceKind, "UNKNOWN_SOURCE_KIND"),
            (DrasiErrorCode::UnknownReactionKind, "UNKNOWN_REACTION_KIND"),
            (DrasiErrorCode::UnknownBootstrapKind, "UNKNOWN_BOOTSTRAP_KIND"),
            (DrasiErrorCode::BootstrapKindRequired, "BOOTSTRAP_KIND_REQUIRED"),
            (DrasiErrorCode::MissingConfigField, "MISSING_CONFIG_FIELD"),
            (DrasiErrorCode::NoJsSource, "NO_JS_SOURCE"),
            (DrasiErrorCode::JsSourceClosed, "JS_SOURCE_CLOSED"),
            (DrasiErrorCode::ChangeNotObject, "CHANGE_NOT_OBJECT"),
            (DrasiErrorCode::ChangeOpRequired, "CHANGE_OP_REQUIRED"),
            (DrasiErrorCode::ChangeIdRequired, "CHANGE_ID_REQUIRED"),
            (DrasiErrorCode::RelationRequiresBothEnds, "RELATION_REQUIRES_BOTH_ENDS"),
            (DrasiErrorCode::UnknownChangeOp, "UNKNOWN_CHANGE_OP"),
            (DrasiErrorCode::StateStorePathRequired, "STATE_STORE_PATH_REQUIRED"),
            (DrasiErrorCode::UnknownStateStoreKind, "UNKNOWN_STATE_STORE_KIND"),
            (DrasiErrorCode::UnknownQueryLanguage, "UNKNOWN_QUERY_LANGUAGE"),
            (DrasiErrorCode::ConfigInvalid, "CONFIG_INVALID"),
            (DrasiErrorCode::PluginSignatureInvalid, "PLUGIN_SIGNATURE_INVALID"),
        ];
        for (code, expected) in cases {
            assert_eq!(code.as_str(), expected);
            assert_eq!(code.as_ref(), expected);
        }
    }

    #[test]
    fn coded_message_embeds_the_stable_token_after_the_message() {
        let err = coded_message(DrasiErrorCode::JsSourceClosed, "source is gone");
        let rendered = err.to_string();
        assert!(
            rendered.contains("source is gone"),
            "keeps the human message: {rendered}"
        );
        assert!(
            rendered.contains("[JS_SOURCE_CLOSED]"),
            "embeds the [CODE] token: {rendered}"
        );
    }

    #[test]
    fn coded_reason_carries_code_and_message() {
        let reason = CodedReason::new(DrasiErrorCode::ChangeIdRequired, "change.id is required");
        assert_eq!(reason.code, DrasiErrorCode::ChangeIdRequired);
        assert_eq!(reason.message, "change.id is required");
    }

    #[test]
    fn to_napi_preserves_the_display_message() {
        let err = to_napi("boom");
        assert!(err.to_string().contains("boom"));
    }
}
