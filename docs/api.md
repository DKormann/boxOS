# BOXOS documentation

BOXOS stores restricted JavaScript by content hash and executes it with persistent reducer state. Production is available at `https://boxos.org`.

## Authentication and accounts

Registration and invocation require this header:

```http
Authorization: Bearer <43-character Base64URL identity>
```

The bearer value is a 256-bit secret. BOXOS stores only its SHA-256 user ID. The first authenticated request creates an account with 2,000,000 fuel.

```http
GET /account
```

Returns `{ user, balance }`. Losing the bearer secret loses the account; exposing it gives somebody else control of its fuel.

## Code

Code is a JavaScript function body. Its address is the 64-character lowercase hexadecimal SHA-256 hash of the exact source.

### Register

```http
POST /reducers
Content-Type: application/json
Authorization: Bearer ...

{"code":"return input;"}
```

Use `POST /procedures` for a procedure, or:

```http
POST /code

{"kind":"reducer","code":"return input;"}
```

The response contains `{ hash, kind, created, cost, balance }`. Registering source already present under the same kind is free.

### Inspect

```http
GET /code/<code-hash>
```

Returns `{ hash, kind, code }` for either a reducer or procedure. Source is immutable and publicly readable. Unknown hashes return `404`.

### Invoke

```http
POST /invoke/<code-hash>
Content-Type: application/json
Authorization: Bearer ...

{"input":{"message":"hello"},"fuel":1000}
```

Alternatively post `{ hash, input, fuel }` to `/invoke`. Input and results must be JSON. Fuel must be an integer from 1 through 10,000.

A successful response has this shape:

```json
{
  "ok": "result",
  "fuel": {
    "reserved": 1000,
    "used": 8,
    "refunded": 992,
    "storageCharged": 0,
    "storageRepaid": 0
  },
  "balance": 1999992
}
```

## Reducers

A reducer receives `ctx` and `input`. It executes transactionally and can access only its own state.

```js
let count = ctx.state.public.get("count") || 0;
count += 1;
ctx.state.public.set("count", count);
return count;
```

Available reducer capabilities:

- `ctx.caller`: SHA-256 user ID of the original caller.
- `ctx.sha256(string)`: full hexadecimal SHA-256 hash.
- `ctx.pageHash(string)`: 16-character page content ID.
- `ctx.state.private.get/has/set/delete(key, value)`.
- `ctx.state.public.get/has/set/delete(key, value)`.

Public and private versions of a key are separate slots. Only the owning reducer can write either slot. Private values are visible only to the reducer. Public values can also be inspected without authentication:

```http
GET /state/<reducer-hash>/<key>
```

This returns `{ hash, key, value }`. It does not invoke the reducer or consume runtime fuel.

## Procedures

A procedure receives `ctx` and `input`. It can fetch URLs and compose reducers.

```js
function update(tx) {
  return tx.invoke("<reducer-hash>", input);
}
return await ctx.transaction(update);
```

Available procedure capabilities:

- `ctx.caller`: original caller ID.
- `ctx.fetch(url, options)`: returns `{ status, ok, headers, body }`.
- `ctx.transaction(callback)`: opens a transaction.
- `tx.invoke(reducerHash, input)`: invokes a reducer inside that transaction.
- `ctx.validate(kind, code)`: validates reducer or procedure source without storing it.
- `ctx.publish(kind, code)`: validates and permanently registers source, charged to the original caller.

All reducer calls in one transaction share a snapshot and commit atomically. Reducers called by a procedure see the procedure's original caller. Publication is permanent and is not rolled back if the publishing procedure later fails.

BOXOS ships immutable validation and publication procedures. Their hashes are returned under `procedures` by `GET /stats`, allowing applications such as Studio to validate and publish code entirely through normal procedure invocation.

## Fuel and storage

- New account: 2,000,000 fuel, once.
- Runtime: one fuel per elapsed millisecond, rounded up.
- Maximum invocation reservation: 10,000 fuel.
- Permanent code and state: 8 fuel per stored UTF-8 byte.
- Maximum source: 128 KiB.
- Maximum state value: 256 KiB.

Invocation fuel is reserved before a worker starts. Successful execution refunds unused runtime fuel. Errors, timeouts, and worker crashes refund nothing.

Creating state charges for its key and serialized JSON value. Replacing state repays the old entry and charges the new entry. Deleting state always repays the deleting caller. Failed and rolled-back transactions do not receive storage repayments.

Current prices and limits are available from:

```http
GET /stats
```

## Static pages

BOXOS always registers a page reducer. Discover it with:

```http
GET /page
```

The response contains `{ reducer, maximumBytes, urlTemplate }`. Invoke that reducer with an HTML string, or use `client.publishPage(html)`. It stores the string in public state under a collision-checked 16-character ID derived from 80 bits of SHA-256.

Production page URL:

```text
https://<page-id>.pages.boxos.org/
```

Local page URL:

```text
http://<page-id>.localhost:4000/
```

Each page ID is a distinct browser origin. Its root path serves the immutable page without identity or fuel; ordinary API paths such as `/client.js`, `/invoke`, and `/state` work on that same origin for every page. Pages are limited to 256 KiB.

Inspect page HTML as JSON through its public state:

```http
GET /state/<page-reducer-hash>/<page-id>
```

Or request the page URL directly to render it.

## Browser client

The dependency-free ES module is served at:

```js
import { BoxOSClient } from "https://boxos.org/client.js";
const boxos = new BoxOSClient("https://boxos.org");
```

Main methods:

- `account()` and `balance()`
- `stats()`
- `validateCode(kind, code)` and `publishCode(kind, code)`
- `registerReducer(code)` and `registerProcedure(code)`
- `inspect(hash)`
- `publicState(reducerHash, key)`
- `invoke(hash, input, { fuel })`
- `runReducer(code, input, options)`
- `runProcedure(code, input, options)`
- `pageInfo()` and `publishPage(html, options)`

By default the client creates a bearer identity in the current browser origin's `localStorage`. Different page-ID origins therefore receive separate user accounts.

## Other routes

- `GET /`: project pitch.
- `GET /docs`: this document.
- `GET /proposal`: concise architecture whitepaper.
- `GET /example`: persistent counter demo.
- `GET /client.js`: browser client.
- `GET /health`: health check.
- `OPTIONS`: CORS preflight for API requests.
