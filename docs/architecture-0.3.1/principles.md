# Principles and vocabulary

## Four distinct concepts

### Account

A durable public key, fuel balance, and replay-protection state. Possession of the private key authorizes account debits and signed commands. An account has no application methods or box state.

### Box

An immutable validated method table attached to one isolated mutable state namespace and one responsible provider. A box has no intrinsic account or fuel balance.

### Invocation

A durable execution workflow with caller lineage, a fuel balance, a target, children, and serialized continuations. It is temporary but may span many atomic turns, machines, and hours.

### Provider

The server or client responsible for hosting a box, preserving its state, executing its methods, and truthfully reporting results and charges. A provider authenticates using a key and may receive fuel for execution.

## Design principles

### Integrity responsibility is explicit

A box result means that its provider asserted the result. The server verifies the provider signature and ledger arithmetic, not the computation. There is no re-execution, voting, challenge protocol, or probabilistic checking.

### Fuel and authority are related but separate

Accounts and invocations both hold fuel. Only accounts possess key-based authority. Funding an invocation does not change its caller, and calling as an account does not imply that account is the only contributor.

### One method call is one atomic turn

A method synchronously reads and changes only its own box state. Its state changes and outgoing operation declarations commit together or not at all. Boxes never share a transaction.

### Long time is represented as data

No JavaScript stack survives between turns. Future work is represented by persisted child invocations, serialized callbacks, and explicit BOXOS context values.

### Network boundaries do not change identity

The authoritative account and invocation balances remain in the server ledger. Execution may occur on any responsible provider. What crosses a machine boundary is an authenticated execution assignment and signed settlement, not a copied authoritative balance.

### Keep the language synchronous

Methods contain deterministic local computation, state transitions, and declarations of future work. Ambient asynchronous APIs, promises, Tasks, and `await` are absent.

## Compact relationship

```text
Account
  key-authenticated durable fuel holder
      |
      | funds
      v
Invocation
  temporary fuel-bearing workflow
      |
      | executes atomic turns
      v
Box
  provider-owned immutable methods and isolated state
```

An invocation may recursively fund child invocations. Unused child fuel returns to the parent invocation; unused root fuel returns to its parent account.
