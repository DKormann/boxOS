# Transaction architecture

BOXOS transactions are optimistic, key-level, and deliberately small. The model is designed around one rule:

> A transaction observes keys, buffers mutations, and commits only if every observed key is unchanged.

This is the complete concurrency contract. It avoids global snapshots, long database locks, and storage-engine details in userspace.

## Execution model

1. A procedure opens `ctx.transaction(callback)`. A direct reducer invocation uses the same mechanism internally.
2. `await tx.invoke(hash, input)` lazily loads that immutable reducer and runs it in the worker.
3. `await ctx.state.private.get(key)` and `has(key)` lazily read one key. Public state behaves identically.
4. Reads are cached for the rest of the transaction. `set` and `delete` update a worker-local write set, so later reads see the buffered value.
5. Reducer calls in one transaction are ordered. They share the read and write sets and therefore see one another's mutations.
6. Commit validates the version of every observed key and applies the compact write set in one SQLite transaction.
7. If an observed key changed, commit aborts with HTTP `409` and code `transaction_conflict`. No state mutation is applied.

Only keys actually read or written cross the worker boundary. A transaction never copies global state and never holds a database lock while userspace code runs.

## Locking

Reducers do not hold a database lock while they execute. Reads are ordinary versioned reads and writes stay in worker memory. At commit, SQLite briefly takes its normal write lock while BOXOS validates the read versions, applies the write set, and settles storage fuel atomically. The lock belongs to the commit—not to a reducer—and no userspace code runs while it is held.

SQLite permits only one writer during that short section. This is useful correctness machinery today, not part of the BOXOS application model: another storage engine could commit independent partitions concurrently while preserving the same read-set/write-set contract.

“Locked fuel” is unrelated terminology. It means fuel collateral attached to durable bytes and does not refer to a concurrency lock.

## Why reads are asynchronous

A synchronous `get` requires the complete reducer state to be copied into the worker before execution, because the next key is not known in advance. Making reads explicitly asynchronous keeps the language honest: crossing the durable-state boundary is visible in source and can remain lazy on SQLite, a remote database, or a distributed storage service.

Writes are synchronous because they only modify the local write set. Durability still occurs at commit.

```js
let count = await ctx.state.public.get("count") || 0;
ctx.state.public.set("count", count + 1);
return count + 1;
```

## Isolation

The validation rule provides serializable optimistic execution:

- transactions touching unrelated keys do not conflict;
- read/modify/write operations on the same key conflict rather than lose an update;
- a transaction cannot successfully commit from a mixed view assembled across concurrent commits;
- versions survive deletion, preventing create/delete ABA changes from becoming invisible.

Blind writes do not need a read dependency. They serialize in commit order. Code that depends on the previous value must read it first.

Failures are never ignored. In particular, a started `tx.invoke(...)` remains part of the transaction even if procedure code forgets to await its returned promise; a reducer failure still aborts commit.

## Boundaries

Transactions have explicit limits on reducers, read keys, read bytes, mutations, and write bytes. Current values are returned by `GET /stats` under `storage.transaction`.

These limits are protocol boundaries rather than SQLite tuning. They bound worker memory and coordinator bookkeeping and allow the backing store to change without changing application semantics.

External effects are outside the transaction. Fetching a URL or publishing immutable code cannot be rolled back and should normally happen before or after `ctx.transaction`, not inside its callback.

## Runtime evolution

The design goal is for a content address to include enough information to identify its execution semantics. The current experiment uses runtime 1 and recognizes a first-line marker such as `// boxos-runtime: 1`; a future runtime could place a different marker in source and therefore receive a different hash.

This is an architectural direction, not a 0.2 compatibility commitment. During the design phase, stored source may stop executing and runtime semantics may change without a compatibility layer or migration.

## Durable representation and migration

Reducer state remains in the existing `reducer_state` table. The key-level architecture adds `state_versions`, populated automatically from existing rows when the database opens. No state values are rewritten during migration.

A version row remains after a value is deleted. This is intentional concurrency metadata. It can later be compacted using a storage-wide safe revision watermark without changing the transaction API.

## Scaling path

The public model does not depend on one Bun process or one SQLite file:

1. **Current:** workers execute concurrently; one SQLite connection serializes only short commits.
2. **Larger single node:** move reads to a connection pool and commits to a dedicated coordinator without changing userspace.
3. **Partitioned storage:** route `(reducer hash, visibility, key)` to shards. Single-shard transactions use the same version check; multi-shard transactions can use a coordinator or be constrained explicitly.
4. **Replication:** immutable code and public pages are naturally cacheable. State versions provide the compare-and-swap boundary required by a replicated store.

The system should not introduce queues, caches, shards, or distributed commit until measurements require them. Preserving the small read-set/write-set contract is more important than choosing those mechanisms now.
