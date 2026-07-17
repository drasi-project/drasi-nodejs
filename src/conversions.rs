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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DrasiErrorCode;
    use drasi_core::models::{Element, ElementValue, SourceChange};
    use serde_json::json;

    fn element_of(sc: &SourceChange) -> &Element {
        match sc {
            SourceChange::Insert { element } | SourceChange::Update { element } => element,
            other => panic!("expected an element-bearing change, got {other:?}"),
        }
    }

    fn labels_of(el: &Element) -> Vec<String> {
        el.get_metadata()
            .labels
            .iter()
            .map(|l| l.to_string())
            .collect()
    }

    #[test]
    fn insert_node_marshals_reference_labels_and_properties() {
        let sc = json_to_source_change(
            "src",
            &json!({
                "op": "insert",
                "id": "n1",
                "labels": ["Thing", "Widget"],
                "properties": { "x": 1, "name": "alpha" }
            }),
        )
        .expect("insert should parse");

        assert!(matches!(sc, SourceChange::Insert { .. }), "expected Insert");
        let el = element_of(&sc);
        assert!(matches!(el, Element::Node { .. }), "expected a Node");
        assert_eq!(&*el.get_reference().source_id, "src");
        assert_eq!(&*el.get_reference().element_id, "n1");
        assert_eq!(labels_of(el), vec!["Thing".to_string(), "Widget".to_string()]);
        assert_eq!(el.get_property("x"), &ElementValue::Integer(1));
        assert_eq!(el.get_property("name"), &ElementValue::String("alpha".into()));
    }

    #[test]
    fn op_is_case_insensitive() {
        let sc = json_to_source_change("s", &json!({ "op": "INSERT", "id": "n1" })).unwrap();
        assert!(matches!(sc, SourceChange::Insert { .. }));
    }

    #[test]
    fn add_is_an_alias_for_insert() {
        let sc = json_to_source_change("s", &json!({ "op": "add", "id": "n1" })).unwrap();
        assert!(matches!(sc, SourceChange::Insert { .. }));
    }

    #[test]
    fn update_op_produces_update_change() {
        let sc = json_to_source_change("s", &json!({ "op": "update", "id": "n1" })).unwrap();
        assert!(matches!(sc, SourceChange::Update { .. }));
    }

    #[test]
    fn delete_op_produces_delete_change_preserving_metadata() {
        let sc = json_to_source_change(
            "s",
            &json!({ "op": "delete", "id": "n1", "labels": ["Thing"] }),
        )
        .unwrap();
        match sc {
            SourceChange::Delete { metadata } => {
                assert_eq!(&*metadata.reference.element_id, "n1");
                let labels: Vec<String> = metadata.labels.iter().map(|l| l.to_string()).collect();
                assert_eq!(labels, vec!["Thing".to_string()]);
            }
            other => panic!("expected Delete, got {other:?}"),
        }
    }

    #[test]
    fn remove_is_an_alias_for_delete() {
        let sc = json_to_source_change("s", &json!({ "op": "remove", "id": "n1" })).unwrap();
        assert!(matches!(sc, SourceChange::Delete { .. }));
    }

    #[test]
    fn labels_accept_a_bare_string() {
        let sc =
            json_to_source_change("s", &json!({ "op": "insert", "id": "n1", "labels": "Thing" }))
                .unwrap();
        assert_eq!(labels_of(element_of(&sc)), vec!["Thing".to_string()]);
    }

    #[test]
    fn labels_default_to_empty_when_absent() {
        let sc = json_to_source_change("s", &json!({ "op": "insert", "id": "n1" })).unwrap();
        assert!(labels_of(element_of(&sc)).is_empty());
    }

    #[test]
    fn effective_from_is_honored_when_provided() {
        let sc = json_to_source_change(
            "s",
            &json!({ "op": "insert", "id": "n1", "effectiveFrom": 1_700_000_000_000u64 }),
        )
        .unwrap();
        assert_eq!(element_of(&sc).get_effective_from(), 1_700_000_000_000);
    }

    #[test]
    fn effective_from_defaults_to_now_when_absent() {
        let sc = json_to_source_change("s", &json!({ "op": "insert", "id": "n1" })).unwrap();
        assert!(element_of(&sc).get_effective_from() > 0, "should default to a real timestamp");
    }

    #[test]
    fn relation_with_both_ends_marshals_in_and_out_nodes() {
        let sc = json_to_source_change(
            "s",
            &json!({
                "op": "insert",
                "id": "e1",
                "labels": ["KNOWS"],
                "startId": "a",
                "endId": "b"
            }),
        )
        .unwrap();
        match element_of(&sc) {
            Element::Relation { in_node, out_node, .. } => {
                assert_eq!(&*in_node.element_id, "a");
                assert_eq!(&*in_node.source_id, "s");
                assert_eq!(&*out_node.element_id, "b");
            }
            other => panic!("expected Relation, got {other:?}"),
        }
    }

    #[test]
    fn relation_accepts_in_id_out_id_aliases() {
        let sc = json_to_source_change(
            "s",
            &json!({ "op": "insert", "id": "e1", "inId": "a", "outId": "b" }),
        )
        .unwrap();
        match element_of(&sc) {
            Element::Relation { in_node, out_node, .. } => {
                assert_eq!(&*in_node.element_id, "a");
                assert_eq!(&*out_node.element_id, "b");
            }
            other => panic!("expected Relation, got {other:?}"),
        }
    }

    #[test]
    fn relation_with_only_start_id_is_rejected() {
        let err = json_to_source_change(
            "s",
            &json!({ "op": "insert", "id": "e1", "startId": "a" }),
        )
        .unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::RelationRequiresBothEnds);
    }

    #[test]
    fn relation_with_only_end_id_is_rejected() {
        let err =
            json_to_source_change("s", &json!({ "op": "insert", "id": "e1", "endId": "b" }))
                .unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::RelationRequiresBothEnds);
    }

    #[test]
    fn non_object_change_is_rejected() {
        let err = json_to_source_change("s", &json!(42)).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::ChangeNotObject);
    }

    #[test]
    fn missing_op_is_rejected() {
        let err = json_to_source_change("s", &json!({ "id": "n1" })).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::ChangeOpRequired);
    }

    #[test]
    fn missing_id_is_rejected() {
        let err = json_to_source_change("s", &json!({ "op": "insert" })).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::ChangeIdRequired);
    }

    #[test]
    fn unknown_op_is_rejected() {
        let err =
            json_to_source_change("s", &json!({ "op": "frobnicate", "id": "n1" })).unwrap_err();
        assert_eq!(err.code, DrasiErrorCode::UnknownChangeOp);
        assert!(err.message.contains("frobnicate"), "message names the bad op");
    }
}
