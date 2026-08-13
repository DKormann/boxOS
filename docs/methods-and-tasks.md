# Unified methods, atomic state, and owned tasks

> This exploratory proposal is superseded by the structured draft in [`docs/architecture/`](architecture/README.md).

> Design proposal for BOXOS 0.2. Nothing here is a compatibility or durability commitment. The purpose of this phase is to find the smallest beautiful model, even when it breaks all existing code and data.

## Summary

BOXOS should have one kind of executable entry point: a **method**.

A method may perform ordinary synchronous computation, run explicit atomic state transitions, and coordinate asynchronous effects. There is no reducer/procedure distinction. Instead, the effect boundary is structural:

- state and same-partition calls happen inside a synchronous `ctx.atomic(...)` block;
- asynchronous effects produce BOXOS-owned `Task` values;
- one invocation owns the complete task tree it returns;
- detached work requires a separate durable messaging primitive.

```text
immutable blobs
      ↓
immutable method table
      ↓
     box ── isolated state
      │
      └── partition ── atomicity boundary

method invocation
├── synchronous computation
├── ctx.atomic(...) ── state and local calls
└── owned Task tree ── requests and asynchronous calls
```

## Content

BOXOS stores exact immutable bytes in one generic content-addressed store:

```text
put(bytes) → blob hash
get(hash) → bytes
```

A blob has no intrinsic type. It may contain method source, HTML, an image, a manifest, or any other bytes. Interpretation belongs to the immutable object that references the blob.

## Boxes and methods

A box binds an immutable, validated method table to isolated mutable state in one partition.

```json
{
  "partition": "<partition-id>",
  "methods": {
    "transfer": {
      "runtime": "boxos-js/1",
      "blob": "<content-hash>"
    },
    "syncSupplier": {
      "runtime": "boxos-js/1",
      "blob": "<content-hash>"
    }
  }
}
```

Each method references its own blob. The method table is immutable.

Before creating a box, BOXOS must:

1. canonicalize the complete definition;
2. load every referenced method blob;
3. validate each blob under its declared runtime;
4. reject unsupported runtimes, invalid names, duplicate entries, or invalid source;
5. derive the box address from the canonical validated definition.

A method table cannot be changed after box creation. New behavior means a new box definition.

For the current design, `(partition, method table)` is the complete box identity. BOXOS does not add an instance nonce merely to permit duplicate boxes with identical behavior in one partition. Stateful records normally belong inside a box. Independent state using the same methods can be obtained by using another partition if a real use case requires it.

## Partitions

A partition is the maximum atomicity domain.

> At most one atomic transition commits in a partition at a time. Different partitions never share a transaction.

Boxes in the same partition may call one another synchronously inside an atomic block and commit together. Different partitions can execute concurrently and communicate asynchronously.

A partition is a semantic placement and transaction boundary, not a permanent worker. Implementations may move a partition, lease it to a worker, replicate it, or change its physical storage without changing method semantics.

Cross-partition atomic transactions are intentionally unavailable. Cross-partition workflows use asynchronous calls, durable messages, idempotency keys, and compensating state transitions.

## One method model

Methods replace both reducers and procedures. A method may:

- compute synchronously;
- create and compose owned asynchronous tasks;
- issue controlled external requests;
- run one or more explicit atomic blocks;
- call methods in other partitions asynchronously.

Methods cannot access box state implicitly. State is available only through a synchronous atomic callback:

```js
let quote = await ctx.request(input.url);

return ctx.atomic(function update(tx) {
  let count = tx.state.public.get("orders") || 0;
  tx.state.public.set("orders", count + 1);
  return { status: quote.status, order: count + 1 };
});
```

This permits ordinary asynchronous orchestration without holding a transaction across an external effect.

## Atomic blocks

`ctx.atomic(callback)` runs a synchronous transaction in the invoking box's partition.

Inside the callback, `tx` provides:

- synchronous exact-key state access for the current box;
- synchronous calls to methods on boxes in the same partition;
- the verified invocation and authorization context;
- deterministic computation capabilities.

```js
return ctx.atomic(function transfer(tx) {
  let debit = tx.call(input.accounts, "debit", {
    account: input.from,
    amount: input.amount
  });
  tx.call(input.accounts, "credit", {
    account: input.to,
    amount: input.amount
  });
  tx.call(input.ledger, "record", debit);
  return debit;
});
```

All called boxes must belong to the same partition. The complete synchronous call graph commits or aborts as one transition.

An atomic callback must not:

- return or create a `Task`;
- use `await`;
- issue a request;
- call another partition;
- store a blob or create a box;
- schedule background work;
- access time, randomness, or any other nondeterministic capability.

State access remains deliberately small:

```text
get(key)
has(key)
set(key, value)
delete(key)
```

Public and private keys are separate access classes. Only the owning box may mutate either; public values are additionally readable through the public API.

## Why `ctx.request`, not `ctx.fetch`

The preferred name is `ctx.request`.

`fetch` implies the complete browser Fetch API and native Promise behavior. BOXOS intentionally provides neither. Its operation has a bounded, serializable request and response format, produces an owned BOXOS `Task`, applies platform limits, and participates in invocation cancellation and accounting.

Calling it `request` makes the capability boundary honest:

```js
let response = await ctx.request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input)
});
```

A response should be a plain BOXOS value, for example:

```json
{
  "status": 200,
  "ok": true,
  "headers": { "content-type": "application/json" },
  "body": "..."
}
```

The runtime must define request methods, redirect behavior, URL schemes, header filtering, timeouts, maximum request and response sizes, cancellation, and private-network policy. It should not expose native `Request`, `Response`, streams, or browser-global `fetch` objects.

## Tasks rather than native promises

Every asynchronous BOXOS capability returns a **Task**. A Task is a BOXOS-owned thenable, so it works with familiar `await` and callback composition while remaining visible to the runtime.

```js
let response = await ctx.request(input.url);
```

```js
return ctx.request(input.url).then(function save(response) {
  return ctx.atomic(function update(tx) {
    tx.state.private.set("last-response", response.body);
    return response.status;
  });
});
```

Tasks are not native JavaScript promises. The restricted runtime does not expose:

- global `Promise` or `new Promise`;
- user-created asynchronous primitives;
- timers;
- event listeners;
- message channels;
- ambient network APIs;
- user-declared `async function` helpers, initially.

This establishes the central invariant:

> Every asynchronous effect originates from a BOXOS capability and belongs to one invocation.

## Task ownership

A method invocation is the root structured-concurrency scope. Every Task has exactly one owning invocation and may have child tasks created by callbacks or combinators.

```text
invocation
└── request task
    ├── success callback task
    └── failure callback task
```

The invocation completes when its returned root task settles. BOXOS owns:

- task lifetime;
- cancellation attempts;
- timeout and fuel accounting;
- callback execution;
- child-task failure propagation;
- resource and response-size limits;
- final completion reporting.

The host does not inspect a worker's event or microtask queue. Web Workers expose no reliable queue-inspection API. Instead, the runtime prevents meaningful asynchronous work from entering the worker except through owned Tasks.

## Lazy tasks

BOXOS Tasks should be lazy: creating a Task describes an effect, while awaiting, returning, or explicitly joining it starts the effect.

```js
let request = ctx.request(input.url); // described, not started
let response = await request;         // joined and started
```

An unjoined task does not run:

```js
ctx.request(input.url);
return "done";
```

The request above should either be rejected during validation when statically obvious or remain inert at runtime. It must not become accidental detached work.

Lazy tasks differ from eager native promises. That difference is intentional and should be explicit in the language documentation.

## Composition and parallelism

Task callbacks remain owned:

```js
return ctx.request(input.url)
  .then(parseResponse)
  .then(storeResponse);
```

`.then`, `.catch`, and `.finally` return Tasks belonging to the same invocation.

Parallel work uses an explicit BOXOS combinator:

```js
let responses = await ctx.all([
  ctx.request(input.left),
  ctx.request(input.right)
]);
```

`ctx.all` starts its child tasks together, applies bounded concurrency, propagates failure, and cancels unfinished children where possible. Other combinators should be added only when their failure and cancellation semantics can be stated precisely.

## Detached and durable work

An unreturned Task is not a background job. Intentional detached work requires a separate durable messaging primitive, tentatively:

```js
await ctx.send(targetBox, "process", input, {
  idempotencyKey: input.id
});
```

A durable send must define:

- when the message is considered accepted;
- persistence before acknowledgement;
- target partition and method;
- retry and backoff policy;
- idempotency behavior;
- cancellation, expiry, and dead-letter behavior;
- where terminal failure becomes observable;
- who pays for storage and execution.

This primitive should not be designed by accidentally allowing promises to outlive their invocation.

## Failure and external atomicity

Task ownership does not make the external world transactional. A remote server may process a request even if BOXOS subsequently crashes or cancellation is attempted.

BOXOS can guarantee ownership of execution, accounting, cancellation attempts, and completion reporting. It cannot guarantee exactly-once external effects without cooperation from the remote system. Methods must use idempotency keys or compensation where this matters.

Atomic state blocks remain independent:

```js
ctx.atomic(markStarted);       // committed
let result = await ctx.request(url); // external effect
ctx.atomic(markComplete);      // independently committed
```

If the final block fails, the earlier block and external request are not rolled back.

## Abstract machine

The proposed foundational vocabulary is:

- **Blob:** exact immutable bytes addressed by content hash.
- **Box:** immutable validated method table plus isolated state in one partition.
- **Method:** the only executable entry point.
- **Partition:** placement and maximum atomicity domain.
- **Atomic block:** synchronous state transition and same-partition call graph.
- **Task:** lazy, owned asynchronous computation.
- **Request:** controlled external HTTP effect producing a Task.
- **Send:** explicit durable asynchronous message, if added.

The core statement is:

> BOXOS stores immutable blobs. A box binds immutable methods to isolated state in one partition. Methods coordinate owned tasks and perform state transitions through explicit synchronous atomic blocks. Atomic calls stay within one partition; cross-partition and external work is asynchronous and never implicitly transactional.

## Open decisions

Before implementation, the design still needs exact answers for:

1. canonical box-definition encoding and box-address derivation;
2. whether a box may reference itself or mutually reference another box definition;
3. atomic error handling and whether a caller may catch a failed local call;
4. reentrancy, recursion depth, call count, and fuel limits;
5. Task callback syntax supported by the restricted language;
6. whether lazy unjoined tasks are statically rejected or simply inert;
7. precise `ctx.all` cancellation and error ordering;
8. cross-partition call versus durable `send` semantics;
9. request security policy and response representation;
10. whether atomic execution uses serialized partition turns or optimistic commits internally;
11. exact BOXOS value-domain and canonical serialization rules;
12. authorization targets for boxes and individual methods.
