# Accounts and fuel

## Account model

An account is a server ledger record:

```text
Account {
  publicKey
  fuelBalance
  nextNonce
}
```

Possession of the private key authorizes signed account commands. The same key may be used across devices, although strict nonces require those devices to coordinate command ordering.

A box is not an account. A box may hold an account private key in private state, in which case it has the same complete authority as any other key holder.

## Fuel is transferable value

Fuel is server-accounted resource credit and behaves economically like money. It may be transferred, used to buy execution, earned by providers, and contributed to invocations. BOXOS does not claim that fuel has an external price or redemption value, but it does not pretend that transferable computation credit is economically neutral.

## Two fuel holders

The ledger recognizes:

```text
FuelHolder = Account(publicKey) | Invocation(invocationId)
```

Both holders may be credited and may fund an invocation. Debit authority differs:

- debiting an account requires a valid signed command;
- debiting an invocation requires the currently authorized atomic turn or kernel settlement;
- crediting a holder grants no execution or signing authority.

All balances are non-negative bounded integers. Every transfer must reject overflow, underflow, replay, and duplicate settlement.

## Root funding

A signed root command atomically creates and funds an invocation:

```text
Account A:    10,000
allocate:      1,000
Account A:     9,000
Invocation I:  1,000
```

The command binds at least the caller account, strict nonce, target box and method, input, initial fuel, and network domain. Plain `JSON.stringify` property order remains significant when hashing and signing protocol values.

## Child funding and return

A running invocation may create a child and transfer fuel to it:

```text
Invocation I: 1,000
create J with:   300
Invocation I:   700
Invocation J:   300
```

When J closes with 220 fuel, that amount returns to I:

```text
Invocation J:   0, closed
Invocation I: 920
```

The parent remains as a durable record while children are active, even when no worker or JavaScript execution is alive.

A root invocation returns its final balance to its parent account. This recursive rule removes separate refund ownership from ordinary invocation trees.

## Additional funding

An open invocation may receive more fuel:

```text
Account B --500--> Invocation I
```

The account debit requires B's signature. The contribution does not change I's caller, provider, target, parent, or completion destination. It is a contribution to the workflow; unused fuel still follows I's parent chain.

An invocation may also fund a child while one of its turns runs. An invocation cannot debit an account merely because the account is its caller.

## Spending and provider payment

Execution, retained storage, routing, and effects debit the responsible invocation. A remote provider may receive an execution payment:

```text
Invocation I --charge--> Provider account P
```

The provider signs its settlement claim. The server verifies identity, assignment, replay protection, and that the charge does not exceed I's available balance. The server does not verify whether the reported work or charge was truthful. Choosing the provider is choosing whom to trust under the provider's published terms.

Server-hosted execution may use server-defined metering. Client-hosted execution may use provider-declared charges. The exact initial price format remains open.

## Exhaustion

Runtime 0.3.1 does not persist an arbitrary mid-method stack waiting for fuel. If a running atomic turn cannot pay its next charge, that turn fails and rolls back its box state and outbox.

The invocation may remain open if it has active children whose returned fuel can enable a later continuation. Otherwise it closes through the ordinary failure path. Funding received before closure is valid; closed invocations reject funding.

## Storage accounting

Committed state growth spends from the current invocation. Released storage should credit the current invocation by default, allowing cleanup to fund later turns. A method may explicitly redirect a credit to another account or open invocation.

State mutation and its storage debit or credit must settle as part of the same atomic turn. Compute already consumed remains chargeable when an application turn rolls back.

## Required invariants

1. Every unit of fuel is recorded against exactly one account or invocation.
2. Accounts are debited only by valid signatures or explicit kernel policy.
3. Invocations are debited only by their authorized execution and settlement.
4. A child allocation atomically debits the parent and credits the child.
5. A child closes once and returns its complete remaining balance once.
6. A root closes once and returns its balance to its parent account once.
7. Additional funding does not confer caller or provider authority.
8. No balance becomes negative or exceeds the integer limit.
9. Every balance mutation has a durable ledger cause.
