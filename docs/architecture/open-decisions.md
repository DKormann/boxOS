# Open decisions

This file prevents provisional ideas from being mistaken for agreed architecture.

## Architecture


### Self-reference and dependency cycles

A method may need to know its own box ID, but deriving an ID from a table containing that ID is circular. References between newly defined boxes present the same issue. The model needs an explicit rule rather than ad hoc placeholders.

### Durable messaging

Owned Tasks cannot outlive an invocation accidentally. A first-class durable `send` capability may be needed, but its persistence, delivery, retry, idempotency, failure, and fuel semantics are not designed.

### Network domain

Signed kernel commands must be bound to an intended BOXOS network or deployment. The identity and migration implications of that domain are unresolved.

### Metering prices

All terminal outcomes refund the reservation minus actual settled charges. The cost units and formulas for compute, requests, storage, calls, and failure cleanup remain unspecified.

### Page identifiers

Pages are fuel-charged hosted HTML blobs with short collision-checked IDs and isolated origins. The shortening length, alphabet, domain separation, hosting limits, and route shape remain implementation decisions.

## Language specification

The agreed direction is recorded in [Method language direction](language.md): a restricted JavaScript-like method body, eager invocation-owned Tasks, top-level `await`, `.then` and `.catch` callbacks, no native Promise or user-declared async functions, and synchronous explicit atomic blocks enforced by both validator and runtime.

The complete language still must define:

- source grammar;
- complete BOXOS value validation;
- JSON size and depth limits;
- errors, catchability, and returned-Task failure;
- object, array, number, Unicode, and string semantics;
- request and response schemas;
- APIs for keys, signing, transfer, and separately funded invocation;
- storage refund selection;
- deterministic computation primitives;
- recursion, loop, stack, heap, source, and execution limits;
- pure globally pinned helper libraries, if any.

## Protocol and SDK

The architecture intentionally does not yet settle:

- hash and signature algorithms;
- signed-command fields;
- client key-storage policy;
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

1. How is initial box state established atomically?
2. What complete grammar makes Tasks and synchronous atomic blocks enforceable and pleasant?
3. How does a box use a private key without accidentally exposing it as an ordinary return value or request argument?
4. Which fuel costs are protocol semantics and which are deployment pricing?
5. How are methods admitted, queued, timed out, and cancelled?
6. What happens when the method's returned Task rejects?
7. Is durable messaging necessary in the first rewrite?
8. Which page-hosting mechanism is smaller: a kernel handler or a built-in immutable box?
