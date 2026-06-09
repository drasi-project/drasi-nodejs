// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
//! Node.js native bindings that embed the Drasi continuous-query engine
//! (`drasi-lib`), dynamically discover and load cdylib plugins via
//! `drasi-host-sdk`, and allow sources and reactions to be defined in
//! JavaScript.

mod components;
mod conversions;
mod engine;
mod error;
mod secrets;

pub use engine::Drasi;
