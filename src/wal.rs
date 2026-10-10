// Copyright 2025 The Drasi Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

use std::borrow::Cow;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use drasi_core::models::SourceChange;
use drasi_lib::{WalError, WalProvider, WriteAheadLogConfig};
use sha2::{Digest, Sha256};

const ENCODED_ID_PREFIX: &str = "__drasi_wal_";
const HEX: &[u8; 16] = b"0123456789abcdef";

/// A closeable WAL provider that keeps backend filename rules out of source IDs.
pub(crate) struct ManagedWalProvider {
    provider: RwLock<Option<Arc<dyn WalProvider>>>,
}

impl ManagedWalProvider {
    pub(crate) fn new(provider: Arc<dyn WalProvider>) -> Self {
        Self {
            provider: RwLock::new(Some(provider)),
        }
    }

    /// Drop the concrete provider and its open database handles without waiting
    /// for the `Drasi` JavaScript object to be garbage-collected.
    pub(crate) fn close(&self) {
        self.provider.write().unwrap().take();
    }

    fn provider(&self) -> Result<Arc<dyn WalProvider>, WalError> {
        self.provider
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| WalError::StorageError("WAL provider is closed".to_string()))
    }

    fn provider_and_id<'a>(
        &self,
        source_id: &'a str,
    ) -> Result<(Arc<dyn WalProvider>, Cow<'a, str>), WalError> {
        Ok((self.provider()?, storage_source_id(source_id)))
    }
}

#[async_trait]
impl WalProvider for ManagedWalProvider {
    async fn register(&self, source_id: &str, config: WriteAheadLogConfig) -> Result<(), WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .register(&storage_id, config)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn append(&self, source_id: &str, event: &SourceChange) -> Result<u64, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .append(&storage_id, event)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn read_from(
        &self,
        source_id: &str,
        sequence: u64,
    ) -> Result<Vec<(u64, SourceChange)>, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .read_from(&storage_id, sequence)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn prune_up_to(&self, source_id: &str, sequence: u64) -> Result<u64, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .prune_up_to(&storage_id, sequence)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn head_sequence(&self, source_id: &str) -> Result<u64, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .head_sequence(&storage_id)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn oldest_sequence(&self, source_id: &str) -> Result<Option<u64>, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .oldest_sequence(&storage_id)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn event_count(&self, source_id: &str) -> Result<u64, WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .event_count(&storage_id)
            .await
            .map_err(|error| remap_error(source_id, error))
    }

    async fn delete_wal(&self, source_id: &str) -> Result<(), WalError> {
        let (provider, storage_id) = self.provider_and_id(source_id)?;
        provider
            .delete_wal(&storage_id)
            .await
            .map_err(|error| remap_error(source_id, error))
    }
}

fn storage_source_id(source_id: &str) -> Cow<'_, str> {
    let is_native = !source_id.is_empty()
        && !source_id.starts_with('.')
        && !source_id.starts_with(ENCODED_ID_PREFIX)
        && source_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if is_native {
        return Cow::Borrowed(source_id);
    }

    let digest = Sha256::digest(source_id.as_bytes());
    let mut encoded = String::with_capacity(ENCODED_ID_PREFIX.len() + digest.len() * 2);
    encoded.push_str(ENCODED_ID_PREFIX);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Cow::Owned(encoded)
}

fn remap_error(source_id: &str, error: WalError) -> WalError {
    match error {
        WalError::CapacityExhausted(_) => WalError::CapacityExhausted(source_id.to_string()),
        WalError::PositionUnavailable {
            requested,
            oldest_available,
            ..
        } => WalError::PositionUnavailable {
            source_id: source_id.to_string(),
            requested,
            oldest_available,
        },
        WalError::SourceNotRegistered(_) => WalError::SourceNotRegistered(source_id.to_string()),
        WalError::SourceAlreadyRegistered(_) => {
            WalError::SourceAlreadyRegistered(source_id.to_string())
        }
        WalError::InvalidSourceId(_, reason) => {
            WalError::InvalidSourceId(source_id.to_string(), reason)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_source_ids_keep_their_existing_filename() {
        assert_eq!(storage_source_id("orders-v1"), "orders-v1");
        assert_eq!(storage_source_id("orders_v1"), "orders_v1");
    }

    #[test]
    fn unsafe_source_ids_get_stable_safe_names() {
        let first = storage_source_id("orders.v1").into_owned();
        let second = storage_source_id("orders.v1").into_owned();
        assert_eq!(first, second);
        assert!(first.starts_with(ENCODED_ID_PREFIX));
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_'));
        assert_ne!(first, storage_source_id("orders/v1"));
    }

    #[test]
    fn reserved_prefix_cannot_collide_with_encoded_names() {
        assert_ne!(
            storage_source_id("__drasi_wal_deadbeef"),
            "__drasi_wal_deadbeef"
        );
    }
}
