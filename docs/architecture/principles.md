# Principles and vocabulary

## Design principles

### One boundary should do one job

- Blobs provide immutable content identity.
- Boxes provide state, interface, isolation, and atomicity boundaries.
- Methods provide executable entry points.
- Tasks provide owned asynchronous computation.
- Accounts provide signing authority and fuel ownership.

These concepts must not be collapsed merely because one implementation stores them together.

### State that must change atomically belongs in one box

Boxes never share a transaction. If two records must maintain one invariant, they should normally be represented in the same box. Interaction between independently isolated boxes is asynchronous and may require idempotency or compensation.

### Effects must be explicit and owned

Method code cannot create arbitrary asynchronous work. Every asynchronous effect originates from a BOXOS capability and belongs to the invocation that created it. Accidental detached work is not supported.

### Implementation placement is not semantics

A box is not a thread, process, worker, SQLite file, or shard. An implementation may place many boxes together or dedicate resources to one box. Colocation must not grant synchronous access or shared atomicity.

### Authority comes from keys

There is no special client identity, box identity, or built-in capability-grant format. An account key creates authority. Application-specific capabilities can be represented by arbitrary signed messages and interpreted by methods.

### Keep the kernel small

The kernel should enforce content identity, box definitions, invocation isolation, atomic state, task ownership, account signatures, replay protection, and fuel integrity. Application policy belongs in methods.

## Vocabulary

### Blob

Exact immutable bytes addressed by a content hash. A blob has no intrinsic type.

### Box

An immutable validated method table attached to one isolated mutable state namespace. A box is the unit of atomicity and resource isolation.

### Method

A named executable entry point in a box. There is no reducer/procedure distinction.

### Invocation

One execution of a method, initiated by a signed account command or as a child call from another invocation.

### Atomic block

A synchronous state transition over the current box only. Atomic blocks from one box appear in a single serial order.

### Task

A lazy BOXOS-owned asynchronous computation. Tasks are thenable for language ergonomics but are not native JavaScript promises.

### Account

A public key, fuel balance, and replay state maintained by the kernel. Possession of the corresponding private key is complete authority to act as the account.

### Root caller

The account that signed the root invocation. Child box calls preserve this caller.

### Immediate caller

The box and method that initiated a child invocation, or absent for a root invocation.

### Purse

A bounded amount of fuel reserved for one invocation or child task. Purses prevent concurrent or nested work from spending the same fuel twice.
