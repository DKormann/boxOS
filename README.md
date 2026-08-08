# BOXOS

A minimal, content-addressed lambda server built only with Bun and TypeScript.

```sh
bun run server.ts
```

Code is a restricted JavaScript **function body**. Its identifier is the lowercase SHA-256 digest of the exact source string.

## API

- `GET /docs` serves the complete architecture proposal as a static HTML page.
- `GET /client.js` serves a dependency-free browser ES module.

```js
import { BoxOSClient } from "https://your-boxos.example/client.js";
const boxos = new BoxOSClient();
const result = await boxos.runReducer('return input + 1;', 41);
console.log(result.ok); // 42

const page = await boxos.publishPage("<!doctype html><title>Hello</title>");
console.log(page.url);
```

### Register code

```http
POST /reducers
content-type: application/json

{"code":"let n = ctx.state.private.get(\"n\") || 0; n += input; ctx.state.private.set(\"n\", n); ctx.state.public.set(\"total\", n); return n;"}
```

Use `POST /procedures` for a procedure, or `POST /code` with a `kind` field. The response contains `hash`, `kind`, and `created`. `GET /code/:hash` publicly returns immutable source.

Reducers receive `ctx` and `input`. Both `ctx.state.private` and `ctx.state.public` provide `get`, `has`, `set`, and `delete`. The two versions of a key are distinct. Private state is visible only to its reducer; public state is also readable at `GET /state/:reducerHash/:key` or with `client.publicState(hash, key)`. A reducer invocation is one transaction.

Procedures receive `ctx` and `input`; `ctx.fetch` returns `{ status, ok, headers, body }`. A procedure can atomically compose reducers:

```js
function update(tx) {
  let first = tx.invoke("<reducer hash>", input);
  return tx.invoke("<another reducer hash>", first);
}
return await ctx.transaction(update);
```

### Invoke code

```http
POST /invoke/:hash
content-type: application/json

{"input": 2, "fuel": 1000}
```

Alternatively post `{ "hash": "...", "input": ..., "fuel": 1000 }` to `/invoke`. Fuel is a wall-clock millisecond budget (maximum 10,000); the response reports used and budgeted fuel. Errors and timeouts roll back open transactions.

State and source persist in `boxos.sqlite`; set `BOXOS_DB_PATH`, `HOST`, or `PORT` to override defaults.

## Static pages

BOXOS always registers a built-in page reducer. It stores an HTML string under a 16-character Base32 ID containing the first 80 bits of its SHA-256 hash. Collisions are rejected rather than overwritten. `GET /page` describes the reducer and `client.publishPage(html)` invokes it. Published pages are served directly, without authentication or read fuel, at:

```text
https://<16-character-id>.<server-host>/
```

On localhost, a page URL looks like `http://ndemumnbijffiay4.localhost:4000/`. Each page ID has its own browser origin. Pages are limited to 256 KiB and are served with immutable cache headers. Publication still pays normal invocation and permanent-storage fuel.

## Accounts and fuel

Authenticated requests use an anonymous 256-bit bearer identity. The first request creates its account with 2,000,000 fuel:

```js
console.log(await boxos.balance());
```

`GET /account` returns the caller ID and balance; `GET /stats` returns current prices and limits. Invocations reserve their requested fuel before execution. Successful calls refund unused runtime fuel. Timeouts, crashes, and all errors refund nothing.

Code and state cost 8 fuel per stored UTF-8 byte. State replacement repays the old entry and charges the new one. Deletion always repays the deleting caller. Storage charges and repayments appear in successful invocation responses.

## Runtime boundaries

The validator rejects ambient globals, dynamic property names, constructors, imports, classes, and prototype escape properties. Reducers cannot fetch or open transactions. Transactions are serialized and atomically persisted in SQLite. Lambdas execute in short-lived Bun workers; this is capability isolation, not an OS-process security boundary.
