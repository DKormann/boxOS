# BOXOS

**A tiny backend made of transparent, permanent functions.**

BOXOS turns restricted JavaScript and ordinary HTML into persistent internet applications. Source is stored under the SHA-256 hash of its exact contents, making every backend function immutable, inspectable, and permanently addressable.

**Current release: BOXOS 0.2.0 · runtime 1.** Query any server at `GET /version`.

> **0.2 stability warning:** BOXOS currently provides no durability or compatibility guarantees whatsoever. APIs, runtime behavior, hashes, pages, state, accounts, grants, browser origins, and stored data may change or be deleted without migration. Keep your own source and data. The present priority is the beauty of the long-term design, not preservation of current deployments.

```text
HTML page  ──invoke──▶  reducer  ──transaction──▶  private/public state
     │
     └──────────────▶  procedure ──fetch / compose reducers / publish code
```

## Why it is different

- **Transparent:** executable source is public and addressed by its hash.
- **Permanent:** code and pages cannot be changed in place.
- **Stateful:** reducers own isolated, transactional keyspaces.
- **Composable:** procedures call multiple reducers in one atomic transaction.
- **Capability-based:** signed accounts grant one immutable origin narrowly scoped access to one reducer.
- **Portable:** an application can be one HTML file importing the dependency-free `/client.js` module.
- **Explicit:** runtime and permanent storage consume visible fuel.

## Build an app

Start with a normal HTML document:

```html
<!doctype html>
<meta charset="utf-8">
<title>Hello BOXOS</title>
<h1>Hello BOXOS</h1>
<script type="module">
  import { BoxOSClient } from "/client.js";
  const boxos = new BoxOSClient();
  console.log(await boxos.account());
</script>
```

Publish it through the built-in page reducer and receive a permanent, isolated origin such as:

```text
https://cdj4ofshc6bwc4df.pages.boxos.org/
```

When the app needs durable state, add a reducer:

```js
let count = await ctx.state.public.get("count") || 0;
count += 1;
ctx.state.public.set("count", count);
return count;
```

See the **[application quickstart](docs/quickstart.md)** for a complete publication script.

> **Coding agents:** the hosted experiment publishes a compact onboarding contract at [`https://boxos.org/agents`](https://boxos.org/agents). It explains how to build, validate, publish, and report a BOXOS application without repository-specific knowledge.

## Core primitives

### Reducers

Reducers update their own private and public state transactionally. They receive only explicit capabilities and cannot inspect another reducer’s private state. The original caller and any runtime-verified signed authorization are available through trusted context.

### Procedures

Procedures perform external requests, validate or publish immutable code, and compose reducers through atomic transactions. External effects such as fetch and publication are deliberately not rolled back with state.

### Immutable pages

The page reducer stores HTML under a short, collision-checked ID derived from SHA-256. Static page requests do not start a worker or transaction and consume no runtime fuel. Every page ID receives a separate browser origin.

### Fuel

Anonymous bearer identities have persistent balances. Calls reserve a chosen runtime budget and successful calls refund unused fuel. Permanent code and state lock fuel according to their stored byte size.

## Run locally

Requirements: a current version of [Bun](https://bun.sh).

```sh
bun src/server.ts
```

Open `http://localhost:4000`. The server creates `boxos.sqlite` and an owner-only deployment recovery key beside it. Both should be persisted together in a real deployment.

Useful commands:

```sh
bun test
bunx tsc --noEmit
HOST=0.0.0.0 PORT=4000 bun src/server.ts
```

Configuration:

- `HOST`, `PORT` — listening address, defaulting to `127.0.0.1:4000`
- `BOXOS_DB_PATH` — SQLite path
- `BOXOS_WORKER_POOL_SIZE`, `BOXOS_WORKER_QUEUE_LIMIT` — execution concurrency
- `BOXOS_ROOT_URL`, `PAGE_BASE_DOMAIN` — public reverse-proxy and page-origin URLs
- `BOXOS_SYSTEM_KEY_PATH` or `BOXOS_SYSTEM_RECOVERY_KEY` — deployment identity recovery

## Documentation

- [Build your first application](docs/quickstart.md)
- [Agent onboarding contract](docs/agents.md)
- [HTTP API and runtime reference](docs/api.md)
- [Signed accounts and capabilities](docs/accounts.md)
- [Architecture and trust model](docs/proposal.md)
- [Development phase and stability policy](docs/development.md)
- [Transaction architecture](docs/transactions.md)
- [Studio design](docs/editor-concept.md)
- [Example applications](examples/)

Production documentation is served at [`https://boxos.org/docs`](https://boxos.org/docs).

## Trust and scope

BOXOS is an experiment, not an operating-system sandbox. Its trusted computing base includes the restricted-language parser, worker capability wrappers, transaction coordinator, SQLite, Bun, and SHA-256. Worker limits bound execution, but external fetch effects cannot be rolled back, bearer credentials can be copied, and anonymous account creation is not Sybil-resistant.

The architecture intentionally favors a small, inspectable kernel over a broad application platform. See the [architecture proposal](docs/proposal.md) for the complete model and explicit limitations.
