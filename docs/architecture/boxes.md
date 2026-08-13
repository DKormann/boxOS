# Blobs, boxes, and methods

## Blob store

BOXOS has one generic content-addressed byte store:

```text
put(bytes) -> blob ID
get(blob ID) -> exact bytes
```

The store does not classify content as code, HTML, manifests, images, or data. Interpretation belongs to an immutable reference to the blob.

A blob ID must commit to the exact bytes using a domain-separated content-addressing scheme. The exact encoding and hash algorithm remain to be specified.

## Box definition

A box definition contains an immutable named method table. Each method independently references one source blob and declares the runtime that interprets it.

Conceptually:

```json
{
  "methods": {
    "create": {
      "runtime": "boxos-js/1",
      "blob": "<blob-id>"
    },
    "remove": {
      "runtime": "boxos-js/1",
      "blob": "<blob-id>"
    }
  }
}
```

There is no method kind. In particular, methods are not classified as reducers or procedures. The same method model supports synchronous atomic state transitions and asynchronous effect orchestration.

## Validation and creation

Before a box becomes invocable, BOXOS must:

1. decode and canonicalize its complete definition;
2. validate all method names and reject duplicates;
3. retrieve every referenced blob;
4. verify that every declared runtime is supported;
5. validate each method blob under that runtime;
6. reject the complete box if any method is invalid;
7. derive the box ID from a canonical identity object containing the validated definition and any creation fields the final identity design requires.

The method table is permanently immutable within this model. Changing, adding, or removing a method creates a different box.

A box ID identifies both its immutable interface and its isolated state namespace. The exact derivation remains open, including whether an explicit creation salt is needed. No implementation should assume an answer until that decision is made.

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
