# Building BoxOS apps

This document is the terminal-agent reference for the BoxOS 0.3.2 server in this
repository. The server has no package dependencies and runs with Bun.

## Start and inspect the server

```sh
bun src/main.ts
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/startup
```

The examples in `examples/startup/` are deployed idempotently at startup. The
startup endpoint returns their current content-addressed IDs. Never hard-code an
ID from an old run when you can read this endpoint.

Useful source files:

```text
examples/startup/              Example definitions deployed at startup
examples/startup/pages/*.html  Ordinary immutable HTML page sources
examples/startup/boxes/*.ts    Box method definitions
public/client.js               Reference browser client
src/server/server.ts           HTTP API
src/server/service.ts          Signing protocol
src/execution/native.ts        ctx API
src/language/parser.ts         Accepted JavaScript subset
src/operations/operations.ts   Shared client/box operations
```

## The model

- An **account** is a raw Ed25519 public key. Its lowercase hexadecimal encoding
  is the 64-character account ID. The private key stays with the client.
- A **blob** is immutable text addressed by its SHA-256 hash.
- A **box** is an immutable set of validated JavaScript method bodies plus its
  own public and private key/value storage.
- A **page** is an immutable HTML blob with a shortened 16-character ID.
- A **client ID** is currently the page account ID.
- Pure BoxOS values are `null`, booleans, finite numbers, strings, arrays, and
  plain string-keyed objects. `undefined`, functions, binary values, cycles,
  sparse arrays, accessors, and class instances are not values.

Anyone may read immutable entities and public box storage. Only the box's own
methods can write either public or private box storage. Private storage is only
available while that box executes.

## Page files

Pages should be `.html` files. A minimal page is:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example</title>
</head>
<body>
  <button id="run">Run</button>
  <script type="module">
    import { boxos } from "/client.js";
    document.querySelector("#run").onclick = async () => {
      const result = await boxos.invoke("BOX_ID", "method", { value: 1 });
      if (!result.ok) throw new Error(result.error);
      console.log(result.value);
    };
  </script>
</body>
</html>
```

Pages are available at:

```text
http://<page-id>.localhost:3000/
http://127.0.0.1:3000/v1/pages/<page-id>
https://<page-id>.boxos.org/
```

Each page subdomain is a separate browser origin and receives a separate page
account in IndexedDB. Link the startup `default.css` blob for the standard
system-aware, dark-first BoxOS design variables and components.

## Defining boxes

A box definition is pure JSON whose methods are JavaScript **method bodies**, not
whole function declarations:

```json
{
  "methods": {
    "increment": "let n = ctx.storage.public.get(\"count\") || 0; n = n + 1; ctx.storage.public.set(\"count\", n); return n;"
  }
}
```

Each method receives fixed bindings:

```text
ctx, input, JSON, Math, String, Number
```

Methods run synchronously as validated native JavaScript in a worker. One method
or resumed callback is one atomic SQLite turn. If it throws, times out, returns
an invalid value, or its worker fails, its storage writes and declared effects
roll back.

The safe subset rejects ambient globals, `this`, classes, prototypes,
`constructor`, dynamic evaluation, imports, `new`, arrow functions, async/await,
and reflective escapes. `Math.random` is unavailable. Use ordinary named or
anonymous `function` expressions for callbacks. Computed indexing has the
restricted form `value[Number(expression)]`.

### Method context

```js
ctx.account                         // authenticated originating account
ctx.clientId                        // originating page account, or null
ctx.storage.public.get(key)
ctx.storage.public.set(key, value)
ctx.storage.public.delete(key)
ctx.storage.private.get(key)
ctx.storage.private.set(key, value)
ctx.storage.private.delete(key)
ctx.transfer(receiverAccount, amount)
ctx.message(clientId, value)
ctx.invoke(boxId, method, input, callback, callbackContext)
ctx.publish(kind, arguments, callback, callbackContext)
ctx.request(request, callback, callbackContext)
```

`transfer` and `message` commit in the current turn. `invoke`, `publish`, and `request` are
durable effects. Their callbacks run later as fresh atomic turns on the origin
box.

Callback source is captured with the trusted
`Function.prototype.toString.call(callback)`, parsed with the method parser, and
persisted. A callback cannot capture method locals. Put everything it needs in
explicit callback context:

```js
ctx.invoke(target, "read", input, function completed(result, saved) {
  ctx.storage.private.set(saved.key, result);
}, { key: input.key });
```

This is invalid because `key` is a free variable:

```js
let key = input.key;
ctx.invoke(target, "read", null, function completed(result) {
  ctx.storage.private.set(key, result);
});
```

### Publishing from a box

```js
ctx.publish("blob", { text: "...", contentType: "text/plain" }, callback, context);
ctx.publish("page", { blobId: "..." }, callback, context);
ctx.publish("box", { methods: { run: "return input;" } }, callback, context);
ctx.publish("account", { pubkey: "..." }, callback, context);
```

A successful publication callback receives `{ id }`.

### Public HTTPS requests from a box

`ctx.request` declares a durable, non-streaming HTTPS request. It is deliberately
not raw `fetch`: the structure admits only public HTTPS JSON API requests.

```js
ctx.request({
  host: "api.example.com",
  path: "/v1/messages?format=json",
  method: "POST",
  headers: { Authorization: "Bearer " + input.token },
  body: { message: input.message }
}, function completed(response, saved) {
  if (response.ok) ctx.storage.private.set(saved.key, response.body);
  else ctx.message(saved.clientId, { error: response.error || response.body });
}, { key: "last-response", clientId: ctx.clientId });
```

The API accepts only:

- a multi-label public DNS `host`, without a scheme, port, user info, or IP literal;
- an absolute `path` of at most 4096 characters;
- `GET` without a body or `POST` with an optional pure-value JSON body;
- ordinary end-to-end string headers. Transport headers such as `Host`,
  `Content-Length`, and `Transfer-Encoding` are runtime-owned.

Requests always use HTTPS on port 443, pin a publicly routable DNS result for
the TLS connection, validate the certificate for `host`, and never follow
redirects. Private, loopback, link-local, mixed public/private DNS, and other
non-public destinations are rejected. Request and response bodies are limited
to 256 KiB, and requests time out after 30 seconds.

The callback receives `{ ok, requestId, status, contentType, body }` for an HTTP
response or `{ ok: false, requestId, error }` for a transport failure. JSON
responses become pure BoxOS values; other response bodies are strings. As with
all external POST requests, a crash after remote acceptance but before durable
settlement can cause a retry. Use an upstream idempotency key when available.

## Signing terminal requests

HTTP mutations use Ed25519 signatures. Encode public keys and signatures as
lowercase hexadecimal. Canonical JSON recursively sorts object keys while
preserving array order.

```ts
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value == "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
  }
  return value
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

const keys = await crypto.subtle.generateKey(
  { name: "Ed25519" }, true, ["sign", "verify"],
) as CryptoKeyPair
const account = hex(await crypto.subtle.exportKey("raw", keys.publicKey))

async function signed(purpose: string, request: unknown) {
  const message = `${purpose}\n${JSON.stringify(canonical(request))}`
  const signature = hex(await crypto.subtle.sign(
    { name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(message),
  ))
  return { account, signature, request }
}
```

A valid unknown account is registered automatically on its first signed
interaction. It receives initial fuel and is lazily topped up when it interacts
after the configured interval. Exact signed-request replay is idempotent.

Use a fresh `crypto.randomUUID()` nonce for each new action. Reuse the complete
same signed request only when retrying that action.

## HTTP API

All request and response bodies below are JSON unless stated otherwise.

### Public reads

```text
GET /health
GET /AGENTS.md
GET /client.js
GET /v1/startup
GET /v1/boxes/<64-char-box-id>
GET /v1/boxes/<box-id>/storage/public?key=<encoded-key>
GET /v1/blobs/<64-char-blob-id>
GET /v1/pages/<16-char-page-id>
```

`GET /v1/startup` returns:

```json
{
  "deployments": {
    "accounts.page": { "kind": "page", "id": "..." },
    "accounts.grants": { "kind": "box", "id": "..." },
    "accounts.profiles": { "kind": "box", "id": "..." },
    "app-explorer.apps": { "kind": "box", "id": "..." },
    "app-explorer.page": { "kind": "page", "id": "..." },
    "profile.page": { "kind": "page", "id": "..." },
    "default.css": { "kind": "blob", "id": "..." }
  }
}
```

A public storage response is either:

```json
{ "found": true, "value": "..." }
```

or:

```json
{ "found": false }
```

### Publish a box

Sign with purpose `boxos.publish-box.v1`:

```http
POST /v1/boxes
```

```json
{
  "account": "<public-key>",
  "signature": "<signature>",
  "request": {
    "nonce": "<uuid>",
    "definition": { "methods": { "run": "return input;" } }
  }
}
```

Response: `{ "id": "<box-id>" }`.

### Invoke a box

Sign with purpose `boxos.invoke.v1`:

```http
POST /v1/invoke
```

```json
{
  "account": "<public-key>",
  "signature": "<signature>",
  "request": {
    "nonce": "<uuid>",
    "boxId": "<box-id>",
    "method": "run",
    "input": null,
    "clientId": null
  }
}
```

A browser page sets `clientId` to its account. A terminal may use `null`.
Response:

```json
{ "ok": true, "value": null }
```

or:

```json
{ "ok": false, "error": "..." }
```

Signatures cover only the nested `request`, not the outer envelope.

### Direct operations

Sign with purpose `boxos.operation.v1` and send:

```http
POST /v1/operations
```

```json
{
  "account": "<public-key>",
  "signature": "<signature>",
  "request": {
    "nonce": "<uuid>",
    "operation": { "type": "..." }
  }
}
```

Supported operations:

```json
{ "type": "transfer", "receiver": "<account>", "amount": 100 }
{ "type": "message", "clientId": "<account>", "message": { "hello": true } }
{ "type": "publishBlob", "text": "...", "contentType": "text/html; charset=utf-8" }
{ "type": "publishPage", "blobId": "<blob-id>" }
```

Publishing an app is normally:

1. publish its boxes;
2. substitute returned box IDs into the `.html` source;
3. publish the HTML with `publishBlob` and `text/html; charset=utf-8`;
4. publish the returned blob with `publishPage`;
5. print the page subdomain URL.

### Client events

Messages are delivered with authenticated Server-Sent Events over a streaming
POST, not a WebSocket and not the browser `EventSource` constructor.

Sign with purpose `boxos.events.v1`:

```http
POST /v1/events
Accept: text/event-stream
```

```json
{
  "account": "<page-account>",
  "signature": "<signature>",
  "request": { "nonce": "<uuid>", "clientId": "<same-page-account>" }
}
```

The stream emits `message` events whose data is:

```json
{ "id": "...", "sender": "<account>", "message": "<pure-value>" }
```

## Browser client

`/client.js` exports `boxos`:

```js
import { boxos } from "/client.js";

await boxos.account();
await boxos.invoke(boxId, method, input);
await boxos.publishBox(definition);
await boxos.publishBlob(text, contentType);
await boxos.publishPage(blobId);
await boxos.transfer(receiver, amount);
await boxos.message(clientId, value);
await boxos.readPublic(boxId, key);
await boxos.events(message => console.log(message), { signal });
```

The client creates one non-extractable page-account key in origin-scoped
IndexedDB. Human identity accounts managed by the Accounts example are distinct
from this automatic page account.

## Requesting account capabilities

Read `/v1/startup` to find `accounts.page`, `accounts.grants`, and
`accounts.profiles`. Redirect the browser to the Accounts page with:

```text
app_name=<displayed app name>
app_account=<requesting page account>
permissions=<comma-separated capabilities>
redirect_uri=<HTTP(S) return URL>
state=<unguessable state>
```

The Accounts page returns a URL fragment containing:

```text
account=<selected human account>
state=<original state>
grants_box=<box ID>
profiles_box=<box ID>
```

or `error=access_denied`. Always verify `state`.

A grant is public storage in the grants box under:

```text
<owner-account>|<grantee-page-account>|<permission>
```

The startup App Explorer requests `manage apps`. Its catalog records and page
version histories are public, while each human account's installed-app list is
private box storage. Publishing a new immutable page version updates the stable
catalog entry; installations can then explicitly move to that version.

The Profiles box stores only public profile names. An app granted
`manage account` can call:

```json
{
  "method": "setName",
  "input": {
    "account": "<human-account>",
    "name": "New name",
    "requestId": "<uuid>"
  }
}
```

The call returns pending because the Profiles box checks the grant durably. Poll
its public key `status|<requestId>`. Read the current name from
`name|<human-account>`. The Accounts app sets the initial name during creation
but does not expose profile renaming.

## Repository startup examples

A startup page is an HTML template with uppercase placeholders:

```html
<script type="module">
  const boxId = "{{MY_BOX}}";
</script>
```

`examples/startup/deploy.ts` publishes dependencies in order, replaces the
placeholders, publishes the HTML blob, publishes the page, and records a friendly
name in `startup_deployments`. Keep page behavior in `.html`; do not generate
whole pages from TypeScript.

Before finishing an app change, run:

```sh
bunx tsc --noEmit
bun test
git diff --check
```

For generated or templated page scripts, add a test that extracts and parses the
module source. This catches browser syntax errors before deployment.
