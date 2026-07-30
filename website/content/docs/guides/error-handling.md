---
title: "Error Handling"
linkTitle: "Error Handling"
weight: 40
description: >
  Branch on stable DrasiErrorCode values instead of matching error messages.
---

Argument and validation failures throw a stable, machine-readable **code** so your
code can branch on it instead of matching human-readable messages. The
`DrasiErrorCode` enum is exported from the package.

## Branch on `err.code`

`DrasiErrorCode` is a regular (non-`const`) `enum` with string values. It is safe
under `isolatedModules` / esbuild / swc / Vite and has a real runtime value, so both
the type and the value are usable:

```ts
import { Drasi, DrasiErrorCode } from '@drasi/lib';

try {
  await drasi.addSource('unknown', 's', {});
} catch (err) {
  if ((err as { code?: string }).code === DrasiErrorCode.UnknownSourceKind) {
    // handle the unregistered-kind case
  }
}
```

## Sync throws vs. async fallbacks

Because napi-rs can only attach a custom `code` on a **synchronous** throw (async
promise rejections are forced to `code === 'GenericFailure'`), errors fall into two
classes. The human-readable message is the same in both cases.

### Synchronous throws (`err.code` is the stable code)

Argument validation runs synchronously, before the method returns its `Promise`. On
their normal paths these codes surface as a real `err.code`:

`UNKNOWN_SOURCE_KIND`, `UNKNOWN_REACTION_KIND`, `UNKNOWN_BOOTSTRAP_KIND`,
`BOOTSTRAP_KIND_REQUIRED`, `MISSING_CONFIG_FIELD`, `NO_JS_SOURCE`, `JS_SOURCE_CLOSED`,
`CHANGE_NOT_OBJECT`, `CHANGE_OP_REQUIRED`, `CHANGE_ID_REQUIRED`,
`RELATION_REQUIRES_BOTH_ENDS`, `UNKNOWN_CHANGE_OP`, `STATE_STORE_PATH_REQUIRED`,
`UNKNOWN_STATE_STORE_KIND`, `UNKNOWN_QUERY_LANGUAGE`, `INDEX_STORE_PATH_REQUIRED`,
`UNKNOWN_INDEX_STORE_KIND`, `IDENTITY_KIND_REQUIRED`, `UNKNOWN_IDENTITY_KIND`,
`IDENTITY_CONFIG_INVALID`, and `DURABLE_REQUIRES_STATE_STORE`.

{{% alert title="await/try catches these; bare promises may not" color="warning" %}}
Because validation is a **synchronous throw** rather than a rejected promise, it is
transparent to `await` / `try` callers — but a bare `p = fn(); p.catch(...)` (no
`await`) will **not** catch it. Always `await` (or wrap the call site in `try`).
{{% /alert %}}

### Async fallbacks (message-only; `err.code === 'GenericFailure'`)

A few paths can only fail after async work has begun — component creation inside
`fromConfig`, a rejected plugin config (`CONFIG_INVALID`), a rejected/tampered plugin
signature (`PLUGIN_SIGNATURE_INVALID`), or the rare race where a JS source closes
mid-`pushChange` (`JS_SOURCE_CLOSED`). There the stable code is embedded in the
message as a trailing `[CODE]` token, e.g. `unknown source kind 'x' [UNKNOWN_SOURCE_KIND]`.

## A single helper that handles both

This helper returns the stable code whether it arrived as a sync `err.code` or an
async `[CODE]` token, so one check works everywhere:

```ts
function drasiCode(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string };
  if (e.code && e.code !== 'GenericFailure') return e.code;   // sync throw
  return e.message?.match(/\[([A-Z_]+)\]\s*$/)?.[1];          // async fallback
}
```

Use it like:

```ts
try {
  await drasi.pushChange('orders', change);
} catch (err) {
  switch (drasiCode(err)) {
    case DrasiErrorCode.NoJsSource: /* ... */ break;
    case DrasiErrorCode.RelationRequiresBothEnds: /* ... */ break;
    default: throw err;
  }
}
```

## Full code list

| `DrasiErrorCode` member | String value |
| --- | --- |
| `UnknownSourceKind` | `UNKNOWN_SOURCE_KIND` |
| `UnknownReactionKind` | `UNKNOWN_REACTION_KIND` |
| `UnknownBootstrapKind` | `UNKNOWN_BOOTSTRAP_KIND` |
| `BootstrapKindRequired` | `BOOTSTRAP_KIND_REQUIRED` |
| `MissingConfigField` | `MISSING_CONFIG_FIELD` |
| `NoJsSource` | `NO_JS_SOURCE` |
| `JsSourceClosed` | `JS_SOURCE_CLOSED` |
| `ChangeNotObject` | `CHANGE_NOT_OBJECT` |
| `ChangeOpRequired` | `CHANGE_OP_REQUIRED` |
| `ChangeIdRequired` | `CHANGE_ID_REQUIRED` |
| `RelationRequiresBothEnds` | `RELATION_REQUIRES_BOTH_ENDS` |
| `UnknownChangeOp` | `UNKNOWN_CHANGE_OP` |
| `StateStorePathRequired` | `STATE_STORE_PATH_REQUIRED` |
| `UnknownStateStoreKind` | `UNKNOWN_STATE_STORE_KIND` |
| `UnknownQueryLanguage` | `UNKNOWN_QUERY_LANGUAGE` |
| `ConfigInvalid` | `CONFIG_INVALID` |
| `PluginSignatureInvalid` | `PLUGIN_SIGNATURE_INVALID` |
| `IndexStorePathRequired` | `INDEX_STORE_PATH_REQUIRED` |
| `UnknownIndexStoreKind` | `UNKNOWN_INDEX_STORE_KIND` |
| `IdentityKindRequired` | `IDENTITY_KIND_REQUIRED` |
| `UnknownIdentityKind` | `UNKNOWN_IDENTITY_KIND` |
| `IdentityConfigInvalid` | `IDENTITY_CONFIG_INVALID` |
| `DurableRequiresStateStore` | `DURABLE_REQUIRES_STATE_STORE` |
