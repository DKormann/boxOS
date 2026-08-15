# Atomic turns and state

## One complete method is atomic

Every named method and every durable callback executes as one synchronous atomic turn on one box.

A turn may:

- read and mutate its box state;
- perform bounded synchronous computation;
- verify signatures;
- declare child invocations, HTTP requests, and timers;
- serialize success and failure callbacks;
- return or throw.

A turn may not wait for any external event.

## Commit boundary

During execution, the provider buffers:

```text
state mutations
storage accounting
outgoing child declarations
serialized callback source
explicit callback context
fuel allocations
method result
```

On successful return, these commit together. On throw, validation failure, or fuel exhaustion, box state and outgoing declarations roll back together.

Actual compute already performed may still be charged. Rollback means application state and effects were not committed; it does not mean consumed resources were free.

## Transactional outbox

Outgoing work is first recorded in the same provider-local transaction as box state:

```text
box transaction
  state changes
  outbox entries
```

Only committed outbox entries may be delivered. Delivery occurs after the local commit and is not part of a cross-machine database transaction.

For a server-hosted box, the server may store state, outbox, and ledger records in one physical transaction. For a client-hosted box, the provider is responsible for its local atomicity and honest settlement with the server.

## Serial order

Turns targeting one box must appear in one provider-defined serial order. A turn sees the state committed by all earlier turns and none of the uncommitted work of later turns.

This architecture does not require parallel execution within one box. Different boxes may execute concurrently because they share no transaction.

## State API

Because the whole turn is atomic, state does not require an explicit atomic callback:

```js
let count = ctx.state.private.get("count") || 0;
ctx.state.private.set("count", count + 1);
return count + 1;
```

Initial namespaces may remain:

```text
private  readable and writable only by box methods
public   publicly readable, writable only by box methods
shared   grant-readable, writable only by box methods
```

Exact-key operations are sufficient initially:

```text
get(key)
has(key)
set(key, value)
delete(key)
```

Enumeration, queries, secondary indexes, and transactions spanning boxes are absent.

## Meaning of atomic

The following may be three atomic turns:

```text
Box A start method
Box B child method
Box A completion callback
```

They are not one transaction. A committed earlier turn is never rolled back because a later child or callback fails.

The normative statement is:

> Every method and callback is atomic with respect to one box; an invocation workflow is not globally atomic.
