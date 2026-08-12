# BOXOS agent guide

Use this guide when a user says: **“Go to boxos.org and develop an app.”**

> **BOXOS 0.2 has no durability or compatibility guarantees.** APIs, runtime semantics, hashes, state, accounts, pages, origins, and all hosted data may change or disappear without migration. Keep local copies of all source and data. Do not promise users that a current URL, account, reducer, or deployment will survive an update. The project is presently optimizing for design quality, not compatibility.

BOXOS apps are single, immutable HTML documents. They may call immutable backend reducers and procedures. Prefer the smallest design that works: one self-contained page, plus a reducer only when durable shared state is required.

## Fast path

1. Read `https://boxos.org/docs/api` when you need the full capability reference.
2. Inspect examples at `https://boxos.org/examples` or in the repository `examples/` directory.
3. Build a complete HTML file locally. Use normal browser HTML, CSS, and JavaScript.
4. If the app needs persistent state, register restricted reducer source first and place the returned hash in the HTML.
5. Publish the final HTML through the page reducer returned by `GET /page`.
6. Return the permanent page URL and retain the source files for future revisions.

Do not assume mutable deployments, server-side packages, environment variables, filesystem access, or hidden application configuration.

## HTTP publication recipe

All authenticated requests use a stable secret header:

```http
Authorization: Bearer <43-character Base64URL encoding of 32 random bytes>
```

Keep this deployment identity secret and reuse it when revising the app so its remaining fuel is not lost.

### 1. Register backend code, if needed

```http
POST https://boxos.org/reducers
Content-Type: application/json
Authorization: Bearer ...

{"code":"let n = await ctx.state.public.get(\"n\") || 0; n += 1; ctx.state.public.set(\"n\", n); return n;"}
```

The response includes `hash`. Source is addressed byte-for-byte, so preserve the exact registered string. Use `POST /procedures` instead only when network access or multi-reducer composition is required.

### 2. Discover page publication

```http
GET https://boxos.org/page
```

The response includes `reducer`, `maximumBytes`, and `urlTemplate`.

### 3. Publish the HTML

```http
POST https://boxos.org/invoke/<page-reducer-hash>
Content-Type: application/json
Authorization: Bearer ...

{"input":"<!doctype html>...","fuel":1000}
```

Replace `{id}` in `urlTemplate` with the response’s `ok` value. That is the app’s permanent URL.

## Page template

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>App name</title>
<style>
  :root { font: 16px/1.5 system-ui, sans-serif; color-scheme: light dark; }
  body { width: min(44rem, calc(100% - 2rem)); margin: 8vh auto; }
</style>
<main>
  <h1>App name</h1>
  <p id="status">Ready.</p>
</main>
<script type="module">
  import { BoxOSClient } from "/client.js";
  const boxos = new BoxOSClient();
  // const reducer = "<registered-reducer-hash>";
  // const result = await boxos.invoke(reducer, { action: "list" });
</script>
```

Keep the page self-contained when practical. Root-relative `/client.js` is correct on both `boxos.org` and immutable page origins.

## Restricted backend language

Reducer and procedure source is a function body, not a module. It supports basic declarations, named functions, conditionals, loops, `try`, JSON-compatible literals, arithmetic, and calls through explicit capabilities.

Available reducer bindings:

- `ctx.caller`
- `ctx.authorization`
- `ctx.sha256(string)` and `ctx.pageHash(string)`
- `await ctx.state.private.get/has(key)` and synchronous `set/delete(key, value)`
- `await ctx.state.public.get/has(key)` and synchronous `set/delete(key, value)`
- `input`, restricted `JSON`, deterministic `Math`, and `String`

Available procedure capabilities additionally include:

- `ctx.fetch(url, options)`
- `ctx.transaction(callback)` and asynchronous `tx.invoke(reducerHash, input)`
- `ctx.validate(kind, code)` and `ctx.publish(kind, code)`
- `ctx.verify(publicKey, message, signature)`
- top-level `await`

Not available: imports, classes, arrow functions, ambient globals, dynamic string-key indexing, constructors, prototypes, `eval`, timers, filesystem access, or package dependencies. Validate early by attempting registration; syntax failures return HTTP 422 with a location.

Array indexing must use the subset’s explicit form:

```js
let item = values[Number(i)];
values[Number(values.length)] = next;
```

## State and application design

- Public and private values with the same key are separate.
- Public state is readable at `GET /state/<reducer-hash>/<encoded-key>`.
- A reducer sees only its own state, even inside a procedure transaction.
- All reducer calls in one procedure transaction commit atomically.
- Never trust an account ID in input for authorization.
- For user-owned data, request a signed capability with `boxos.authorize(...)` and derive ownership from `ctx.authorization.account` inside the reducer.
- Within the current implementation, a page revision gets a new page ID and unchanged reducer source keeps its hash. This is not a 0.2 retention or compatibility guarantee.

## Quality checklist

Before returning the app:

- Verify the published URL loads on its page origin.
- Exercise every reducer action, including invalid input.
- Make loading, empty, error, and success states visible in the UI.
- Use semantic HTML and keyboard-accessible controls.
- Avoid exposing deployment bearer identities in HTML or source.
- Confirm all hashes in the final HTML are the published hashes.
- Report the page URL, page ID, backend hashes, and local source paths.
- Explain that revisions produce a new URL rather than replacing the current page.

## Useful endpoints

- `GET /page` — page reducer and URL template
- `POST /reducers` — register a reducer
- `POST /procedures` — register a procedure
- `POST /invoke/<hash>` — invoke code
- `GET /code/<hash>` — inspect immutable source
- `GET /state/<hash>/<key>` — read public state
- `POST /state` — batch public-state reads
- `GET /account` — deployment identity and fuel balance
- `GET /version` — BOXOS server/API and stored-code runtime versions
- `GET /stats` — versions plus current fuel, storage, transaction, and page limits
- `GET /client.js` — dependency-free browser client

Full documentation: `https://boxos.org/docs`
