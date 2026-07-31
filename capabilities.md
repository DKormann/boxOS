# boxOS capabilities and limits

## HTTP API

`POST /proc` accepts one JSON operation:

- `{"register":"<code>"}` validates and stores a procedure, returning its Adler-32 hash.
- `{"invoke":"<hash>","arg":"<string>"}` invokes a stored procedure.
- `{"inspect":"<hash>"}` returns stored top-level content. Keys containing `:` cannot be inspected.

Request bodies are limited to 1 MB. Other paths return 404 and non-POST requests return 405. Storage is in memory and is lost when the server stops.

## Procedure language

Procedures use a small, validated JavaScript subset with:

- `let`, `const`, named basic functions, blocks, `if`, `while`, and basic `for` loops
- `return`, `throw`, `break`, and `continue`
- primitive, array, and object literals
- arithmetic, comparison, logical, conditional, assignment, and update operators
- calls, fixed `value.field` access, and numeric `value[Number(expression)]` indexing
- only declared locals, function parameters, `ctx`, and `arg`

Dynamic string indexing, reserved binding names, dangerous prototype properties, classes, `new`, `this`, imports, async code, and direct ambient globals are rejected. Validation is a security filter, not a guarantee that accepted code is valid JavaScript.

## Runtime capabilities

`arg` is the supplied string. `ctx` provides:

- namespaced string storage: `store`, `load`, `delete`, and `has`
- nested procedure invocation with `invoke`
- procedure hashing and validation with `hash` and `validate`
- value/schema helpers: `string`, `number`, `boolean`, `record`, `struct`, `constant`, and `union`

Procedure storage keys are prefixed with the current procedure hash. Nested procedures receive their own namespace.

## Isolation and fuel

Each top-level invocation runs in a fresh Bun Web Worker in strict mode and receives a fixed 100 ms wall-clock budget. The worker is terminated when that budget expires. Timed-out invocations return a fuel-exhaustion error and do not commit partial storage writes.

Workers use Bun's `smol` heap profile, which reduces memory use but is **not a hard memory limit**. A worker still shares the server process; a hard memory boundary requires a subprocess or container with OS-level limits.

## Important limits

- Fuel is elapsed time, not deterministic instruction counting.
- Worker startup is included in the 100 ms budget.
- Concurrent storage updates are not transactional; completed operation logs are applied in completion order.
- Adler-32 is non-cryptographic and collision-prone, so hashes are not suitable for adversarial content addressing.
- There are no persistent-storage, authentication, authorization, rate, or total-storage quotas.
- The property denylist and exposed `ctx` API remain part of the security boundary; new capabilities require review.
- Worker isolation reduces risk from loops and recursion but is not equivalent to a hardened sandbox or process boundary.
