# Method language direction

Status: agreed semantic constraints for the first language. The exact grammar and standard library still require a dedicated specification before implementation.

## Goal

The first BOXOS language should be deliberately restrictive. It is easier to make previously invalid source valid in a later runtime than to remove behavior on which valid source depends.

The security model must not rely on sophisticated whole-program analysis. The validator defines a small syntactic language, while runtime capabilities enforce effect ownership and atomic boundaries dynamically.

The language may resemble JavaScript, but it is not arbitrary JavaScript and must not inherit semantics merely because a host engine provides them.

## Method shape

A method is a function body with fixed bindings supplied by BOXOS:

```text
ctx   invocation capabilities and authenticated context
input one BOXOS value supplied as method arguments
```

A method returns a BOXOS value or a BOXOS Task that eventually produces one. Throwing produces an application failure.

Methods may perform:

- synchronous local computation;
- synchronous helper-function calls;
- explicit synchronous `ctx.atomic(...)` blocks;
- top-level `await` of BOXOS Tasks;
- callback composition over BOXOS Tasks.

There is no reducer/procedure declaration or method kind.

## Initial synchronous language

Runtime 1 should include only a small conventional core:

- `let` and `const` bindings;
- named synchronous function declarations;
- synchronous function expressions for callbacks;
- lexical closures local to one invocation;
- `if` and `else`;
- bounded `for` and `while` loops;
- `return` and `throw`;
- a minimal `try` and `catch` if error semantics are fully specified;
- BOXOS value literals;
- plain arrays and objects;
- arithmetic, comparisons, and boolean operators;
- explicitly exposed deterministic string, JSON, and math operations.

Arrow functions, classes, generators, iterators, destructuring, spread, regular expressions, dynamic property metaprogramming, and other convenience syntax should remain out until they have a clear need and complete semantics.

Mutable globals and module state are forbidden. Closures cannot outlive their invocation because every callback belongs to its invocation's Task scope.

## Asynchronous language

Runtime 1 supports eager BOXOS Tasks with:

```text
await task
Task.then(onFulfilled, onRejected)
Task.catch(onRejected)
```

This supports callbacks from the first implementation without requiring the parser to prove that every Task is directly awaited or returned.

```js
ctx.request(input.url)
  .then(function save(response) {
    return ctx.atomic(function update(tx) {
      tx.state.private.set("body", response.body);
      return response.status;
    });
  })
  .catch(function record(error) {
    return ctx.atomic(function update(tx) {
      tx.state.private.set("error", error.message);
      return null;
    });
  });

return "handled after all owned work settles";
```

The invocation remains active after the method body returns until this complete Task chain settles.

Top-level `await` is supported. User-declared `async function` is excluded initially because host JavaScript would make it create a native Promise. Task callbacks are synchronous functions that may return another BOXOS Task to continue asynchronously.

Initially exclude:

- global `Promise` and `new Promise`;
- `.finally`;
- native Promise combinators;
- timers and event APIs;
- arbitrary thenables;
- detached Tasks;
- user-defined asynchronous primitives.

The runtime, not parser dataflow analysis, tracks every Task created by a BOXOS capability or callback.

## Atomic language

State is accessible only inside:

```js
ctx.atomic(function update(tx) {
  // synchronous only
});
```

Inside the callback, `tx.state.private` and `tx.state.public` expose only:

```text
get(key)
has(key)
set(key, value)
delete(key)
```

An atomic callback cannot:

- use `await`;
- create, receive, or return a Task;
- call `ctx.request`;
- invoke another box;
- start another invocation;
- transfer fuel;
- sign using a stored private key;
- observe time or randomness;
- access any external or nondeterministic capability.

The validator should reject statically obvious violations. The runtime must also disable effect capabilities while an atomic callback runs and reject a Task result. Security must not depend on complete effect inference.

## Core effect capabilities

The first language should expose a small capability surface.

### Request

```js
ctx.request(url, options) -> Task<ResponseValue>
```

This is a bounded HTTP operation, not browser `fetch`.

### Continue current invocation

```js
ctx.call(box, method, input) -> Task<Value>
```

This starts an isolated child method invocation, preserves the root caller and immediate caller lineage, and spends from the current invocation's shared purse.

### Verify arbitrary signatures

```js
ctx.verify(publicKey, message, signature) -> boolean
```

This enables user-defined capabilities and signed application protocols. Canonical message encoding remains to be specified.

### Act as another account

A method holding a private key may sign arbitrary messages, transfer fuel, or start a separately funded invocation as that account. The exact API is not yet settled. It must make the distinction from `ctx.call` explicit:

```text
ctx.call(...)              continues current caller and purse
account.call(...)          starts another caller and purse
```

Private keys remain ordinary secret BOXOS values within the operator trust model; possessing one is complete account authority.

## Fuel visibility

Method code receives authenticated caller and invocation lineage, but should not initially receive the exact remaining purse balance. Runtime 1 purses are fixed and cannot be recharged.

A method may direct storage refunds to a public key through an atomic API to be specified. Storage growth otherwise spends from the current invocation purse. Another account pays by starting a separately funded invocation, not by changing the payer of running work.

Receipts expose actual spending to users after settlement.

## Forbidden ambient authority

Method code must not access:

- `globalThis`, host process objects, or environment variables;
- native network, filesystem, database, or cryptographic APIs;
- native Promise machinery;
- constructors or prototype mutation;
- `eval`, `Function`, dynamic imports, or modules not pinned in the box definition;
- workers, shared memory, atomics, or event-loop control;
- host time, locale, or randomness unless later provided as explicit effects.

Every binding must be local, declared, or supplied explicitly by BOXOS.

## Runtime enforcement over parser cleverness

The parser should answer only whether source belongs to the small language and whether locally obvious contextual restrictions hold. It should not be responsible for proving complete Task ownership or effect purity through arbitrary dataflow.

The runtime enforces the security properties:

- every asynchronous capability creates a tracked Task;
- every derived callback Task remains tracked;
- invocation completion waits for all owned Tasks;
- atomic execution disables effects;
- atomic callbacks cannot return Tasks;
- fuel and deadlines bound all execution;
- no invocation heap is shared with another invocation.

This division keeps the validator auditable and places lifecycle security in the component that owns lifecycle state.

## Still to specify

Before implementation, the language specification must settle:

1. complete grammar and lexical rules;
2. complete BOXOS value validation and JSON encoding;
3. object and array mutation semantics;
4. number semantics, including `NaN`, infinity, and negative zero;
5. Unicode and string semantics;
6. exact error values and catchability;
7. loop, recursion, stack, heap, and source limits;
8. callback arity and `this` behavior—preferably no dynamic `this`;
9. exact method-result behavior when the returned value is a Task;
10. request and response value schemas;
11. account signing, transfer, and separately funded call APIs;
12. storage refund-selection API;
13. pure pinned helper libraries, if any;
14. runtime versioning and conformance tests.
