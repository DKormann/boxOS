# BOXOS agent guide

BOXOS is a Bun/TypeScript prototype for immutable blobs and pages, isolated stateful boxes, signed account commands, atomic state, and invocation-owned effects.

## Install the CLI

A repository checkout already contains `bin/boxos`. From a running or deployed BOXOS server, download the same dependency-free Bun executable:

```sh
curl -fsSL "$BOXOS_URL/boxos" -o boxos
chmod +x boxos
./boxos --help
```

The CLI requires [Bun](https://bun.sh/) and has no package dependencies.

## Fast path: deploy a page

```sh
# Terminal 1
bun src/server.ts --dev

# Terminal 2
export BOXOS_URL=http://localhost:3000
bin/boxos account create --name agent
bin/boxos deploy page ./index.html
```

The deployment command prints machine-readable JSON containing the immutable production and local URLs.

## Fast path: deploy an app

Create a local deployment manifest:

```json
{
  "page": "index.html",
  "boxes": {
    "app": {
      "runtime": "boxos-js/0.3.0",
      "instance": "agent-demo",
      "methods": {
        "run": { "source": "run.js" }
      }
    }
  }
}
```

Then run:

```sh
bin/boxos deploy app boxos.json
```

## Validation

Before reporting work complete:

```sh
bun test
bunx tsc --noEmit
git diff --check
```

## Rules for agents

1. Do not edit or commit private keys, `~/.config/boxos`, or a configured `BOXOS_CONFIG_DIR`.
2. Do not pass private keys on command lines.
3. Prefer a dedicated account per agent/project.
4. Preserve plain `JSON.stringify` property order when hashing or signing protocol values.
5. Use the CLI instead of reimplementing Ed25519 command signing.
6. Boxes never share transactions. Put state participating in one invariant in one box.
7. Effects and cross-box calls are forbidden inside `ctx.atomic`.
8. Public profile names are read from the Profile box; do not create a second name registry.
9. Wallet pages are ordinary unprivileged pages. Grants are application-defined signed messages.
10. Example pages are declared in `examples/manifest.json` and republished at startup.

## Repository map

```text
bin/boxos                 dependency-free agent CLI
src/server.ts             HTTP kernel and effect host
src/worker.ts             restricted invocation runtime and Task scope
src/parser.ts             method source validator
src/values.ts             shared BOXOS value validation
src/encoding.ts           hashes and domain-separated encoding
public/client.js          browser reference client
examples/                 immutable example pages and methods
docs/architecture/        normative implementation design
tests/                    parser, values, encoding, and server integration tests
```

## Relevant resources

Start with:

- [CLI guide](docs/cli.md)
- [Architecture overview](docs/architecture/README.md)
- [HTTP protocol](docs/architecture/protocol.md)
- [Accounts, signatures, and grants](docs/architecture/accounts.md)
- [Blobs, boxes, and methods](docs/architecture/boxes.md)
- [Invocation and atomic state](docs/architecture/execution.md)
- [Tasks and effects](docs/architecture/tasks.md)
- [Hosted pages](docs/architecture/pages.md)
- [Method language](docs/architecture/language.md)
- [Value limits](docs/architecture/values.md)

Runtime discovery:

```sh
curl -fsSL "$BOXOS_URL/boxos" -o boxos
bin/boxos --help
curl "$BOXOS_URL/0.3.0/examples"
curl "$BOXOS_URL/0.3.0/accounts/PUBLIC_KEY"
```

Project homepage and upstream repository:

- https://boxos.org/
- https://github.com/DKormann/boxOS

## Known gaps

The CLI exposes only operations currently supported by the 0.3.0 server. Signed fuel transfers, authenticated/debited page hosting, durable receipt lookup, and robust multi-process nonce allocation remain to be implemented.
