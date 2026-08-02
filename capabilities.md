# boxOS capabilities and security model

## Model

Procedure source is globally content-addressed by SHA-256. One procedure hash has one global persistent keyspace shared by every caller. There are no shards or procedure instances.

Invocations execute as optimistic transactions. Workers record exact key versions read and keep writes in memory. The parent commits only if every version remains unchanged. Nested procedure calls share the same transaction. Conflicts, errors, invalid result serialization, timeouts, and worker failures commit nothing.

## Anonymous identities and fuel

A client identity is a 256-bit bearer secret. The server stores only its SHA-256 user ID and persistent fuel balance. Anyone may create an identity without registration, but possession of the bearer secret controls its balance.

Proof of work mints fuel. Expected proof work grows approximately linearly with the amount minted. The full requested invocation fuel is deducted before execution:

- Successful commits refund unused fuel.
- Committed deletions credit a storage reward after commit.
- Conflicts and all failed executions receive no refund.
- Speculative deletion credit may fund writes in that transaction but cannot extend runtime.

## HTTP API

- `POST /challenge`: one-use proof challenge.
- `GET /balance`: current bearer balance.
- `POST /fuel`: mint balance with proof of work.
- `POST /proc`: register, invoke, or inspect global procedures.
- `POST /page`: publish or renew a static HTML page.
- `GET /stats`: live prices, usage, and limits.
- `GET /client.js`: compiled browser client from `client.ts`.
- `GET /docs`: unstyled protocol documentation.
- `GET /example`: redirect to the content-addressed example.

The JSON API permits non-credentialed cross-origin access with the `authorization` and `content-type` headers.

## Procedure runtime

`arg` is a string. Explicit globals are `ctx`, frozen `JSON`, frozen deterministic `Math` without `random`, and callable `String`.

`ctx` provides:

- global procedure-local storage: `store`, `load`, `delete`, and `has`;
- nested transaction calls with `invoke`;
- procedure `hash` and parser `validate`;
- `string`, `number`, `boolean`, `record`, `struct`, `constant`, and `union` helpers.

The validated language includes common declarations, named functions, basic control flow, try/catch/finally, throwing, literals, basic operators, strict and coercing equality, calls, fixed properties, and guarded numeric indexing. Ambient globals, dynamic string indexing, constructors, imports, classes, async code, and dangerous prototype properties remain unavailable.

## Static pages

One immutable full-JavaScript HTML document of at most 32 KiB is hosted at `https://<hash>.pages.boxos.org/`. IDs contain the first 80 SHA-256 bits in 16 lowercase Base32 characters. Collisions are rejected. Leases last seven days and renewal costs the fixed publication balance shown by `/stats`.

Each hash has a separate browser origin. Page hosts never expose API routes. The hash covers only stored HTML, not external dependencies.

## Conditional guarantees

Assuming the parser is complete, capability wrappers do not leak ambient objects, Bun and JavaScriptCore have no relevant vulnerabilities, SHA-256 remains secure, and exactly one server process owns SQLite:

- procedure code can access only its argument, explicit capabilities, and procedure-local global state;
- nested calls commit atomically;
- successful OCC validation gives serializable exact-key transactions;
- failed or conflicted transactions cannot modify state;
- bearer balances cannot be spent without the bearer secret;
- worker code cannot directly write SQLite.

These are assumptions, not a formal proof. The parser, runtime, wrappers, scheduler, transaction validator, and SQLite integration are trusted.

## Limits

- Workers share the server process; `smol` and systemd memory limits are not a process sandbox.
- Optimistic contention can burn victim and attacker fuel and may starve hot keys.
- Bearer secrets can be stolen by malicious JavaScript or compromised client storage.
- Proof of work is parallelizable and does not stop distributed abuse.
- SQLite and in-process accounting assume a single server process.
- There is no user ownership of procedure state: anyone may invoke a known procedure.
- Hosted full-JavaScript pages require abuse reporting, hash blocking, bandwidth controls, and takedown operations.
