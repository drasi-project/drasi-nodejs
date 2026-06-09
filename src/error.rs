// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Error mapping helpers between Drasi/anyhow errors and napi errors.

/// Convert any `Display` error into a napi error.
pub fn to_napi<E: std::fmt::Display>(e: E) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// Convert a `&str`/`String` reason into a napi error.
pub fn reason(msg: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(msg.into())
}
