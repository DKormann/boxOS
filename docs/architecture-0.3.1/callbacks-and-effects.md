# Durable callbacks and effects

## Continuation model

All effects are declared with optional success and failure callbacks. Registration is synchronous within the current atomic turn. Completion happens in a later turn.

There are no Tasks, promises, `await`, result handles, or suspended JavaScript continuations.

Conceptual box invocation:

```js
ctx.invoke(target, "work", input, {
  fuel: 500,
  success: function completed(result, context) {
    ctx.state.private.set(context.key, {
      status: "complete",
      result: result
    });
  },
  failure: function failed(error, context) {
    ctx.state.private.set(context.key, {
      status: "failed",
      error: error
    });
  },
  context: { key: input.key }
});
```

`ctx.invoke` returns no eventual-result object. Its declaration is accepted only if the containing turn commits.

## Callback serialization

At effect registration, the trusted runtime serializes each callback with:

```js
Function.prototype.toString.call(callback)
```

It must use a runtime-captured intrinsic, never a user-overridable `callback.toString()` property.

The resulting source is parsed and validated as a standalone callback under the current BOXOS runtime. Native, bound, proxied, dynamically constructed, or unsupported functions are rejected.

The provider persists:

```text
exact callback source
runtime version
origin box
success or failure role
explicit context
child relationship
```

It does not persist the function object, lexical environment, stack, heap, or instruction pointer.

## No captured outer variables

A durable callback may reference:

- its declared parameters;
- declarations within the callback;
- fixed runtime bindings such as `ctx`, `JSON`, and approved deterministic helpers.

It must not reference a binding from the initiating method:

```js
let key = input.key;

ctx.request(url, options, {
  success: function received(response) {
    // Invalid durable reference to outer `key`.
    ctx.state.private.set(key, response.body);
  }
});
```

Required data is copied explicitly as a BOXOS context value:

```js
ctx.request(url, options, {
  success: function received(response, context) {
    ctx.state.private.set(context.key, response.body);
  },
  context: { key: input.key },
  fuel: 500
});
```

Synchronous nested functions inside the durable callback may close over callback-local variables because they execute during the same atomic turn.

Validation occurs when the effect is actually declared. The parser does not need whole-method effect discovery or ahead-of-time callback-node assignment.

## Effect kinds

### Box invocation

```js
ctx.invoke(box, method, input, options);
```

Creates a child invocation on the target box. The target method is one atomic turn. Unused child fuel returns to the parent before its selected callback turn begins.

### HTTP request

```js
ctx.request(url, requestOptions, options);
```

Creates provider-executed bounded HTTP work. The response or error becomes callback input. Streaming, ambient cookies, implicit credentials, and unbounded bodies are absent.

### Timer

```js
ctx.schedule(time, options);
```

Persists a scheduled child event. At the chosen time it settles into its callback. A timer never suspends a method turn.

## Callback execution

A callback runs as a fresh atomic turn on its origin box with:

```text
fresh runtime heap
fresh ctx
child result or error
validated explicit context
parent invocation's current fuel balance
```

It may update state and declare more effects. This produces a durable continuation chain without preserving JavaScript execution.

## Success and failure

- Successful child work selects the success callback when present.
- Failed child work selects the failure callback when present.
- If the selected callback is absent, the outcome is discarded after accounting.
- If a callback throws, its turn rolls back and is marked failed.
- There is no implicit callback retry or second-order error callback.
- Already committed earlier turns remain committed.

## Registration atomicity

The child allocation, callback source, callback context, state mutations, and outbox declaration must commit together at the origin provider. A child must not be delivered from an aborted turn.

Cross-provider delivery and target execution are later events and are never part of the origin box transaction.
