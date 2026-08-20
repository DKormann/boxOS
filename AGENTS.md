# Building BoxOS apps

This document is the terminal-agent reference for the BoxOS 0.3.2 server in this
repository. The server has no package dependencies and runs with Bun.

## Inspect BoxOS

```sh
curl https://boxos.org/health
curl https://boxos.org/v1/startup
```

BoxOS hosts a dependency-free Node.js/Bun CLI for developers and agents:

```sh
curl -fsSL https://boxos.org/boxos-cli.js -o boxos
chmod +x boxos
./boxos account create
./boxos page publish ./index.html
./boxos box instantiate <definition-id>
```

The CLI source is `src/cli/main.ts`; `bun scripts/build_cli.ts` generates the
committed `public/boxos-cli.js` artifact. The CLI emits one JSON value on stdout,
writes errors to stderr, and stores its Ed25519 key at
`~/.boxos/account.json` by default. Use `--key`, `--url`,
`BOXOS_KEY`, and `BOXOS_URL` to override those defaults. Run `./boxos --help`
for publishing, invocation, transfer, messaging, and public-read commands.

`box publish` and `page publish` resolve explicit local box links before
publishing. Use a path relative to the file containing the link:

```text
{{BOXOS_BOX:./counter.box.json}}
```

Links may appear in page HTML or inside a box definition's method strings. The
CLI resolves the complete graph, calculates its content IDs, and validates every
linked definition locally with the same parser used by the server before it
sends any publication. It then publishes boxes in dependency order and
substitutes their immutable IDs. Repeated paths are deduplicated and dependency
cycles are rejected. A parser rejection is reported on stderr with the local box
path, method, and source location; a failed preflight publishes nothing. The
server validates every definition again as the security boundary.

The examples in `examples/startup/` are deployed idempotently at startup. The
startup endpoint returns their current content-addressed IDs. Never hard-code an
ID from an old run when you can read this endpoint.

Useful source files:

```text
examples/startup/              Example definitions deployed at startup
examples/startup/pages/*.html  Ordinary immutable HTML page sources
examples/startup/boxes/*.ts    Box method definitions
public/client.js               Reference browser client
public/boxos-cli.js            Generated standalone CLI
public/developers.html         Human-facing developer documentation
src/cli/main.ts                TypeScript CLI source
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
- A **box definition** is an immutable, content-addressed set of validated
  JavaScript method bodies.
- A **box instance** uses one definition and has its own public/private storage,
  immutable creator metadata, and worker ownership. Publishing a definition
  also creates its backwards-compatible canonical instance with the same ID.
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
https://<page-id>.boxos.org/
https://boxos.org/v1/pages/<page-id>
```

Each page subdomain is a separate browser origin and receives a separate page
account in IndexedDB. Link the startup `default.css` blob for the standard
system-aware, dark-first BoxOS design variables and components.

## Defining and instantiating boxes

A box definition is pure JSON whose methods are JavaScript **method bodies**, not
whole function declarations:

```json
{
  "methods": {
    "increment": "let n = ctx.storage.public.get(\"count\") || 0; n = n + 1; ctx.storage.public.set(\"count\", n); return n;"
  }
}
```

`box publish` publishes this definition and creates its canonical singleton box.
Repeated publication returns the same ID and storage. To create independent
storage backed by the same methods, instantiate the published definition:

```sh
boxos box instantiate <definition-id>
boxos box instantiate <definition-id> \
  '{"initialPublic":{"name":"agent"},"initialPrivate":{"key":"secret"}}'
```

Instance IDs derive from the definition ID, creator account, and nonce. The CLI
creates a nonce by default; supplying the same nonce makes retries idempotent and
does not reapply initial state.

Each method receives fixed bindings:

```text
ctx, input, JSON, Math, String, Number
```

Methods run synchronously as validated native JavaScript in a worker. One method
or resumed Task continuation is one atomic SQLite turn. If it throws, times out,
returns neither a pure value nor a durable Task, or its worker fails, its storage
writes and declared effects roll back.

The safe subset rejects ambient globals, `this`, classes, prototypes,
`constructor`, dynamic evaluation, imports, `new`, arrow functions, native
Promises, async/await, and reflective escapes. `Math.random` is unavailable. Use
ordinary named or anonymous `function` expressions for Task continuations.
Computed indexing has the restricted form `value[Number(expression)]`.

### Method context

```js
ctx.account                         // authenticated originating account
ctx.clientId                        // originating page account, or null
ctx.box.id                          // current instance ID
ctx.box.definitionId                // shared definition ID
ctx.box.creator                     // creating account, or null for canonical boxes
ctx.storage.public.get(key)
ctx.storage.public.set(key, value)
ctx.storage.public.delete(key)
ctx.storage.private.get(key)
ctx.storage.private.set(key, value)
ctx.storage.private.delete(key)
ctx.transfer(receiverAccount, amount)
ctx.message(clientId, value)
ctx.invoke(boxId, method, input)       // durable Task
ctx.instantiate(definitionId, options) // durable Task
ctx.publish(kind, arguments)           // durable Task
ctx.request(request)                    // durable Task
```

`transfer` commits in the current turn. `message` returns a message ID and is
accepted in the current turn, but delivery happens only after that turn commits.
An unavailable or broken client never rolls back the turn. An HTTP invocation
that emitted messages includes `deliveries: [{ id, clientId, delivered }]` in
its result; `delivered` means at least one live event stream accepted the
message, not that a human read it.

`invoke`, `instantiate`, `publish`, and `request` return frozen runtime-owned durable Tasks, not
native Promises. A method or continuation may return a pure value for immediate
completion or a Task for eventual completion. Returning a Task makes the current
invocation adopt its outcome. Tasks support:

```js
task.then(successCallback, callbackContext)
task.catch(failureCallback, callbackContext)
```

Both return another Task. Continuations run later as fresh atomic turns on their
origin box. They may return a pure value or another Task; throwing rejects the
next Task. Tasks cannot be stored, messaged, or passed as box input. There is no
`.finally`, native Promise, `async`, or `await`.

Continuation source is captured with the trusted
`Function.prototype.toString.call(callback)`, parsed with the method parser, and
persisted. A continuation cannot capture method locals. Put everything it needs
in explicit callback context:

```js
return ctx.invoke(input.target, "read", input.query).then(
  function completed(result, saved) {
    ctx.storage.private.set(saved.key, result);
    return result;
  },
  { key: input.key }
);
```

This is invalid because `key` is a free variable:

```js
let key = input.key;
return ctx.invoke(input.target, "read", null).then(
  function completed(result) {
    ctx.storage.private.set(key, result);
    return result;
  }
);
```

### Instantiating a box

```js
return ctx.instantiate(input.definitionId, {
  nonce: input.nonce,
  initialPublic: { owner: ctx.account },
  initialPrivate: { configuration: input.configuration }
}).then(function created(result) {
  return result.id;
});
```

The creator and definition are immutable metadata, available through `ctx.box`.
Methods remain responsible for authorization; creator status does not
implicitly prevent other accounts from invoking an instance.

### Publishing from a box

```js
return ctx.publish("blob", {
  text: "...",
  contentType: "text/plain"
}).then(function published(result) {
  return result.id;
});

ctx.publish("page", { blobId: "..." });
ctx.publish("box", { methods: { run: "return input;" } });
ctx.publish("account", { pubkey: "..." });
```

A successful publication Task settles with `{ id }`. An effect is still durable
when its Task is not returned or observed, allowing explicit fire-and-forget
publication.

### Public HTTPS requests from a box

`ctx.request` declares a durable, non-streaming HTTPS request. It is deliberately
not raw `fetch`: the structure admits only public HTTPS JSON API requests.

```js
return ctx.request({
  host: "api.example.com",
  path: "/v1/messages?format=json",
  method: "POST",
  headers: { Authorization: "Bearer " + input.token },
  body: { message: input.message }
}).then(function completed(response, saved) {
  if (response.ok) ctx.storage.private.set(saved.key, response.body);
  else ctx.message(saved.clientId, { error: response.error || response.body });
  return response;
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

The request Task settles with
`{ ok, requestId, status, contentType, body }` for an HTTP response or
`{ ok: false, requestId, error }` for a transport failure. JSON responses become
pure BoxOS values; other response bodies are strings. As with all external POST
requests, a crash after remote acceptance but before durable settlement can
cause a retry. Use an upstream idempotency key when available.

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
GET /developers
GET /client.js
GET /boxos-cli.js
GET /boxos
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

If the method returns a durable Task, this is the outcome of the complete Task
chain rather than only the initial synchronous turn. Disconnecting does not
cancel it. Retrying the exact signed request observes the same idempotent
invocation instead of starting another one.

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
{ "type": "instantiateBox", "definitionId": "<box-definition-id>", "nonce": "<unique nonce>", "initialPublic": {}, "initialPrivate": {} }
```

A direct `message` operation returns `{ id, delivered }`. It commits acceptance
before attempting best-effort delivery, so `delivered: false` is a successful
operation when the client is offline.

The CLI performs this sequence for `page publish`: it transitively publishes
`BOXOS_BOX` dependencies, substitutes their IDs, publishes the linked HTML blob,
publishes the page, and prints its subdomain URL. A client using direct HTTP
operations performs those same steps explicitly.

### Client events

Messages use authenticated Server-Sent Events over a streaming POST, not a
WebSocket and not the browser `EventSource` constructor. Delivery is transient
and best effort: messages are not queued for offline clients, and delivery
failure cannot abort the committed box turn or direct operation.

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
await boxos.instantiateBox(definitionId, { initialPublic, initialPrivate });
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

## Authentication and the reference Accounts flow

BoxOS itself authenticates **accounts**, not people: an account is controlled by
an Ed25519 private key, and every mutating request is authorized by its
signature. A page automatically receives its own origin-scoped page account
from `/client.js`; this is often enough for an app that only needs to identify
its installation or authorize its own boxes.

The startup Accounts app provides one useful, optional convention for apps that
need authority from a human account. It is a reference implementation, not an
enforced application structure. An app may instead use its own account picker,
its own box-defined login flow, terminal keys, guest access, or another
application-specific identity model. The protocol only requires signed
accounts; authorization policy belongs in the target box.

### Optional human-account capability flow

Use this flow when an app wants a human to approve named capabilities:

1. Read `/v1/startup` and discover `accounts.page`, `accounts.grants`, and any
   other startup dependencies. Do not hard-code their IDs.
2. Redirect the browser to the discovered Accounts page with:

   ```text
   app_name=<displayed app name>
   app_account=<requesting page account>
   permissions=<comma-separated capabilities>
   redirect_uri=<HTTP(S) return URL>
   state=<unguessable state>
   ```
3. On return, validate the URL fragment and verify that `state` exactly matches
   the value issued by the app. The fragment contains either
   `error=access_denied`, or:

   ```text
   account=<selected human account>
   state=<original state>
   grants_box=<box ID>
   profiles_box=<box ID>
   ```
4. Treat the returned human account as the account whose authority was
   delegated; the app still signs requests with its page account. Pass the
   selected account and the relevant capability to a box method, which must
   perform the durable grant check.

In the startup reference implementation, a grant is public storage in the
grants box under:

```text
<owner-account>|<grantee-page-account>|<permission>
```

That key format, the grants box, and the permission names are conventions of
the example—not BoxOS-wide requirements. Do not assume that a page has a human
account, that a grant exists, or that a particular capability is available;
handle denial and unavailable startup deployments explicitly.

The startup Profiles box stores only public profile names. In that example, an
app granted `manage account` can call:

```json
{
  "method": "setName",
  "input": {
    "account": "<human-account>",
    "name": "New name"
  }
}
```

The box durably checks the grant and returns `{ "name": "New name" }`. Read the
current name from `name|<human-account>`. The Accounts app sets the initial name
during creation but does not expose profile renaming.

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
