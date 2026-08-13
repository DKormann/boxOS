# Hosted pages

## Page model

A hosted page is an immutable blob served as HTML from a shortened content-derived address and an isolated browser origin.

```text
HTML bytes -> blob ID -> hosted page ID -> isolated origin
```

Pages do not introduce another mutable deployment object. Changing one byte produces another blob and page ID.

## Hosting operation

Hosting is an authenticated, fuel-charged BOXOS operation. Conceptually:

```text
hostPage(account, HTML blob, maximum fuel) -> page ID and receipt
```

The operation:

1. verifies that the referenced blob exists;
2. validates the page size and any minimal hosting constraints;
3. derives a short page ID from the full content hash;
4. checks the stored mapping for a short-ID collision;
5. stores the immutable page-ID-to-blob mapping when absent;
6. charges the invoking account for newly retained bytes and metadata;
7. returns the page ID, origin, and fuel receipt.

Hosting the same blob again is idempotent and should not charge again for storage already retained, though bounded request-processing cost may remain.

## Short IDs and collision checking

The full blob hash remains the authoritative content identity. The page ID is a convenient shortened hash.

When a candidate page ID is unused, BOXOS binds it to the full blob ID. When it is already bound to the same blob, hosting succeeds idempotently. When it is bound to different content, BOXOS must detect the collision and must never serve the wrong bytes.

The initial implementation may fail explicitly on such a collision. A future design may lengthen the identifier deterministically, but collision behavior must never silently overwrite an existing mapping.

BOXOS 0.3.0 hashes the exact HTML bytes with SHA-256 using the UTF-8 prefix `BOXOS:PAGE:0.3.0\0`. The first 20 digest bytes are encoded as 32 lowercase unpadded base32 characters using `a-z2-7`.

## Serving

A page root serves the exact blob bytes as HTML without executing a method or creating an invocation:

```text
https://<page-id>.boxos.org/
```

Each page ID receives an isolated browser origin. Responses are immutable and publicly cacheable. The page root serves only the HTML blob; versioned BOXOS API routes and `/client.js` remain available on that origin so pages can use BOXOS without cross-origin requests. Other paths return 404.

Serving ordinary cached page reads should not consume invocation fuel. Hosting consumes fuel because it causes retained storage and metadata. Operational bandwidth policy is separate from the initial semantic model.

## Kernel operation

Page hosting is core server functionality rather than a special box. This keeps blob identity, immutable mappings, collision checks, domain routing, and fuel accounting in one small implementation.

It is exposed to methods as an effect:

```js
ctx.hostPage(blobId) -> Task<Page>
```

The Task belongs to the current invocation, spends from its purse, and is forbidden inside `ctx.atomic`. The HTTP operation and method capability call the same kernel implementation.

The initial cost is deliberately simple:

```text
new page: 100,000 fuel + 100 fuel per HTML byte
existing page: 1,000 fuel
```

Until accounts and invocation execution are implemented, the HTTP response reports this cost but cannot debit it. Public serving never spends invocation fuel.
