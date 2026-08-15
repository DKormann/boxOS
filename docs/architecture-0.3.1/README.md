# BOXOS architecture 0.3.1

Status: **clean replacement design; not the behavior of the current implementation**

This folder defines the 0.3.1 architecture independently of the earlier draft. Compatibility, migration, availability, and retained data are not goals. The implementation may be discarded and rebuilt from this design.

## Core statement

> Accounts and invocations hold fuel. Accounts are durable identities controlled by keys. An invocation is a durable, fuel-bearing workflow. A box is immutable code attached to provider-owned isolated state. Every method and serialized callback runs as one synchronous atomic turn. Effects create child invocations and durable callbacks; the method language has no `await`, promises, Tasks, or suspended execution.

A provider is explicitly responsible for the integrity of every box it hosts. The server supplies shared identity, routing, and fuel settlement. It authenticates provider claims but does not verify computation or metering.

## Documents

1. [Principles and vocabulary](principles.md)
2. [Accounts and fuel](accounts-and-fuel.md)
3. [Boxes and providers](boxes-and-providers.md)
4. [Invocations](invocations.md)
5. [Atomic turns and state](turns-and-state.md)
6. [Durable callbacks and effects](callbacks-and-effects.md)
7. [Method language](language.md)
8. [Values](values.md)
9. [Blobs and pages](blobs-and-pages.md)
10. [Open decisions](open-decisions.md)

## Normative language

- **Must** defines a required semantic property.
- **Must not** defines prohibited behavior.
- **Should** records the current preferred design.
- **May** leaves an implementation choice.

## Scope

This design intentionally omits result handles, polling, cancellation, automatic retry, general expiry, execution verification, consensus, and durable JavaScript stacks. An invocation may remain waiting indefinitely when its responsible provider or child does not complete. These features can be added only when a concrete need justifies their semantics.
