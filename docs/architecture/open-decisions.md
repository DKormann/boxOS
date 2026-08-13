# Open decisions

This file prevents provisional ideas from being mistaken for agreed architecture.

## Architecture

### Box identity

The method table is immutable and belongs in the box identity. It remains undecided whether two creations with identical definitions identify one box or whether a creation salt permits independent state namespaces with identical behavior.

### Box creation

The canonical definition format, validation command, creator authority, initial state, and fuel cost are not specified.

### Self-reference and dependency cycles

A method may need to know its own box ID, but deriving an ID from a table containing that ID is circular. References between newly defined boxes present the same issue. The model needs an explicit rule rather than ad hoc placeholders.

### Public state reads

Public state exists, but consistency guarantees, authentication, response limits, caching, and whether reads consume fuel remain open.

### Durable messaging

Owned Tasks cannot outlive an invocation accidentally. A first-class durable `send` capability may be needed, but its persistence, delivery, retry, idempotency, failure, and fuel semantics are not designed.

### Account replay protection

Accounts need replay state. A strict monotonic nonce is minimal but complicates concurrent client commands. Alternatives such as bounded nonce windows or unique command IDs require comparison.

### Network domain

Signed kernel commands must be bound to an intended BOXOS network or deployment. The identity and migration implications of that domain are unresolved.

### Failure charging

The treatment of unused purse fuel after application errors, timeouts, cancellation, runtime crashes, and transaction failure is not yet agreed.

## Language specification

The language is the next major design phase. It must define:

- source grammar and runtime versioning;
- method arguments, result, and context bindings;
- the exact BOXOS value domain;
- canonical serialization and size/depth limits;
- `ctx.atomic` callback syntax and enforcement;
- state APIs and visibility;
- Task type and allowed callback operations;
- top-level `await`;
- whether user-declared async helpers exist;
- `ctx.request`, `ctx.call`, and `ctx.all` signatures;
- arbitrary signing and verification APIs;
- use of private keys held in box state;
- storage payer and refund selection;
- errors and catchability;
- deterministic computation primitives;
- recursion, call depth, memory, and execution limits;
- pure globally pinned helper libraries, if any;
- prohibition of ambient authority and native async sources.

## Protocol and SDK

The architecture intentionally does not yet settle:

- hash and signature algorithms;
- canonical command encoding;
- HTTP route names;
- client key-storage policy;
- wire error format;
- streaming;
- retry helpers;
- method discovery and inspection APIs.

The ergonomic SDK may expose `invoke(box, method, privateKey, maxFuel, args)`, but the private key must remain client-side and the wire protocol must carry a signed command rather than the key.

## Physical implementation

The following must remain implementation choices:

- one SQLite file per box versus shared SQLite shards;
- worker and database connection placement;
- per-box queue implementation;
- caching and activation;
- migration between physical stores;
- optimistic versus directly serialized atomic execution;
- replication.

No method should be able to detect or depend on these choices.

## Questions to answer before rewriting

1. What exact object is hashed to form a box ID?
2. Can identical definitions create independent boxes?
3. How is initial box state established atomically?
4. What is the exact value and error model?
5. What source language makes Tasks and synchronous atomic blocks enforceable and pleasant?
6. What replay scheme supports concurrent signed commands safely?
7. How does a box use a private key without accidentally exposing it as an ordinary return value or request argument?
8. Which fuel costs are protocol semantics and which are deployment pricing?
9. How are methods admitted, queued, timed out, and cancelled?
10. Is durable messaging necessary in the first rewrite?
