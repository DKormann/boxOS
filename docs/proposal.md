# BOXOS architecture proposal

## Idea

BOXOS makes a backend from small, transparent pieces of restricted JavaScript.

Source is stored under the SHA-256 hash of its exact contents. The hash is its permanent address: code cannot be changed in place, and anyone can inspect it. Upgrade behavior must therefore be expressed in code—along with its authorization rules—rather than hidden behind a mutable deployment.

The goal is to make publishing a backend resemble publishing a static file: submit a few lines, receive an address, and let the code explain what it does.

## Reducers and procedures

A **reducer** owns an isolated persistent keyspace. It reads and writes that state transactionally and cannot inspect another reducer's state. Every key has distinct public and private slots. Only the reducer can write them; public slots are readable over HTTP while private slots remain encapsulated.

A **procedure** coordinates external work. It can make fetch requests, validate and publish new immutable code, and open a transaction that composes multiple reducers. Calls in one transaction commit atomically and retain the identity of the original caller.

This split keeps durable state changes deterministic and inspectable while still allowing applications to interact with the wider web.

## Identity and economics

Users are implicit fuel accounts controlled by unguessable bearer credentials. Functions receive a stable hash-derived caller ID, never the credential itself. Separately, browser-owned Ed25519 identities can grant an immutable page a narrow capability on one reducer. The runtime verifies the signature, audience, and resource before exposing the signed account to that reducer; account IDs supplied as ordinary input carry no authority.

Every account has fuel. Runtime reserves a caller-selected budget and charges for elapsed execution time. Permanent code and state charge by stored byte. Successful calls return unused runtime fuel; failures do not. Deleting state releases its locked fuel to the deleting caller.

Fuel makes resource use part of the protocol rather than an invisible infrastructure bill. The initial allocation is deliberately simple and is an accounting mechanism, not Sybil resistance.

## Immutable pages

A built-in reducer stores an HTML string under a short content ID derived from SHA-256. The page is then served directly from public state at its own origin:

```text
https://<page-id>.pages.boxos.org/
```

Static reads require no identity, worker, transaction, or fuel. Each ID receives a separate browser origin, isolating pages from one another. A complete application can be one immutable HTML page calling a handful of immutable reducers.

## Trust model

BOXOS relies on its parser, capability wrappers, worker runtime, transaction coordinator, SQLite, Bun, and SHA-256. Restricted functions receive only explicit capabilities. Timeouts and system resource limits bound execution, but workers are not an operating-system process sandbox.

External fetch effects cannot be rolled back with database state. Bearer credentials can be stolen. Anonymous account creation permits Sybil farming. Wall-clock fuel is simpler but less deterministic than instruction metering. These are explicit constraints, not hidden guarantees.

## Direction

BOXOS favors a small, inspectable system over a broad platform:

- immutable public code;
- isolated transactional state;
- explicit caller identity;
- composable procedures;
- content-addressed pages;
- visible resource accounting;
- standard HTTP and JavaScript clients.

The experiment asks whether these primitives are enough to build useful internet software without conventional deployments, mutable servers, or framework-heavy infrastructure.
