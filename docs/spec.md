


# BOXOS 0.3.2 spec


Boxos makes it easy to specify and run computation on server and client.

Our first priority has to be simplicity in all ways.

In that spirit the Boxos server is a ts project run by Bun with no package dependencies at all, relying only on Bun builtin functionality.

Boxos offers the simplest possible API to freely specify logic, permissions and responsibility.


## Concepts

The Core Keywods are: Account, Address, Blob, Box

### Account
an account is represented as a pubkey. whoever holds the private key can sign messages for that account. this could be a user client or server program.
the server associates a fuel balance to an account which is used to run computation.

### Blob
An immutable globally readable server file adressed by its hash.

### Box
A box definition is an immutable, content-addressed set of methods. A box
instance combines one definition with its own public and private storage. Many
instances may reuse the same definition while remaining independent execution,
authorization, and scheduling boundaries.

Publishing a definition also creates a canonical box whose ID is the definition
hash. This preserves the original API and its content-addressed singleton
behavior. Explicit instantiation creates a distinct ID from the definition ID,
creator account, and caller-provided nonce.

### Client
a browser tab on a fixed page.

### Address
An address is something that can receive messages.
Boxos has two kinds of adress: for a box of a client

## Invoking a Box

A server associates a pubkey to a fuel balance.
Whoever has the privkey can invoke a box.
Invokation may use fuel to pay for compute storage and network usage of that box.
Should the account run out of fuel the computation may be aborted.

Each method or resumed task continuation is one **execution turn**. Storage
writes, fuel changes, task continuations, and effect declarations from a
successful turn commit atomically to SQLite. A failed or exhausted turn commits
none of those changes. Effects are dispatched only after this transaction
commits. Previously committed turns are never rolled back by a later failure.

For the version 1 HTTP protocol, an account is a raw 32-byte Ed25519 public key
encoded as 64 lowercase hexadecimal characters. Invocation requests contain a
client-generated nonce, box ID, method, pure input, and optional client ID. The
signature covers `boxos.invoke.v1`, a newline, and the canonical JSON request.
The turn ID is derived from the account and complete signed request, making an
exact replay idempotent rather than a second invocation.

Box publication requests are likewise signed over `boxos.publish-box.v1`, a
newline, and canonical JSON containing a nonce and definition. A valid signature
is proof of control of a new account: on its first interaction the server
registers it and grants the configured initial fuel. On later authenticated
interactions, the server lazily tops its balance up to a configured target when
the configured interval has elapsed. Top-ups do not accumulate above that
target. This simple policy may be tightened against abuse later.

## Box workers

Box instances execute on workers. A server-side scheduler assigns each instance
to at most one live worker at a time and routes every method and resumed task continuation
for that box to its owner. A worker may own multiple boxes. If a worker exits, all of its
ownership is released before queued work is reassigned. This gives each box a
serial execution order without creating cross-box transactions.

Worker ownership may initially be process-local. It must be made durable or
leased before multiple server processes can share one database.

## Defining and instantiating Boxes
A box definition contains validated method bodies and is publicly readable. Its
ID is the hash of its canonical definition. `publishBox` remains backwards
compatible: it publishes the definition, creates the canonical singleton
instance with the same ID, and returns that ID. Repeated publication returns the
same canonical box and storage.

An explicit instance has an ID derived from the domain-separated canonical
encoding of `{ definitionId, creatorAccount, nonce }`. The creator chooses a
fresh nonce for each new instance and reuses the complete same request only for
idempotent retry. Initial public and private storage are installed atomically
with the instance. Retrying the same creator, definition, and nonce returns the
existing instance without reapplying initial state.

Every instance records immutable `definitionId` and `creator` metadata, exposed
to its methods as `ctx.box`. Creator metadata does not impose a universal access
policy: methods decide whether to admit only the creator, selected accounts, or
everyone.

Instance storage is distinguished in public and private storage. Anyone may read
any box's public storage directly. Private storage is available only while that
box executes. The only way to write either kind of box storage is through
invocation of the box's methods.

Boxos defines a safe subset of JS to be available to define Box methods.
particularly not allowed:
 - using undefined global variables
 - classes, inheritance, prototypes
 - user-controlled runtime code evaluation
 - native promises, `async`, and `await`
 - general effects

Validated code runs natively as JavaScript inside its assigned worker; Boxos does
not interpret it. The trusted worker runtime may compile a validated method or
task continuation using runtime-captured intrinsics. Compilation must happen
only after successful validation, and dynamic compilation facilities such as
`eval` and `Function` are never exposed to box code. Methods and continuations
execute with only their explicit arguments and approved runtime bindings in
scope.

Each box method gets `ctx` and `input`. The context offers:
 - storage: read and write to private and public storage of that box
 - invoke(boxid, methodname, argument): returns a durable Task for another box invocation
 - instantiate(definitionId, options): returns a durable Task for a new box instance
 - message(clientid, message): returns a message ID and schedules best-effort delivery after commit
 - publish(kind: "box" | "blob" | "page" | "account", args): returns a durable Task for publication
 - request(request): returns a durable Task for a structured public HTTPS JSON request
 - transfer(receiverPub, amount): atomically transfers fuel from `ctx.account`; private keys are never passed to box code

ctx also exposes the account behind the invokation and the clientId
invoking a new box method will also inherit the same account and client. all subsequent fuel usage will be credited to the same account.

A box may instantiate another definition durably:

```js
return ctx.instantiate(input.definitionId, {
  nonce: input.nonce,
  initialPublic: { owner: ctx.account },
  initialPrivate: { configuration: input.configuration }
});
```

A successful instantiation Task settles with `{ id }`. Direct clients use the
same operation with type `instantiateBox`; browser and CLI clients generate a
nonce by default.

Clients may directly invoke boxes, publish entities, send messages, transfer
their own fuel, and read immutable public entities or any public box storage.
They authenticate these operations with their page account. Box methods and
direct clients use the same operation handlers; only completion differs. A box
composes durable Tasks, while a client receives an HTTP response or client
message. Neither clients nor other boxes may directly read private storage or
write any box storage.

## Durable Tasks

`ctx.invoke`, `ctx.publish`, and `ctx.request` declare effects synchronously and
return frozen runtime-owned **Tasks**. A Task resembles a Promise but is not a
native Promise and is not a pure BoxOS value. It cannot be stored, messaged, or
passed as box input. Its identity, state, and continuation graph are persisted
by the runtime rather than retained in a worker heap.

A method or continuation may return a pure value for immediate completion or a
Task for eventual completion. Returning a Task makes the current box invocation
adopt that Task: its remote caller does not receive a successful result until
the adopted Task settles. This allows boxes to expose composable asynchronous
operations without preserving a JavaScript stack.

Tasks expose this restricted interface:

```js
task.then(successCallback, callbackContext)
task.catch(failureCallback, callbackContext)
```

Both methods return a new durable Task. On success, `then` calls its callback
with `(result, context)`; on failure, `catch` calls its callback with
`(error, context)`. The optional context defaults to `null` and is copied as a
pure BoxOS value when the continuation is registered. A skipped `then` passes a
failure through, and a skipped `catch` passes a success through. A continuation
may return a pure value or another Task. Returning a Task adopts its outcome.
Throwing rejects the next Task. Task adoption cycles are rejected. There is no
`.finally`, Promise constructor, Promise assimilation, microtask API, `async`,
or `await`.

A Task may have multiple continuations, creating independent durable branches.
Sibling continuations have no ordering guarantee beyond the ordinary serial
turn order of their origin box. Calling `.then` or `.catch` registers the
continuation synchronously during the current turn; it does not execute a
settled Task's callback inline.

An effect is accepted only if the declaring turn commits, even if its Task is
not returned or observed. Unobserved effects still run; their result remains
persisted and no continuation is scheduled. This permits explicit
fire-and-forget work without making effect dispatch part of the transaction.

### Serializable continuations

When `.then` or `.catch` is called, the trusted runtime serializes the callback
using its captured intrinsic:

```js
Function.prototype.toString.call(callback)
```

It never uses a user-overridable `callback.toString` property. The exact source
is parsed and validated by the same safe-JavaScript parser used for box methods.
Native, bound, proxied, dynamically constructed, arrow, and otherwise
unsupported functions are rejected.

A durable continuation may refer only to its parameters, continuation-local
declarations, and fixed runtime bindings such as `ctx`, `JSON`, and approved
deterministic helpers. It cannot capture a method local because no lexical
environment is persisted. Required data is copied explicitly into the optional
pure callback context:

```js
return ctx.invoke(input.target, "read", input.query).then(
  function completed(result, saved) {
    ctx.storage.private.set(saved.key, result);
    return result;
  },
  { key: input.key }
);
```

This is invalid because `key` is a free variable:

```js
let key = input.key;
return ctx.invoke(input.target, "read", null).then(
  function completed(result) {
    ctx.storage.private.set(key, result);
    return result;
  }
);
```

The continuation source, context, origin box, role, runtime version, source Task,
and resulting Task are persisted in the same transaction that registers the
continuation. Once the source Task settles, the selected continuation is queued
on its origin box and runs as a fresh atomic execution turn with a fresh heap.
No closure, stack, heap, native Promise, or instruction pointer is preserved.

Task settlement, adoption, and continuation scheduling are idempotent. A Task
settles exactly once, and duplicate delivery cannot execute a continuation more
than once. Worker or server failure may delay progress but cannot erase a
committed Task graph. The originating account and client identity flow through
the graph, and all subsequent fuel usage is charged to that account.

### Invocation completion

Every box invocation has durable completion state. A pure method result settles
it immediately. A returned Task links it to that Task's eventual outcome. A
`ctx.invoke` Task therefore settles only after the target method's complete
returned Task chain, not merely after its first synchronous turn.

For an external HTTP caller, losing the connection does not cancel the durable
invocation. Retrying the exact same signed request reattaches to the same
idempotent invocation and observes its existing or eventual outcome rather than
starting another operation.

Outbound requests are structurally narrower than browser `fetch`. A request
contains a public DNS host, absolute path, `GET` or `POST` method, end-to-end
string headers, and an optional pure JSON body. The runtime owns the scheme,
port, transport headers, redirect behavior, DNS resolution, limits, and timeout.
It uses HTTPS on port 443, pins a globally routable resolved address while
validating TLS for the requested host, and does not follow redirects. This keeps
private network and raw transport authority outside box code while allowing
ordinary public JSON APIs.

## Pages
each page is backed by a blob. it is reachable under a shortened hash at
`https://<hash>.boxos.org/`. Pages are immutable client definitions. The current
shortened page ID is the first 16 hexadecimal characters of its domain-separated
hash. Each page receives a separate browser origin and therefore a separate
automatically managed page account.

BoxOS deploys a content-addressed `default.css` blob for its default design
language. It is dark-first, follows the system light/dark preference, uses a
dark-blue accent, lightweight surfaces, and rounded corners. Startup example
pages link to this shared immutable stylesheet and build on its palette variables
and small component classes.

## Client events

Clients receive messages over Server-Sent Events rather than WebSockets. A page
opens a signed `POST /v1/events` stream for its own client ID, which is currently
its page-account public key. `ctx.message` notifications are collected during a
turn and broadcast from memory only after that turn commits. A missing client or
failed event stream therefore cannot roll back box state. The message ID returned
by `ctx.message` can be correlated with post-turn delivery metadata; `delivered`
means that at least one live stream accepted the event, not that it was read.
Notifications are not stored in SQLite and may be lost when the recipient is
offline or the server fails after commit. Applications must store durable data
in box storage; reconnecting clients reload that state. The reference client
exposes SSE as `boxos.events`.


## Userspace implementations

Boxos hosts a reference client.js that can be requested under URL.client.js. Pages should use that client.
it will expose methods to communicate with the server and receive messages. it will store its clientId keys securely in the browser. A client Id should be persistent through page visits.

BoxOS also hosts a dependency-free standalone CLI at `/boxos-cli.js` (and the
short alias `/boxos`) for developers, automation, and terminal agents. It is
built from the shared TypeScript codebase into a committed Node.js-compatible
artifact. It runs on Node.js 20+ or Bun, manages a local Ed25519 account file,
signs mutations,
and emits machine-readable JSON. It supports publishing boxes, blobs, and pages;
invoking boxes; transferring and messaging; and reading public entities and
startup deployments. Box and page publication resolves explicit relative links
of the form `{{BOXOS_BOX:./path.box.json}}`. Before publishing anything, the CLI
resolves the complete graph, calculates content IDs, and validates every linked
box locally with the same parser as the server. It then publishes dependencies
in order and substitutes their immutable IDs. Repeated paths are deduplicated,
circular dependencies are rejected, and the server validates every publication
again.

A Boxos app is a page that uses specific Boxes. pages do share functionality by reusing boxes, therefore apps are natively interoperable.

Per default Boxos offers multiple apps:

### Accounts App
The Accounts app manages account keys and grants only. It creates, imports,
selects, and backs up keys stored securely in the browser, and accepts OAuth-like
redirects from apps requesting capabilities. It does not edit existing profiles.

At account creation it performs one-time profile setup: the new account grants
the Accounts page account `manage account`, and the page uses that capability to
set the initial name in the Profiles box. Thereafter any app account granted
`manage account` may rename the profile through that box. The Profiles box stores
public profile names; it never stores or manages account keys. Multiple apps may
hold grants for one account.

### Social App
This app looks like whatsapp.
It uses multiple different Boxes to provide private messages, group messages, public username, following muting and blocking other accounts.
It requests all these grants from accounts on first visit.
It uses messaging to the client to offer notificiations.
