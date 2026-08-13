# Tasks and effects

## Ownership invariant

> Every asynchronous effect originates from a BOXOS capability and belongs to exactly one invocation.

BOXOS must not infer ownership by inspecting a Web Worker event queue. Web Workers expose neither queued events nor Promise reactions, unresolved promises, or microtasks to their host.

Instead, the restricted runtime prevents meaningful asynchronous work from originating anywhere except BOXOS capabilities and tracks every Task those capabilities create.

## BOXOS Tasks

An asynchronous capability returns a BOXOS-owned `Task`, not a native JavaScript `Promise`.

A Task is thenable, so method code can use `await` and callback composition:

```js
let response = await ctx.request(input.url);
```

```js
return ctx.request(input.url).then(function save(response) {
  return ctx.atomic(function update(tx) {
    tx.state.private.set("response", response.body);
    return response.status;
  });
});
```

Tasks are eager: creating an effect Task starts its operation and registers it with the current invocation.

```js
let left = ctx.request(input.left);   // starts
let right = ctx.request(input.right); // starts concurrently
let a = await left;
let b = await right;
return [a, b];
```

Concurrency here does not imply a shared multithreaded method heap. Host effects may be in flight together, while method continuations remain scheduled by the runtime.

## Controlled asynchronous surface

The restricted runtime must not expose uncontrolled asynchronous sources:

- global `Promise` or `new Promise`;
- native `fetch`;
- timers;
- event listeners;
- message channels;
- workers;
- ambient network or filesystem APIs.

The runtime may use native promises internally, but method code must never obtain one.

User-declared `async function` helpers are excluded from the first language because JavaScript would make them produce native promises. They may be added later only if they can preserve BOXOS Task identity structurally.

## Invocation scope

An invocation is the root structured-concurrency scope:

```text
root invocation
├── method body
├── request Task
│   └── callback Task
└── child box-call Task
```

Every Task created by a capability and every Task derived through a callback is registered with that scope. A callback returning another BOXOS Task adopts it into the same scope.

Returning from the method body produces a candidate result. The invocation does not complete, expose that result, release its execution slot, or refund fuel until every owned Task has settled.

Task settlement and method result are deliberately separate. BOXOS waits for every Task so it can stop execution and settle fuel cleanly, but it does not treat an otherwise unobserved Task rejection as an invocation failure. Method code is responsible for handling failures it cares about.

Consequently, this is concurrent but not detached work:

```js
ctx.request(input.url).then(save);
return "done";
```

BOXOS waits for the request and `save` before completing the invocation. If that chain rejects and the method does not await, return, or otherwise observe it, the rejection does not replace the candidate result. The Task simply settles rejected.

A rejection affects the method only through ordinary explicit control flow:

- awaiting a rejected Task throws at the await point;
- returning a rejected Task makes the method's candidate result reject;
- a rejection callback may recover or throw another error;
- an unobserved rejected Task has no effect beyond its consumed resources and any effects already performed.

The runtime does not need an "unhandled rejection" policy.

BOXOS owns:

- task lifetime;
- callback scheduling;
- fuel accounting;
- deadlines and task-count limits;
- cancellation attempts;
- Task settlement;
- final completion reporting.

A Task cannot accidentally outlive its invocation.

## Callback composition

Runtime 1 should support:

```text
Task.then(onFulfilled, onRejected)
Task.catch(onRejected)
await Task
```

Callback behavior follows the familiar useful subset:

- fulfillment runs `onFulfilled`;
- rejection runs `onRejected` when supplied;
- throwing rejects the derived Task;
- returning a BOXOS value fulfills the derived Task;
- returning another BOXOS Task adopts it;
- returning an invalid value rejects the derived Task.

`.finally` and native Promise combinators are excluded initially. Parallelism already follows naturally from eager creation of multiple Tasks. A later `ctx.all` may provide explicit group failure and cancellation semantics, but it is not required for basic concurrency.

Supporting callbacks in the Task runtime avoids making security depend on parser-level dataflow proofs that every Task is directly awaited or returned.

## Atomic boundary

Tasks and effects are forbidden inside `ctx.atomic`.

The runtime must enforce this dynamically:

- an effect capability called during an atomic callback rejects the block;
- an atomic callback returning a Task rejects the block;
- no callback continuation runs as part of an open atomic block.

The validator should reject obvious violations for better errors, but runtime correctness must not depend on complete static effect analysis.

A Task callback may enter a new atomic block after the effect settles:

```js
ctx.request(input.url).then(function save(response) {
  return ctx.atomic(function update(tx) {
    tx.state.public.set("response", response.body);
  });
});
```

That block is an independent committed transition. A later Task failure does not roll it back.

## Request capability

The external HTTP capability is called `ctx.request`, not `ctx.fetch`.

`fetch` would imply the browser Fetch API, streams, browser objects, and native Promise behavior. `request` is a bounded BOXOS capability with serializable inputs and outputs.

```js
let response = await ctx.request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input)
});
```

The result is a plain BOXOS value:

```json
{
  "status": 200,
  "ok": true,
  "headers": { "content-type": "application/json" },
  "body": "..."
}
```

The request specification must define URL schemes, methods, redirects, filtered headers, network policy, timeouts, request limits, response limits, and cancellation behavior. Native `Request`, `Response`, and stream objects are not exposed.

## Cancellation and external effects

If an invocation fails, reaches its deadline, or exhausts fuel, BOXOS attempts to cancel unsettled Tasks and prevents further callback execution where possible.

Cancellation cannot undo the external world. A remote system may process a request even if BOXOS later fails or cancels its local Task. Exactly-once external behavior requires cooperation such as idempotency keys.

## Detached work

An unreturned Task is still owned work, not a background job. Intentional work that survives its initiating invocation requires a separate durable messaging primitive. That primitive is not yet specified and must define persistence, acknowledgement, retries, idempotency, expiry, failure visibility, and independent fuel sponsorship.
