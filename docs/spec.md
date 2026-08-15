


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
A box is an immutable set of functions and an owned storage space.
Boxes are what defines and computation and storage.

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

Each method or resumed effect callback is one **execution turn**. Storage writes,
fuel changes, callback registrations, and effect declarations from a successful
turn commit atomically to SQLite. A failed or exhausted turn commits none of
those changes. Effects are dispatched only after this transaction commits.
Previously committed turns are never rolled back by a later failure.

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

Boxes execute on workers. A server-side scheduler assigns each box to at most
one live worker at a time and routes every method and resumed callback for that
box to its owner. A worker may own multiple boxes. If a worker exits, all of its
ownership is released before queued work is reassigned. This gives each box a
serial execution order without creating cross-box transactions.

Worker ownership may initially be process-local. It must be made durable or
leased before multiple server processes can share one database.

## Defining a Box
A Box is defined by its methods and its individual storage space.
The methods are just blobs of validated code. The box definition is publicly readable.
The box storage is distinguished in public and private storage. Anyone may read
any box's public storage directly. Private storage is available only while that
box executes. The only way to write either kind of box storage is through
invocation of the box's methods.

Boxos defines a safe subset of JS to be available to define Box methods.
particularly not allowed:
 - using undefined global variables
 - classes, inheritance, prototypes
 - user-controlled runtime code evaluation
 - async
 - general effects

Validated code runs natively as JavaScript inside its assigned worker; Boxos does
not interpret it. The trusted worker runtime may compile a validated method or
callback using runtime-captured intrinsics. Compilation must happen only after
successful validation, and dynamic compilation facilities such as `eval` and
`Function` are never exposed to box code. Methods and callbacks execute with
only their explicit arguments and approved runtime bindings in scope.

Each box method gets as first argument a ctx. this offers different kinds of effects:
 - storage: read and write to private and public storage of that box
 - invoke(boxid, methodname, argument, callback, callbackContext): invokes another box with pure data and optionally resumes the callback with explicit durable context
 - message(clientid, message): messages a client session
 - publish(kind: "box" | "blob" | "page" | "account", args): creates a public entity
 - transfer(receiverPub, amount): atomically transfers fuel from `ctx.account`; private keys are never passed to box code

ctx also exposes the account behind the invokation and the clientId
invoking a new box method will also inherit the same account and client. all subsequent fuel usage will be credited to the same account.

Clients may directly invoke boxes, publish entities, send messages, transfer
their own fuel, and read immutable public entities or any public box storage.
They authenticate these operations with their page account. Box methods and
direct clients use the same operation handlers; only completion differs. A box
resumes a durable callback, while a client receives an HTTP response or client
message. Neither clients nor other boxes may directly read private storage or
write any box storage.

## Effects and callbacks

An effect is declared synchronously during a turn but may finish later. When an
effect is declared, the trusted runtime serializes its callback using the
captured intrinsic `Function.prototype.toString.call(callback)`. It must not use
a user-overridable `callback.toString` property.

The exact callback source is parsed and validated by the same safe-JavaScript
parser used for box methods. Unsupported functions and callbacks containing
free variables are rejected. A callback may refer only to its parameters,
callback-local declarations, and fixed runtime bindings such as `ctx`, `JSON`,
and approved deterministic helpers. Data needed from the initiating method must
be supplied explicitly as pure callback context.

The callback source, context, origin box, role, runtime version, and effect ID
are persisted in the same transaction that declares the effect. Once the
effect settles, its selected callback is queued on the origin box and runs as a
fresh execution turn. No closure, stack, heap, or instruction pointer is
preserved. Effect settlement and callback turns must be idempotent so duplicate
delivery cannot run a callback twice.

## Pages
each page is backed by a blob. it is reachable under a shortened hash. under the url <hash>.boxos.org or <hash>.localhost:port for development.
pages are immutable client definitions. The current shortened page ID is the
first 16 hexadecimal characters of its domain-separated hash. The server hosts
a page at `https://<pageid>.boxos.org/` and, in development, at
`http://<pageid>.localhost:<port>/`. Each page receives a separate browser
origin and therefore a separate automatically managed page account.

BoxOS deploys a content-addressed `default.css` blob for its default design
language. It is dark-first, follows the system light/dark preference, uses a
dark-blue accent, lightweight surfaces, and rounded corners. Startup example
pages link to this shared immutable stylesheet and build on its palette variables
and small component classes.

## Client events

Clients receive messages over Server-Sent Events rather than WebSockets. A page
opens a signed `POST /v1/events` stream for its own client ID, which is currently
its page-account public key. `ctx.message` notifications are collected during a
turn and broadcast from memory only after that turn commits. They are not stored
in SQLite and may be lost when the recipient is offline or the server fails
after commit. Applications must store durable data in box storage; reconnecting
clients reload that state. The reference client exposes SSE as `boxos.events`.


## Userspace implementations

Boxos hosts a reference client.js that can be requested under URL.client.js. Pages should use that client.
it will expose methods to communicate with the server and receive messages. it will store its clientId keys securely in the browser. A client Id should be persistent through page visits.

Boxos also hosts a CLI.js based on the client logic for easy integration with terminal agents.

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
