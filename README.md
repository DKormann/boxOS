# BOXOS 0.3

Design-stage software for immutable code, isolated state, and owned effects.

## Run

Requires [Bun](https://bun.sh/). There is no package manifest, dependency install, framework, or build step.

```sh
bun src/server.ts
```

The homepage is available at `http://localhost:3000`. It is loaded from and published as `examples/about.html`. Set `PORT` to use another port.

For development, opt into Bun's hot reload with:

```sh
bun src/server.ts --dev
```

Changes to `src/server.ts` restart the server. The client and example HTML are read on each request, so changes to those files appear on refresh without restarting. Production startup does not enable hot reload.

## Check

```sh
bunx tsc --noEmit
```

The server stores data in `boxos.sqlite` by default. Set `BOXOS_DB_URL` to another Bun SQLite URL when needed.

Implemented routes:

```text
POST /0.3.0/accounts
GET  /0.3.0/accounts/:publicKey
POST /0.3.0/blobs
GET  /0.3.0/blobs/:id
POST /0.3.0/boxes
GET  /0.3.0/boxes/:id
GET  /0.3.0/boxes/:id/state/public/:key
POST /0.3.0/invocations
POST /0.3.0/pages
GET  /0.3.0/examples
```

The reference browser client is served at `/client.js`. On startup, `examples/manifest.json` explicitly lists the example pages and optional boxes to publish. Referenced HTML and method files are stored through the ordinary blob, page, and box operations. Published URLs and box IDs are returned by `GET /0.3.0/examples`.

The counter example reads public state directly and uses only its published box, signed increment invocations, and atomic box state. It has no counter-specific server route or storage table.

Hosted pages are available at `https://<page-id>.boxos.org/`; production deployment requires wildcard DNS and TLS. During local development, use `http://<page-id>.localhost:3000/`. Both production and local URLs are printed at startup.

See `docs/architecture/protocol.md` for request formats. Validated methods, atomic state, owned Tasks, bounded HTTP requests, page hosting effects, and cross-box calls are implemented. Detailed effect metering and separately funded invocations are not yet available.
