# HTTP protocol 0.3.0

BOXOS ties its HTTP API version directly to the BOXOS release. All API routes for this release begin with `/0.3.0`. There is no separate API version number.

The initial server uses Bun's SQLite backend. `BOXOS_DB_URL` selects the database and defaults to `sqlite://boxos.sqlite`.

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

Only these fields are accepted. An instance is a creator-selected, non-random string. Method names match `[a-z][a-z0-9_-]{0,63}` and every referenced blob must exist. Runtime source validation will be enabled with method execution; the current storage layer validates the definition and references.

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

`GET https://<page-id>.boxos.org/` serves the exact blob as immutable HTML. Other paths are not served. Deployment requires wildcard DNS and TLS for `*.boxos.org`.

Boxes will access the same kernel operation through the owned effect `ctx.hostPage(blobId)` when invocation execution is available.

Core BOXOS routes such as `/client.js` and `/0.3.0/...` are also available on a page origin. This lets a hosted page use BOXOS without cross-origin requests while unknown non-root paths still return 404.

## Startup examples

The server discovers every `examples/*.html` file and publishes it through the normal blob and page hosting operations during startup. `examples/about.html` is also served as the main server landing page, so the landing page contains no server-source template. Publication is idempotent. The filename without `.html` is its example name. The example index mirrors the folder on each startup, while old immutable blobs and pages remain retained.

```text
GET /0.3.0/examples
```

returns the published names, immutable production URLs, and `.localhost` development URLs. Startup also logs both forms. Bun's default port produces addresses such as `http://<page-id>.localhost:3000`.

## Reference client

The dependency-free browser client source is served from `/client.js` as a classic script and installs `BoxOSClient` and `BoxOSError` on `globalThis`.

```html
<script src="/client.js"></script>
<script>
  const boxos = new BoxOSClient();
</script>
```

It exposes `putBlob`, `getBlob`, `createBox`, `getBox`, and `hostPage`. Its source is the protocol's minimal executable reference, not a separate compatibility layer.

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
