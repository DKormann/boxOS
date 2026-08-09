# BOXOS

## A tiny backend made of transparent, permanent functions

BOXOS turns a small piece of restricted JavaScript into a persistent internet service.

Submit a function once. BOXOS hashes its exact source, stores it permanently, and gives it an immutable address. Anyone can inspect the code behind that address. There are no mutable deployments or hidden upgrades: if behavior can change, the authorization and upgrade rules must be visible in the function itself.

## Two simple building blocks

**Reducers** own private persistent state and update it transactionally. A reducer can expose selected values as public state while keeping other values private. Public and private versions of the same key are distinct. Reducers can use the caller’s stable user ID for permissions and ownership rules.

**Procedures** perform network requests and compose reducers inside atomic transactions. This separates external coordination from durable state changes without introducing a large application framework.

Together they are enough for counters, shared documents, APIs, games, small databases, and full web applications.

For user-owned application data, a browser account can sign a narrow capability for one reducer. BOXOS verifies its signature, immutable page origin, and resource before exposing the signed account as trusted reducer context; an account ID in ordinary input has no authority.

## Content-addressed web pages

BOXOS includes a permanent page reducer. Give it an HTML string and it stores the page under a short, collision-checked ID derived from SHA-256:

```text
http://cdj4ofshc6bwc4df.localhost:4000/
```

Each page receives its own browser origin. Static reads are public, cacheable, and free of execution fuel: no worker or transaction starts when somebody visits a page. A complete application can be one immutable HTML page calling a few immutable reducers.

## Fuel makes resource use explicit

Users are anonymous bearer identities with persistent fuel balances. Running code consumes fuel based on elapsed execution time. Permanent code and state consume fuel per stored byte. Deleting state returns its locked fuel to the deleting caller.

Successful calls refund unused runtime fuel. Errors, crashes, and timeouts do not. Every response reports its costs, making computation and storage visible rather than hiding them behind a cloud bill.

## Why BOXOS?

- **Transparent:** source is public and addressed by its hash.
- **Persistent:** reducer state survives requests and restarts.
- **Composable:** procedures combine reducers transactionally.
- **Isolated:** reducers cannot inspect one another’s private state.
- **Portable:** the client is a small JavaScript module served at `/client.js`.
- **Minimal:** Bun, TypeScript, SQLite, and standard web APIs—no framework or dependency stack.

BOXOS is an experiment in making backend software as easy to publish and inspect as a static file: write a few lines, receive a permanent address, and let the code explain exactly what it does.
