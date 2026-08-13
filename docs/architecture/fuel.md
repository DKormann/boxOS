# Fuel accounting

## Scope

Fuel is resource accounting, not money. This specification does not define exchange, withdrawal, markets, mining, or monetary guarantees.

Fuel belongs only to accounts. A box has no native balance.

## Default rule

A root invocation reserves a bounded purse from its signed caller account.

By default:

- invocation computation spends from that purse;
- owned Tasks spend from allocated portions of that purse;
- storage growth is charged to the caller;
- storage released by replacement or deletion is refunded to the caller.

The default storage refund deliberately goes to the account causing cleanup, not to the account that originally paid for the bytes. Box method logic controls who is authorized to remove state and may implement another policy explicitly.

## Invocation purses

Before executing a root method, BOXOS atomically reserves `maxFuel` from the caller account:

```text
account balance
    └── root invocation purse
```

The invocation cannot spend beyond this purse. On completion, unused fuel returns to the account according to the eventual failure-accounting policy.

Child Tasks receive disjoint sub-purses:

```text
root purse: 1,000
├── request: 200
├── child call: 300
└── parent available: 500
```

A unit of fuel cannot be simultaneously available to parent and child. Unused child fuel returns to the parent purse when the child settles. This prevents double-spending during nested or parallel work without debiting the account ledger for every internal step.

Cross-box calls continue the root invocation and draw from its purse by default. A box therefore does not need its own account merely to compose methods.

## Runtime and effect costs

The exact metering function remains open. Whatever model is selected must provide bounded spending for:

- method computation;
- atomic execution;
- requests;
- child calls;
- Task callbacks;
- task combinators;
- durable messages, if introduced.

The accounting model must state what is charged on success, application failure, conflict, timeout, cancellation, executor failure, and ambiguous external completion.

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

By default, charges and refunds are associated with the caller account. The previous writer has no native claim over a later refund.

Storage charging and the corresponding box-state commit must be atomic: either the accounting and state transition both commit or neither does.

## Box-selected accounts

Method logic may override the default storage payer and refund recipient.

Conceptually, an atomic block may select:

```text
storage payer account
storage refund account
```

Credits may be directed to any valid public key. Debiting another account requires authority from its private key. A box can obtain that authority only by being entrusted with the key or with some future kernel mechanism explicitly equivalent to it.

Examples of application policy include:

- the caller pays and a cleaner receives the refund—the default;
- a managed service account subsidizes storage;
- deletion refunds the recorded original writer;
- cleanup refunds a maintenance account.

The exact language API for selecting accounts is deferred to the language specification.

## Fuel transfer

An account key can authorize a kernel fuel-transfer command:

```text
sender public key
recipient public key
amount
replay value
network domain
```

The command is canonically encoded, domain-separated, and signed by the sender. BOXOS atomically debits the sender and credits the recipient. Sending to an unseen public key may create its account record.

A transfer is a kernel operation because only the kernel can preserve ledger integrity. The same cryptographic primitives may sign invocations, transfers, and arbitrary application messages, but their domains must remain distinct.

## Boxes holding keys

A box may store an account private key in private state and use it to authorize spending from that account. Such fuel is still owned by the account, not the box.

This keeps the model uniform:

```text
client holding key -> can act as account
box holding key    -> can act as account
```

The kernel does not care where a valid signature was produced.

## Required invariants

1. Accounts are the only native fuel owners.
2. All balances and purses are non-negative bounded integers.
3. A debit requires valid account authority.
4. A credit requires only a valid recipient public key.
5. Every root invocation has one reserved maximum.
6. Every child allocation is removed from its parent while outstanding.
7. No execution path can spend beyond its purse.
8. Storage accounting commits atomically with state.
9. The caller pays and receives released collateral by default.
10. Method logic may choose another payer only with authority to debit it.
11. Method logic may direct a refund to any account.
12. Integer overflow, underflow, duplicate replay, and duplicate settlement are rejected.
