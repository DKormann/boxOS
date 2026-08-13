# Invocations and atomic state

## Invocation isolation

Invocations of methods on the same box may execute concurrently. They must not share a JavaScript heap or mutable globals.

Invocations may interact only through:

- committed box state;
- explicit method results and errors;
- asynchronous child calls.

Values in local variables, callbacks, task graphs, request results, and object identity belong to one invocation only. Information that must survive or be visible to another invocation must be written explicitly to state.

A shared thread is not part of the contract. Implementations may use one executor, many workers, leases, or optimistic execution as long as observable behavior satisfies this specification.

## Explicit atomic blocks

State is accessible only within an explicit synchronous atomic block:

```js
return ctx.atomic(function update(tx) {
  let count = tx.state.public.get("count") || 0;
  tx.state.public.set("count", count + 1);
  return count + 1;
});
```

An atomic callback:

- accesses only the current box's state;
- uses synchronous exact-key state operations;
- must not suspend;
- must not create or return a Task;
- must not issue a request;
- must not invoke another box;
- must not perform nondeterministic or external effects;
- commits completely or has no state effect.

The language and runtime must enforce this boundary rather than relying on convention.

## Serialization

Successful atomic blocks on one box must be **linearizable**: each appears to take effect at one instant between entering the block and returning its result.

All atomic blocks therefore appear in one serial order for that box. A block sees state committed by every block before it in that order and none of the writes from blocks after it.

BOXOS does not promise ordering by:

- HTTP arrival;
- invocation start time;
- task creation time;
- worker assignment;
- client clocks.

Applications requiring an explicit order must represent it in state, for example with revisions or sequence numbers.

The simplest implementation is a per-box queue and one short storage transaction per atomic block. A future implementation may use optimistic execution or replicated ordering if it remains observably equivalent.

## Atomic failures

If an atomic callback throws, exceeds its limits, produces an invalid value, or its executor fails before commit, none of that block's mutations commit.

Failure of one block does not poison the box or roll back previously committed blocks from the same invocation.

A method may execute multiple atomic blocks separated by asynchronous work:

```text
atomic A -> committed
request  -> external effect
atomic B -> fails
```

In this case A and the external effect remain. B has no state effect. A complete method invocation is therefore not implicitly one transaction.

If an executor commits immediately before an infrastructure failure, the caller may receive an ambiguous transport outcome. Application methods requiring safe retry should use idempotency keys represented in box state.

## No cross-box atomicity

Another box can never be called from inside an atomic block. There is no transaction shared by two boxes, even when they use the same process, thread, or SQLite database.

This is both a scaling and security boundary: foreign code cannot consume a box's critical section, expand its transaction, recursively acquire other boxes, or cause a shared rollback.

The modelling rule is:

> State participating in one invariant belongs in one box.

Independently isolated boxes coordinate through asynchronous invocations and, where required, application-level reservations, idempotency, messages, or compensation.

## Physical storage

A box is logically an independent database. It may map to:

- a dedicated SQLite file;
- rows in a shared SQLite shard;
- a dedicated process;
- another transactional store;
- a replicated state machine.

The choice must not be visible to method code. A SQLite writer lock broader than one box is an implementation limitation, not additional shared semantics.
