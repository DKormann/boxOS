


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
Individual method calls are however commited atomically, but their effects may be aborted in any way.

## Defining a Box
A Box is defined by its methods and its individual storage space.
The methods are just blobs of validated code. The box definition is publicly readable.
The box storage is distinguished in public and private storage.
The only way to write to a box storage is through invocation of the boxes methods.

Boxos defines a safe subset of JS to be available to define Box methods.
particularly not allowed:
 - using undefined global variables
 - classes, inheritance, prototypes
 - runtime code evaluation
 - async
 - general effects

Each box method gets as first argument a ctx. this offers different kinds of effects:
 - storage: read and write to private and public storage of that box
 - invoke(boxid, methodname, argument, callback): invokes another box with pure data
 - message(clientid, message): messages a client session
 - publish(kind: "box" | "blob" | "page" | "account", args): creates a public entity
 - transfer(senderPub, privkey, receiverPub): transfer fuel if you have 

ctx also exposes the account behind the invokation and the clientId
invoking a new box method will also inherit the same account and client. all subsequent fuel usage will be credited to the same account.

## Pages
each page is backed by a blob. it is reachable under a shortened hash. under the url <hash>.boxos.org or <hash>.localhost:port for development.
pages are immutable client definitions.





## Userspace implementations

Boxos hosts a reference client.js that can be requested under URL.client.js. Pages should use that client.
it will expose methods to communicate with the server and receive messages. it will store its clientId keys securely in the browser. A client Id should be persistent through page visits.

Boxos also hosts a CLI.js based on the client logic for easy integration with terminal agents.

A Boxos app is a page that uses specific Boxes. pages do share functionality by reusing boxes, therefore apps are natively interoperable.

Per default Boxos offers multiple apps:

### Accounts App
here a user can manage multiple accounts backed by privatekeys stored securely in the browser. other apps will want to connect their user profiles to a pubkey. for that they can redirect to the accounts app which might sign an access grant for using that app.
for instance there might be a grant to manage a users private messages or public profile. multiple different apps could each have that grant for a user account. It also means a user can easily manage multiple accounts. The app flow is based on sign in with google flow

### Social App
This app looks like whatsapp.
It uses multiple different Boxes to provide private messages, group messages, public username, following muting and blocking other accounts.
It requests all these grants from accounts on first visit.
It uses messaging to the client to offer notificiations.
