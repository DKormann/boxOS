# Boxes and providers

## Box definition

A box combines:

```text
immutable validated method table
isolated mutable state
responsible provider
```

The code definition remains content-addressed. A box instance distinguishes independent state namespaces using the same code. Changing runtime, method source, method table, or instance identity creates a different box identity.

A box address must identify both the box and the provider responsible for it:

```text
BoxAddress {
  providerPublicKey
  boxId
}
```

The server itself is one possible provider. A connected client may be another.

## Provider responsibility

The provider of a box is solely responsible for:

- retaining the box state;
- serializing atomic turns;
- running the declared method code;
- enforcing the declared runtime;
- validating and persisting callbacks;
- preserving its transactional outbox;
- reporting results, failures, and charges honestly;
- protecting private state from parties other than itself.

The server authenticates the provider's signed claims. It does not establish that those claims are true.

The public representation of a box must make its provider visible so callers can decide whether to trust it. Moving a stateful box to another provider changes the responsible box address unless a later explicit migration protocol says otherwise.

## No execution checking

BOXOS 0.3.1 has no:

- re-execution;
- redundant execution;
- majority voting;
- random auditing;
- result challenges;
- metering challenges;
- trusted-hardware claim;
- proof-of-execution claim.

A future proof-carrying provider could define a stronger contract, but it would be explicit and is outside this architecture.

## Server responsibilities

The shared server is responsible for:

- account signatures and nonces;
- authoritative account and invocation balances;
- invocation identity and lineage;
- provider authentication;
- routing and queueing;
- preventing duplicate assignment settlement;
- applying signed charges and transfers;
- routing child completion to serialized callbacks.

These responsibilities create shared trust for identity and accounting, not computation correctness.

## Client-hosted boxes

A client provider may disconnect. The server retains queued invocation metadata and delivers it when that provider reconnects. The provider retains its own box state and local outbox.

Without general expiry or cancellation, an invocation may wait indefinitely for an offline or dishonest provider. That is a visible consequence of choosing the provider, not a condition the server silently repairs.

The first implementation may allow at most one active delivery per invocation and reject duplicate settlement. It does not retry an execution reported as started and then ambiguously lost.

## Isolation

A box is one:

- state namespace;
- serial atomic-turn boundary;
- provider responsibility boundary;
- failure boundary;
- placement unit.

Boxes never share a state transaction, even when one provider hosts both. Cross-box interaction always creates another invocation and later continuation.

Private state means private from other boxes and ordinary callers. It is not encrypted from the responsible provider.
