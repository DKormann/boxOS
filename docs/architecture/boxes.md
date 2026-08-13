# Blobs, boxes, and methods

## Blob store

BOXOS has one generic content-addressed byte store:

```text
put(bytes) -> blob ID
get(blob ID) -> exact bytes
```

The store does not classify content as code, HTML, manifests, images, or data. Interpretation belongs to an immutable reference to the blob.

A blob ID commits to the exact bytes using SHA-256 over the UTF-8 domain prefix `BOXOS:BLOB:0.3.0\0` followed by the bytes. It is represented as `blob_` followed by the lowercase hexadecimal digest.

## Box definition

A box definition contains one runtime, a caller-selected instance string, and an immutable named method table. The runtime is fixed across the complete box; each method references one source blob.

```json
{
  "runtime": "boxos-js/0.3.0",
  "instance": "production-counter",
  "methods": {
    "create": { "blob": "<blob-id>" },
    "remove": { "blob": "<blob-id>" }
  }
}
```

`instance` distinguishes boxes containing the same code. It is deliberately supplied by the creator rather than generated randomly. It may be a meaningful stable name, deployment identifier, or application-derived string. Reusing the same complete JSON definition identifies the same box.

There is no method kind. In particular, methods are not classified as reducers or procedures. The same method model supports synchronous atomic state transitions and asynchronous effect orchestration.

## Validation and creation

Before a box becomes invocable, BOXOS must:

1. parse its complete JSON definition;
2. validate the runtime, instance, and all method names;
3. retrieve every referenced blob;
4. verify that the box runtime is supported;
5. validate each method blob under that runtime;
6. reject the complete box if any method is invalid;
7. serialize the parsed definition with plain `JSON.stringify`;
8. derive the box ID from those exact UTF-8 bytes.

The box ID is SHA-256 over `BOXOS:BOX:0.3.0\0` followed by the serialized definition, represented as `box_` and the lowercase hexadecimal digest. BOXOS 0.3.0 intentionally performs no canonicalization or key sorting. JSON object property order is therefore identity-significant.

The method table and instance are permanently immutable. Changing code, runtime, method order, property order, or instance creates a different box identity. A new instance string creates an independent state namespace for otherwise identical code. Repeating the same serialized definition is idempotent.

## State ownership

A box has one state namespace divided into two visibility classes:

- **private:** readable only by methods of that box through an atomic block;
- **public:** also readable through a public read interface.

Only methods of the box may mutate either class. “Private” is an access-control property, not encryption from the BOXOS operator or runtime.

State provides exact-key operations only:

```text
get(key)
has(key)
set(key, value)
delete(key)
```

Enumeration, range scans, secondary indexes, and query languages are not part of the agreed core. A box can maintain explicit indexes in its own state.

## Isolation

A box is all of the following:

- a state namespace;
- an atomicity boundary;
- an admission and scheduling boundary;
- a failure-containment boundary;
- an authorization resource;
- an independently placeable storage unit.

No foreign box code executes inside its atomic block. Physical colocation with another box grants no semantic privilege.

## Code reuse

Globally stored helper blobs remain an open language-design question. If supported, they must be immutable, explicitly pinned dependencies and must not introduce state, effects, ambient authority, or a second invocation model. Dynamic composition between boxes uses asynchronous method calls, not helper invocation by hash.
