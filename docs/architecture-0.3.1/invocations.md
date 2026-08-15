# Invocations

## Invocation model

An invocation is a durable fuel-bearing workflow, not a suspended function call.

```text
Invocation {
  id
  parent: Account | Invocation
  rootCallerAccount
  immediateCallingBox
  targetBox
  targetMethod
  input
  fuelBalance
  state
  activeChildren
  completionContinuation
}
```

The ID is a kernel identity used for routing, lineage, duplicate prevention, and accounting. Runtime 0.3.1 does not expose it as a general result handle or polling API.

## Lifecycle

The minimal conceptual lifecycle is:

```text
created -> queued -> running-turn -> waiting -> running-turn -> closed
                                      \----------------------/
```

An invocation may alternate between running atomic turns and waiting for children. No worker, heap, stack, or native function object survives while it waits.

An invocation closes when:

1. its current turn has returned or failed;
2. every declared child has settled;
3. every selected serialized continuation has run or failed;
4. its transactional outbox has no uncommitted declaration;
5. no further continuation is registered.

It then returns its complete remaining fuel balance to its parent.

## Caller lineage

A root invocation records the account that signed it. A child additionally records the box whose turn created it.

```text
root caller account
immediate calling box
```

Creating a child does not forge a new signature from the root account. It means the signed root workflow authorized the immutable code to create that child using fuel already held by the workflow.

A box holding another private key may create a new root invocation signed as that account. That is new account authority, not ordinary child lineage.

## Children

HTTP requests, timers, and box method calls all use the same ownership shape:

```text
Parent invocation
  -> allocates fuel
  -> creates durable child work
  -> persists success/failure continuation
  -> waits without execution
Child settles
  -> returns unused fuel
  -> schedules the selected parent continuation
```

A child without a continuation still settles and returns fuel. Its result is discarded.

## Result delivery

There are no public result tickets in runtime 0.3.1. Long-lived results are delivered only through serialized callbacks.

A root submission may include a completion destination when its caller is itself a client-hosted box. If no completion callback exists, the root result may be returned on a still-open transport as a convenience, but durable retrieval is not promised and the result may otherwise be discarded.

## Machine mobility

The invocation record and fuel balance remain authoritative on the server. An atomic turn may execute on the target box's provider. The server sends an authenticated assignment containing the invocation identity, method, input, lineage, and allowed balance.

The provider returns a signed settlement containing its asserted outcome, charge, child declarations, and callback routing data. The server verifies the signature and ledger bounds, applies settlement, and routes subsequent work. It does not verify method execution.

## Failure

Application throw, invalid output, insufficient fuel, provider-declared failure, and infrastructure failure are invocation outcomes. Already committed turns in any box remain committed. Failed turns do not commit state or outgoing declarations.

Runtime 0.3.1 performs no automatic retry. If a provider never reports an outcome, the invocation may remain waiting indefinitely. Failure policy beyond invoking an explicitly registered failure callback is application policy.
