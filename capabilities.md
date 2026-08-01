# boxOS capabilities and security model

## HTTP API

- `POST /challenge` returns a one-use proof-of-work challenge.
- `POST /proc` accepts `register`, `invoke`, or `inspect` operations.
- `POST /page` publishes or renews a content-addressed HTML page.
- `GET /example` serves a small browser client.
- `GET /client.js` serves the compiled browser ES module from `client.ts`.
- `GET /docs` serves unstyled client protocol documentation.
- `GET /stats` reports current prices, limits, worker usage, storage usage, and proof-of-work parameters.
- `GET /health` returns server health.

Every `/proc` request includes `fuel` (an integer from 1 to 100), the challenge, and a nonce. Request bodies are limited to 1 MB. Procedure source and namespaced state are persisted in SQLite at `BOXOS_DB_PATH` (default `boxos.sqlite`). Challenges and active-worker state are intentionally ephemeral.

Procedures are identified by the hexadecimal SHA-256 hash of their source code. Hosted pages use a 16-character lowercase Base32 prefix containing the first 80 SHA-256 bits. A collision is rejected and can never overwrite existing content; legacy 52-character page URLs remain readable.

## Proof of work and fuel

A client first requests a challenge, then finds a nonce for which:

```text
SHA-256(JSON.stringify([challenge, fuel, operationCommitment, nonce]))
```

has at least `8 + ceil(log2(fuel))` leading zero bits. Challenges expire after 60 seconds and are consumed after one attempt. Expected client work therefore grows approximately in proportion to requested fuel.

Fuel is capped at 100 units. Proof of work raises the cost of request floods, but does not replace rate limiting.

Resource prices are deliberately simple:

- At most four invocation workers may run at once.
- Each client-selected shard has one exclusive lock. Invocations on the same shard run serially; different shards may run in parallel.
- Fuel starts being consumed while waiting for a shard lock or worker slot.
- Worker creation costs `5 × (active workers + 1)` fuel, so it becomes more expensive near the worker limit. The remaining fuel is the invocation's wall-clock budget.
- Every storage write costs at least one fuel. Cost grows with entry size and rises from 1× to 4× as the 32 MB global store fills.
- Deleting an existing value earns its calculated storage cost as additional invocation fuel and can extend the deadline. Writing the same amount back consumes that fuel again.
- Registration pays the same storage price. Inspection does not consume storage fuel.

Fuel is wall-clock based and includes worker startup. Storage charges shorten the current invocation deadline. Registration and inspection normally request only the fuel they need.

## Static page hosting

A page is one immutable UTF-8 HTML document of at most 32 KiB, hosted at `https://<hash>.pages.boxos.org/`. Pages have full JavaScript and ordinary browser capabilities. Each hash receives a distinct hostname; page hosts do not expose API routes.

Publication requires 100 fuel and five extra proof-of-work difficulty bits. Leases last seven days. Republishing identical HTML renews the same hash and extends its lease. Responses use `nosniff`, `noindex, nofollow`, an ETag, and a one-hour public cache lifetime.

The hash covers only the stored HTML, not external resources loaded by that HTML. Full JavaScript pages can display abusive content or load changing external code; takedown blocking and operational abuse handling remain required.

## Procedure capabilities

The validated JavaScript subset supports basic declarations, functions, control flow, literals, operators, calls, fixed property access, guarded numeric indexing, and throwing expressions. Only declared names plus `ctx`, `arg`, and the frozen `JSON` and `Math` capabilities may be referenced.

`arg` is the supplied string. `JSON` provides only `parse` and `stringify`. `Math` provides explicitly allowlisted constants and deterministic numeric functions; `Math.random` is unavailable. `ctx` provides:

- storage namespaced by both current shard and procedure hash: `store`, `load`, `delete`, and `has`
- nested procedure invocation on the current shard with `invoke`
- SHA-256 procedure hashing and parser validation
- `string`, `number`, `boolean`, `record`, `struct`, `constant`, and `union` helpers

Dynamic string indexing, dangerous prototype properties, reserved bindings, classes, `new`, `this`, imports, async code, and direct ambient globals are rejected.

## Security assumptions and conditional guarantees

Assuming all of the following are true:

1. The parser perfectly rejects every program outside its intended subset.
2. JavaScriptCore and Bun have no relevant implementation vulnerabilities.
3. The property restrictions prevent access to constructors, prototypes, ambient globals, or equivalent escape paths.
4. Every object and function exposed through `ctx` behaves as documented and does not leak additional capabilities.
5. SHA-256 remains collision and preimage resistant.
6. Worker termination operates correctly.

Then procedure code is confined to pure computation, its argument, the explicit `ctx` capabilities, and storage namespaced by its current shard and procedure hash. It may invoke another procedure, but that call remains in the same worker and shard; the callee receives its own procedure-specific storage namespace. It cannot select or access another shard, or directly access the filesystem, network, subprocesses, environment, or server globals. Only one worker at a time receives a given shard's state. A timed-out invocation cannot commit its partial storage operation log.

These are conditional guarantees, not a proof that the assumptions hold. The parser, property rules, runtime, and `ctx` implementation are all part of the trusted computing base.

## Security limits

- Bun Web Workers share the server process. `smol` reduces heap use but is not a hard memory limit; memory exhaustion may terminate the server.
- Fuel measures elapsed time and coarse storage charges, not deterministic instructions.
- Proof of work can be parallelized, does not identify clients, and does not stop distributed attackers or requests to the cheap `/challenge` endpoint.
- There is intentionally no authentication or user ownership. There is no rate limit; concurrency is capped at four workers and persistent SQLite storage at 32 MB.
- Workers open SQLite read-only and fetch procedure source and current-shard state on demand. Writes remain in a worker-local overlay until the parent commits a successful call tree.
- A complete top-level and nested call tree commits its operation log in one SQLite transaction only on success. Exceptions, nested-call errors, serialization failures, timeouts, and worker failures discard every pending write.
- The in-process cache assumes one server process owns the SQLite database; multiple replicas must not share the same database file.
- Anyone who knows a procedure hash can invoke or inspect its source.
- A parser or capability escape could expose powerful Bun worker globals. Worker isolation is not a hardened process or OS sandbox.

Public deployment should add external rate limiting and execution in a non-privileged subprocess or container with OS-enforced CPU, memory, filesystem, and network restrictions. Anonymous access is intentional, so proof of work and resource limits remain the abuse controls rather than authentication.
