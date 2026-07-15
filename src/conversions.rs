// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

//! Conversions between JS/JSON values and Drasi core graph model types.

use std::sync::Arc;

use drasi_core::models::{
    Element, ElementMetadata, ElementPropertyMap, ElementReference, SourceChange,
};
use drasi_lib::sources::convert_json_to_element_value;
use serde_json::Value;

use crate::error::{CodedReason, DrasiErrorCode};

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn labels_from(value: Option<&Value>) -> Arc<[Arc<str>]> {
    let labels: Vec<Arc<str>> = match value {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(Arc::from)
            .collect(),
        Some(Value::String(s)) => vec![Arc::from(s.as_str())],
        _ => Vec::new(),
    };
    Arc::from(labels)
}

fn properties_from(value: Option<&Value>) -> ElementPropertyMap {
    let mut map = ElementPropertyMap::new();
    if let Some(Value::Object(obj)) = value {
        for (k, v) in obj {
            map.insert(k.as_str(), convert_json_to_element_value(v));
        }
    }
    map
}

/// Build a [`SourceChange`] from a JS-provided change object.
///
/// Expected shape:
/// ```json
/// { "op": "insert" | "update" | "delete", "id": "n1", "labels": ["Thing"], "properties": { "x": 1 } }
/// ```
pub fn json_to_source_change(source_id: &str, input: &Value) -> Result<SourceChange, CodedReason> {
    let obj = input.as_object().ok_or_else(|| {
        CodedReason::new(DrasiErrorCode::ChangeNotObject, "change must be an object")
    })?;

    let op = obj
        .get("op")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            CodedReason::new(
                DrasiErrorCode::ChangeOpRequired,
                "change.op is required (insert|update|delete)",
            )
        })?
        .to_ascii_lowercase();

    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CodedReason::new(DrasiErrorCode::ChangeIdRequired, "change.id is required"))?;

    let reference = ElementReference::new(source_id, id);
    let labels = labels_from(obj.get("labels"));
    let metadata = ElementMetadata {
        reference,
        labels,
        effective_from: obj
            .get("effectiveFrom")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(now_millis),
    };

    // A change is a relation (edge) when it carries start/end node ids.
    let start = obj
        .get("startId")
        .or_else(|| obj.get("inId"))
        .and_then(|v| v.as_str());
    let end = obj
        .get("endId")
        .or_else(|| obj.get("outId"))
        .and_then(|v| v.as_str());

    let build_element = |metadata: ElementMetadata| -> Result<Element, CodedReason> {
        let properties = properties_from(obj.get("properties"));
        match (start, end) {
            (Some(s), Some(e)) => Ok(Element::Relation {
                metadata,
                in_node: ElementReference::new(source_id, s),
                out_node: ElementReference::new(source_id, e),
                properties,
            }),
            (None, None) => Ok(Element::Node {
                metadata,
                properties,
            }),
            _ => Err(CodedReason::new(
                DrasiErrorCode::RelationRequiresBothEnds,
                "a relation change requires both startId and endId",
            )),
        }
    };

    match op.as_str() {
        "insert" | "add" => Ok(SourceChange::Insert {
            element: build_element(metadata)?,
        }),
        "update" => Ok(SourceChange::Update {
            element: build_element(metadata)?,
        }),
        "delete" | "remove" => Ok(SourceChange::Delete { metadata }),
        other => Err(CodedReason::new(
            DrasiErrorCode::UnknownChangeOp,
            format!("unknown change.op '{other}' (expected insert|update|delete)"),
        )),
    }
}
