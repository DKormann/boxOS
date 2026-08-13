# Tasks and effects

## Ownership invariant

> Every asynchronous effect originates from a BOXOS capability and belongs to exactly one invocation.

BOXOS must not attempt to infer ownership by inspecting a Web Worker event queue. Web Workers do not expose queued events, Promise reactions, unresolved promises, or microtasks to their host.

Instead, the restricted runtime prevents meaningful asynchronous work from originating anywhere except BOXOS capabilities.

## BOXOS Tasks

An asynchronous capability returns a BOXOS-owned `Task`, not a native JavaScript `Promise`.

A Task is thenable so method code can use familiar forms:

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

Task callbacks and derived Tasks retain the same invocation owner.

The restricted runtime must not expose uncontrolled asynchronous sources such as:

- global `Promise` or `new Promise`;
- native `fetch`;
- timers;
- event listeners;
- message channels;
- ambient network or filesystem APIs.

Whether user-declared `async function` helpers can be supported without weakening ownership remains a language decision. The initial design should prohibit them unless the runtime can preserve Task identity structurally.

## Laziness

Tasks should be lazy. Creating a Task describes work; joining it starts the work.

```js
let operation = ctx.request(input.url); // not started
let response = await operation;         // started and joined
```

A Task becomes joined by being:

- awaited;
- returned as the invocation's root result;
- consumed by a BOXOS task combinator;
- chained into a joined Task.

An unjoined Task must not perform its effect. Statically obvious abandoned Tasks should be rejected by validation where practical; otherwise they remain inert.

This intentionally differs from eager native Promise semantics.

## Invocation task tree

An invocation is the root structured-concurrency scope:

```text
root invocation
└── request Task
    └── callback Task
        └── child box-call Task
```

The invocation completes when its returned root value or root Task completes and no joined child remains unsettled.

BOXOS owns:

- task lifetime;
- callback scheduling;
- bounded resource allocation;
- timeouts;
- cancellation attempts;
- child failure propagation;
- final result reporting.

A task cannot outlive its owning invocation accidentally.

## Request capability

The external HTTP capability is called `ctx.request`, not `ctx.fetch`.

`fetch` would imply the browser Fetch API, native Promise eagerness, streams, and browser objects. `request` is a bounded BOXOS capability with serializable inputs and outputs.

Conceptually:

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

The request specification must later define URL schemes, methods, redirects, filtered headers, network policy, timeouts, request limits, response limits, and cancellation behavior. Native `Request`, `Response`, and stream objects are not exposed.

## Composition

Task callback operations such as `.then`, `.catch`, and `.finally` may be supported if their callbacks and derived Tasks remain owned.

Parallelism is explicit through a BOXOS combinator:

```js
let responses = await ctx.all([
  ctx.request(input.left),
  ctx.request(input.right)
]);
```

A combinator must define bounded concurrency, error ordering, fuel reservation, and cancellation precisely.

## External effects are not transactional

Owning a Task does not make the external world atomic. A remote system may process a request even if BOXOS later crashes or attempts cancellation.

BOXOS can own execution lifetime, accounting, cancellation attempts, and completion reporting. Exactly-once external behavior requires cooperation such as idempotency keys.

## Detached work

An unreturned Task is not a background job. Intentional work that survives its initiating invocation requires a separate durable messaging primitive. That primitive is not yet specified and must define persistence, acknowledgement, retries, idempotency, expiry, failure visibility, and fuel sponsorship explicitly.
