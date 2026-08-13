# Accounts, signatures, and calls

## Account model

An account is a kernel record containing:

```text
public key
fuel balance
next nonce
```

Accounts are the only native owners of fuel. Boxes do not intrinsically have identities or balances.

Possession of an account's private key is complete authority to:

1. invoke a box method as that account;
2. transfer fuel from that account;
3. sign arbitrary application messages.

The server never needs the private key for a client-originated operation. A client-facing SDK may accept a private key, but it signs locally and transmits only the command, public key, and signature.

A box may be entrusted with a private key by storing it in private box state. It then has the same authority as any other holder of that key. This is full delegation: the box can spend the account's fuel, invoke methods as it, transfer its fuel, sign messages, or disclose the key. There is no built-in attenuation hidden behind this operation.

## Signed kernel commands

Invocation and fuel transfer use the same signing foundation as arbitrary messages, but each command must be domain-separated so one signature cannot be reinterpreted as another operation.

A root invocation conceptually signs:

```text
operation domain
account public key
nonce
box ID
method name
maximum fuel
arguments
network or deployment domain
```

Runtime 1 uses a strict monotonically increasing nonce per account. A command is accepted only when its nonce equals the account's next nonce; successful acceptance advances it exactly once. This intentionally favors a small replay model over convenient concurrent submission from multiple clients. Clients must coordinate nonce allocation themselves.

Commands are validated and serialized with plain `JSON.stringify`, then encoded as UTF-8 for signing. Property insertion order is significant. The wire representation contains only the command and its signature.

The ergonomic client API may remain minimal:

```js
invoke(box, method, privateKey, maxFuel, args)
transfer(privateKey, recipientPublicKey, amount)
sign(privateKey, message)
verify(publicKey, message, signature)
```

Cryptographic complexity belongs in the SDK and kernel protocol, not application code.

## Arbitrary signatures

Methods can verify arbitrary signed messages:

```js
ctx.verify(publicKey, message, signature)
```

This is the foundation for application-defined:

- capabilities;
- grants;
- delegation;
- approvals;
- expiry;
- recovery schemes;
- revocation registries;
- multisignature policy.

BOXOS does not impose one universal capability envelope. Applications must domain-separate their signed messages. Structured messages use validated plain `JSON.stringify` encoding.

## Cross-box calls

A box may invoke another box, but every cross-box call is asynchronous and returns an owned Task:

```js
let result = await ctx.call(targetBox, "lookup", args);
```

A child call:

- is forbidden inside `ctx.atomic`;
- starts an independent target invocation;
- shares no heap or state transaction with the caller;
- preserves the root caller account;
- records the immediate calling box and method;
- spends from the root invocation's shared fixed purse;
- returns a value or error to the parent Task.

The target context can distinguish:

```text
root caller account
immediate calling box and method
```

For a direct root invocation, the immediate caller is absent.

## Invocation lineage is not a signature

When account A signs a root invocation of box X, X may make child calls under the same invocation lineage. BOXOS preserves A as the root caller, but it does not forge new signatures from A.

The semantic authorization is:

> By signing the root invocation, the account permits the immutable invoked method to spend the reserved purse and perform the downstream calls expressed by that code.

A target may authorize based on the root caller, the immediate calling box, explicit application signatures in the arguments, or any combination.

For narrow authority, the account should sign an application message bound to the intended operation and pass it through the call chain. The target verifies that message itself.

## Calling as another account

Ordinary child calls continue the original invocation and need no additional private key. A box needs an account key only when it wants to create new authority—for example, to start a separately funded invocation as another account, transfer that account's fuel, or sign an application message.

A separately funded invocation has its own authenticated caller, fixed purse, and receipt. It remains an owned Task of the parent invocation for lifecycle purposes, but it does not recharge or share the parent's purse.

The exact method-language API for using a key held in private state remains to be designed.

## Call failure and delivery

A child failure rejects its Task and may be handled by the parent method. Atomic blocks already committed in either box remain committed.

Joined calls are not durable messages and do not provide exactly-once delivery. If a target commits and a transport or executor fails before returning the result, the caller may observe an ambiguous outcome. Retry-safe target methods should use application idempotency keys.

Call depth, fan-out, input size, result size, queueing, timeouts, and fuel must all be bounded. The precise limits are operational policy rather than additions to the abstract model.
