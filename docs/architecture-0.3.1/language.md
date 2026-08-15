# Method language

## Goal

Runtime 0.3.1 is a deliberately small synchronous language resembling restricted JavaScript. Host JavaScript is an implementation tool, not ambient authority and not the semantic specification.

## Method shape

A method receives fixed bindings:

```text
ctx    current box, invocation, state, effects, and authenticated lineage
input  one BOXOS value
```

It returns one BOXOS value or throws an application error. The complete method is one atomic turn.

## Allowed direction

The initial language should include only:

- `let` and `const`;
- named synchronous function declarations;
- ordinary synchronous function expressions;
- local lexical closures;
- `if` and `else`;
- bounded `for` and `while` loops;
- `return` and `throw`;
- finite BOXOS literals, arrays, and plain objects;
- arithmetic, comparisons, and boolean operators;
- approved deterministic string, JSON, and math operations;
- direct state operations;
- synchronous effect declarations;
- signature verification and explicitly authorized signing.

Arrow functions, classes, generators, iterators, destructuring, spread, regular expressions, template literals, prototype access, dynamic property metaprogramming, imports, and dynamic code construction should remain absent initially.

## No asynchronous JavaScript

The language must reject or omit:

- `async function`;
- `await`;
- `Promise` and thenables;
- Tasks;
- `.then`, `.catch`, and `.finally` as asynchronous composition;
- event listeners;
- host timers;
- workers and shared memory;
- native network or filesystem APIs.

Future work is declared only through BOXOS effects carrying durable serialized callbacks.

## State

State is directly available because the entire turn is atomic:

```js
let value = ctx.state.private.get(input.key);
ctx.state.private.set(input.key, value + 1);
return value + 1;
```

There is no explicit atomic-block API and no state access outside a method or durable callback turn.

## Effects

Effects register future work synchronously:

```text
ctx.invoke(...)
ctx.request(...)
ctx.schedule(...)
```

They do not perform the external work before returning. They append validated declarations to the current transactional outbox. An effect declaration returns `undefined` initially.

Callbacks must be ordinary function objects whose trusted `Function.prototype.toString` output validates as independent method-like source. Callback context must be an explicit BOXOS value.

## Ambient authority

Method and callback code must not access:

- `globalThis`, process objects, environment variables, or host modules;
- native networking, files, databases, or cryptography;
- `eval`, `Function`, dynamic import, or mutable module state;
- constructors, prototypes, accessors, proxies, symbols, or reflection;
- host time, locale, or randomness except through explicit BOXOS effects.

Every identifier must resolve to a local declaration, a parameter, or a runtime-supplied binding.

## Runtime enforcement

The parser validates the restricted syntax and lexical names. The runtime still enforces capabilities:

- state belongs to the current box;
- outgoing declarations are buffered until commit;
- callback source is serialized with a trusted intrinsic and revalidated;
- all boundary values are copied and validated;
- fuel charges cannot exceed the invocation balance;
- no host asynchronous primitive is exposed;
- method execution ends before any child result exists.

## Still to specify

The implementation specification must settle exact grammar, errors, loop and recursion limits, source and heap limits, number behavior, Unicode behavior, callback signatures, HTTP schemas, deterministic helper APIs, signing APIs, and exact state namespace operations.
