# Fuel accounting

## Scope

Fuel is resource accounting, not money. This specification does not define exchange, withdrawal, markets, mining, or monetary guarantees.

Fuel belongs only to accounts. A box has no native balance.

## Fixed invocation purse

Every root invocation names `maxFuel`. Before execution, BOXOS atomically reserves that amount from the signed caller account into one invocation-local purse:

```text
account balance
    └── fixed invocation purse
```

All work funded by the invocation spends from this same kernel-owned purse:

- method execution;
- Task callbacks;
- requests;
- cross-box child calls that continue the invocation;
- atomic blocks;
- storage growth.

Concurrent Tasks do not receive copied balances or independently refundable sub-purses. Their debits are serialized against the same purse, preserving the single invariant:

```text
total spent by invocation <= maxFuel
```

The purse has a fixed maximum in runtime 1 and cannot be recharged while the invocation runs. Fuel sent to its sponsoring account does not enlarge an existing reservation. More fuel funds a new invocation.

Recharge may be added later as an explicit kernel operation without changing methods that rely on fixed purses. Such a feature would need to define contributors, refund ownership, exhaustion behavior, deadlines, and admission limits; none of that belongs in runtime 1.

## Completion and refund

Returning from the method body does not settle the purse while owned Tasks remain. BOXOS retains the reservation until the complete invocation scope settles:

```text
reserve purse
run method body
body returns candidate result
wait for every owned Task
settle invocation
refund unused purse
```

This avoids hidden post-refund spending and lets concurrent Tasks use one balance safely.

If the purse reaches zero, no further method or callback code may execute under it, no new atomic block may begin, and unsettled Tasks are cancelled where possible. Already committed atomic blocks and already-started external effects are not rolled back.

BOXOS refunds as much as it can account for simply:

```text
refund = reserved - actual settled charges
```

This rule applies on success, application failure, Task rejection, timeout, cancellation, and executor failure. Failure is not itself a reason to burn the remainder. Work already performed and resources already consumed remain charged; work prevented by termination is not. Fuel exhaustion naturally leaves no remainder.

If infrastructure fails, BOXOS settles every charge durably known to have occurred and refunds the rest. Receipts report the terminal status and accounting. This favors transparent actual-cost accounting over punitive failure policy.

## Calls continuing the invocation

An ordinary cross-box call continues the root invocation:

```js
await ctx.call(target, "lookup", args);
```

It preserves the root caller and spends from the same purse. A box therefore needs no account key merely to compose with another box.

A future per-call spending ceiling may limit one child without creating a separate payer or purse. It is not required initially.

## Separately funded invocations

A method holding another account's private key may start a new invocation funded by that account:

```text
parent invocation
├── caller account A
├── purse A
└── owned child Task
    └── new invocation
        ├── caller account B
        └── purse B
```

This operation does not recharge the parent. The child has its own caller, fixed purse, accounting, result, and receipt. It remains an owned Task for the parent's lifecycle unless a future durable messaging primitive explicitly detaches it.

Unused child fuel returns to account B; unused parent fuel returns to account A. Parent callback work after the child settles continues to spend from purse A.

The language API for creating an account handle from a private key and starting this invocation remains to be specified.

## Storage collateral

Persistent bytes lock fuel according to a kernel pricing rule.

For a write:

```text
charge cost of new stored representation
refund cost of replaced stored representation, if any
```

For a deletion:

```text
refund cost of deleted stored representation
```

By default:

- storage growth spends from the current invocation purse;
- released storage credits the current caller account.

The previous writer has no native claim over a later refund. The account causing authorized cleanup receives it by default.

A method may direct a storage refund to any valid public key because a credit needs no spending authority. If an application wants to refund the original writer, it records that writer and selects the account during deletion.

Runtime 1 should not debit an unrelated account from inside the current box's atomic block. If another account should pay for storage, code holding its private key starts a separately funded invocation as that account. This keeps one payer per invocation and avoids introducing multi-account debit coordination into state commit.

Storage charging, refund creation, and the corresponding box-state transition must commit atomically.

## State subscription leases

State subscriptions are finite prepaid leases, not invocation Tasks. Creating a lease is a distinct signed account command with a strict nonce and `maxFuel`. Runtime 0.3.0 charges a fixed 10,000 fuel for one minute and rejects a command whose maximum is lower.

The fixed lease charge is spent at admission and is not refunded if the client disconnects or never opens the SSE URL. This deliberately simple bounded charge covers at most one connection at a time and 1,000 change invalidations. A new lease requires a new signed command and charge.

## Fuel transfer

An account key can authorize a kernel transfer command containing, conceptually:

```text
sender public key
recipient public key
amount
strict account nonce
network domain
```

The command is validated, encoded with plain `JSON.stringify`, domain-separated, and signed by the sender. It is accepted only at the account's next strict nonce. BOXOS atomically advances that nonce, debits the sender, and credits the recipient. Sending to an unseen public key may create its account record.

Transfer is a kernel operation because only the kernel can preserve ledger integrity. Invocation, transfer, and arbitrary application signatures use the same key foundation but distinct signed domains.

## Inspection and receipts

Fuel use must be inspectable. Every completed invocation returns a compact receipt identifying at least:

```text
invocation ID
sponsoring account
reserved fuel
spent fuel by stable cost category
storage charged
storage credits and their recipients
unused fuel refunded
completion status
separately funded child invocation IDs
```

A separately funded invocation has its own receipt rather than being folded invisibly into its parent.

Every account balance mutation must have an identifiable cause, such as an invocation reservation or refund, storage credit, or transfer. Unlimited server-side history is not a semantic durability promise; clients should retain receipts they care about.

Methods should not initially inspect exact remaining fuel. Branching on deployment pricing would make behavior depend on metering details. The kernel enforces the fixed maximum, while users inspect actual costs through receipts.

## Required invariants

1. Accounts are the only native fuel owners.
2. Every invocation has exactly one sponsoring account and one fixed purse.
3. Runtime 1 purses cannot be recharged.
4. All work continuing an invocation shares its purse.
5. Concurrent Tasks cannot spend more than the shared purse contains.
6. Another account funds a new invocation, never the existing purse.
7. Refund occurs only after the complete owned Task scope settles or is forcibly terminated.
8. Every terminal outcome refunds reserved fuel not consumed by settled charges.
9. Storage growth spends from the current purse by default.
10. Released storage credits the current caller by default.
11. A method may direct a storage credit to any account.
12. Storage accounting and state commit are atomic.
13. Every balance mutation is represented by an inspectable receipt or ledger cause.
14. All balances and amounts are non-negative bounded integers; overflow, underflow, replay, and duplicate settlement are rejected.
