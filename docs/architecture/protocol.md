# HTTP protocol 0.3.0

BOXOS ties its HTTP API version directly to the BOXOS release. All API routes for this release begin with `/0.3.0`. There is no separate API version number.

The initial server uses Bun's SQLite backend. `BOXOS_DB_URL` selects the database and defaults to `sqlite://boxos.sqlite`.

## Accounts and development faucet

```text
POST /0.3.0/accounts
GET  /0.3.0/accounts/:publicKey
```

Registration accepts `{ "publicKey": "<base64url Ed25519 key>" }`. A previously unseen key receives 1,000,000,000 fuel and nonce 0. Registration is idempotent and never resets fuel or nonce. This intentionally generous public faucet is initial deployment policy, not a scarcity or abuse-prevention mechanism.

`BoxOSClient` creates an extractable Ed25519 key locally on first use, stores its private JWK in that origin's local storage, sends only the public key to BOXOS, and exposes registration through its `ready` promise and `account()` method. This simple initial key storage is not a production wallet security claim.

## Blobs

```text
POST /0.3.0/blobs
GET  /0.3.0/blobs/:id
HEAD /0.3.0/blobs/:id
```

`POST` accepts the request body as exact uninterpreted bytes and returns:

```json
{ "id": "blob_<sha256>", "bytes": 123 }
```

Reads return the exact bytes with immutable cache headers. Putting the same bytes is idempotent.

## Boxes

```text
POST /0.3.0/boxes
GET  /0.3.0/boxes/:id
```

Creation accepts a JSON box definition:

```json
{
  "runtime": "boxos-js/0.3.0",
  "instance": "production-counter",
  "methods": {
    "increment": { "blob": "blob_<sha256>" }
  }
}
```

Only these fields are accepted. An instance is a creator-selected, non-random string. Method names match `[a-z][a-z0-9_-]{0,63}` and every referenced blob must exist.

Box creation decodes every method blob as strict UTF-8 and parses it as the restricted `boxos-js/0.3.0` subset. The complete box is rejected when any source is invalid. Validation happens before storage even though invocation execution is not exposed yet.

After validation, BOXOS serializes the definition once with `JSON.stringify` and stores those exact bytes in the generic blob store. The response identifies both the box and definition blob:

```json
{
  "id": "box_<sha256>",
  "definitionBlob": "blob_<sha256>",
  "definition": {}
}
```

SQLite stores box-wide metadata in `boxes` and the validated `(box, method) -> source blob` index in `box_methods`. Invocation can therefore resolve a method directly without decoding or parsing the definition again. The definition blob remains authoritative; these tables are validated indexes over it.

## Invocations

```text
POST /0.3.0/invocations
```

The body contains a command and its base64url Ed25519 signature:

```json
{
  "command": {
    "publicKey": "<account key>",
    "nonce": 0,
    "box": "box_<sha256>",
    "method": "increment",
    "maxFuel": 1000000,
    "input": null
  },
  "signature": "<signature>"
}
```

The signed bytes are the UTF-8 prefix `BOXOS:INVOKE:0.3.0\0` followed by plain `JSON.stringify(command)`. Commands use the account's strict next nonce. BOXOS reserves `maxFuel`, executes the method, refunds unused fuel, and returns a receipt.

Invocation resolves source through `box_methods`; it does not parse the box definition or source again. Each invocation executes in a fresh Bun Worker with a one-second deadline. The host passes only copied BOXOS values and a frozen synchronous `ctx.atomic` capability. Native globals are inaccessible to validated source, and the worker is terminated after settlement.

Invocations of one box may execute concurrently in isolated workers. Only `ctx.atomic` blocks enter the per-box queue. A worker synchronously acquires that logical lock before running the callback; exact-key reads are then served from committed SQLite state and writes are buffered in the worker. Reads after a buffered write observe that write. If the callback succeeds, only its write set is validated and applied in one short SQLite transaction; if it throws, the write set is discarded. Public readers therefore observe either the state before or after the commit, never a partial transition. No complete box-state snapshot is loaded or rewritten.

The logical lock is released on commit, callback abort, malformed state operations, worker failure, or deadline termination. A runtime flag remains active from lock acquisition through callback completion and commit. Nested atomic blocks are rejected, and asynchronous or external effect capabilities reject while this flag is active. A later method error does not discard earlier successful blocks.

Runtime 1 now provides eager owned Tasks for `ctx.request`, `ctx.call`, and `ctx.hostPage`, with top-level `await`, `.then`, and `.catch`. Invocation settlement waits for every owned Task, including unreturned Tasks. Task derivation as well as effect creation is dynamically rejected inside `ctx.atomic`. Cross-box calls preserve the root caller and identify the immediate calling box and method. Calls are limited to depth 16. Because invocations no longer retain box locks while awaiting effects, calls may return to a box already present in their lineage without lock deadlock.

The host separately tracks every effect operation rather than relying only on the worker's Task registry. Deadline or parent cancellation aborts requests, propagates cancellation through child invocations, waits for their host operations and pending atomic RPC to settle, and only then returns the root result and fuel refund. External systems may still act on a request that was already delivered before cancellation. Child-call work is lifecycle-owned by the root invocation, although detailed shared-purse metering is not yet implemented.

Initial metering is intentionally simple: successful work costs `10000 + source bytes`, ordinary method failure costs `20000 + source bytes`, and a deadline consumes the reserved purse. All costs are capped by `maxFuel`.

## Public state reads

```text
GET /0.3.0/boxes/:box/state/public/:key
```

Public state is readable without authentication, invocation, or fuel. Keys are URL-encoded exact strings of at most 1024 UTF-8 bytes. Responses distinguish an absent key from a stored `null` value:

```json
{ "found": true, "value": 42 }
```

```json
{ "found": false }
```

Reads use SQLite transaction visibility and therefore observe a complete committed atomic state, never a partial transition. Responses use `cache-control: no-store`. Private state has no corresponding public route.

## Hosted pages

```text
POST /0.3.0/pages
```

The request references an existing HTML blob:

```json
{ "blob": "blob_<sha256>" }
```

The response contains its 32-character lowercase base32 page ID, immutable origin, and hosting fuel cost:

```json
{
  "id": "abcdefghijklmnopqrstuvwxyz234567",
  "blob": "blob_<sha256>",
  "origin": "https://abcdefghijklmnopqrstuvwxyz234567.boxos.org",
  "fuel": 106000,
  "created": true
}
```

A new mapping costs `100000 + 100 × HTML bytes` fuel. Re-hosting it costs 1000 fuel and returns `created: false`. Fuel is reported but cannot be debited until accounts are implemented.

`GET https://<page-id>.boxos.org/` serves the exact blob as immutable HTML. Other paths are not served. The default public origin is `https://boxos.org`; another deployment sets `BOXOS_PUBLIC_URL` to its root origin and provides wildcard DNS and TLS for page subdomains. Reverse proxies preserve `Host` or send `X-Forwarded-Host`, and send the original protocol in `X-Forwarded-Proto`.

Boxes access the same kernel operation through the owned effect `ctx.hostPage(blobId)`.

Core BOXOS routes such as `/client.js` and `/0.3.0/...` are also available on a page origin. This lets a hosted page use BOXOS without cross-origin requests while unknown non-root paths still return 404.

## Startup examples

The server reads `examples/manifest.json` during startup. This explicit manifest maps each example name to an HTML page and, optionally, an inline box description whose methods reference source files. The publisher stores those files as blobs and submits ordinary page and box definitions through the same validation paths as HTTP clients. Publication is idempotent and the generated example index is deployment metadata kept in memory; immutable blobs, boxes, and pages remain retained normally.

`examples/about.html` is the required `about` entry and is also served as the main server landing page, so the landing page contains no server-source template. The counter entry references `counter.html` and an inline box definition using `counter.increment.js`. Its page reads `state.public` directly and invokes the real `increment` box method with the browser account; there is no read method, counter-specific route, table, or server function.

```text
GET /0.3.0/examples
```

returns each published name, box ID, canonical `url`, deployment-relative `currentUrl`, and a `localUrl` only on localhost. Pages use `currentUrl` when linking to another example origin, so wallet redirects remain on the server that delivered the page. Startup also logs canonical and localhost forms. Bun's default port produces addresses such as `http://<page-id>.localhost:3000`.

## Reference client

The dependency-free browser client source is served from `/client.js` as a classic script and installs `BoxOSClient` and `BoxOSError` on `globalThis`.

```html
<script src="/client.js"></script>
<script>
  const boxos = new BoxOSClient();
</script>
```

It exposes `putBlob`, `getBlob`, `createBox`, `getBox`, `getPublicState`, `invoke`, and `hostPage`. Its source is the protocol's minimal executable reference, not a separate compatibility layer.

## JSON and errors

BOXOS 0.3.0 uses ordinary `JSON.parse` and `JSON.stringify`. It does not canonicalize JSON. Property insertion order is significant anywhere serialized JSON is hashed or signed.

Errors have one shape:

```json
{
  "error": {
    "code": "blob_not_found",
    "message": "Blob not found"
  }
}
```
