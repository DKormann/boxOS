# BOXOS CLI

`bin/boxos` is the dependency-free Bun CLI for people, scripts, CI jobs, and coding agents. Commands emit JSON on stdout and return a nonzero status with a structured error on failure.

A server exposes the same executable at `/boxos`:

```sh
curl -fsSL https://boxos.org/boxos -o boxos
chmod +x boxos
./boxos --help
```

The CLI requires Bun and has no package dependencies.

## Configure

```sh
export BOXOS_URL=http://localhost:3000
# Optional isolated key directory for a project or CI job:
export BOXOS_CONFIG_DIR="$PWD/.boxos-agent"
```

The default key directory is `~/.config/boxos`. Directories and key files are restricted to the current user. Do not commit this directory.

## Create and inspect an account

```sh
bin/boxos account create --name deployer
bin/boxos account list
bin/boxos account show deployer
bin/boxos account use deployer
```

Export includes the private JWK and should be redirected only to a secure destination:

```sh
bin/boxos account export deployer > /secure/deployer.json
bin/boxos account import --name restored /secure/deployer.json
```

## Deploy a page

```sh
bin/boxos deploy page index.html
cat index.html | bin/boxos deploy page -
```

The result includes blob ID, page ID, production URL, local URL, reported fuel, and whether the page mapping was newly created.

## Deploy an application

```json
{
  "page": "index.html",
  "boxes": {
    "counter": {
      "runtime": "boxos-js/0.3.0",
      "instance": "production-counter",
      "methods": {
        "increment": { "source": "increment.js" }
      }
    }
  }
}
```

```sh
bin/boxos deploy app boxos.json
```

The manifest is a local deployment convenience, not a kernel object. Every method is uploaded as an ordinary blob, every box is created through `/0.3.0/boxes`, and the page is hosted through the normal blob/page operations.

## Invoke a method

```sh
bin/boxos invoke box_... increment --input '{"amount":1}'
bin/boxos invoke box_... update --input @input.json --fuel 2000000
```

The CLI fetches the selected account's strict nonce, creates the command, signs the exact domain-separated JSON, and submits it. Concurrent processes using one account still need external coordination because runtime 1 intentionally has one strict account nonce.

## Sign an application grant

```sh
bin/boxos grant sign \
  --subject APP_PUBLIC_KEY \
  --permission messaging
```

Or sign an application-defined message without imposing a BOXOS grant schema:

```sh
bin/boxos grant sign --message @grant.json
```

## Security

- Never pass a private key as a command-line argument.
- Use a dedicated account for each autonomous agent or deployment role.
- Treat account export output as a secret.
- Prefer `BOXOS_CONFIG_DIR` pointing to an ephemeral protected directory in CI.
- A BOXOS private key is full account authority; grants should be used when an agent needs narrower application authority.

## Current limitations

- Page hosting reports fuel but is not yet a signed, debited operation.
- Signed fuel transfer is not implemented by the server.
- Receipts are returned by invocation but do not yet have a retrieval API.
- Application manifests do not rewrite page source with deployed box IDs; consume the emitted JSON or use a separate configuration strategy.

## Related specifications

- [HTTP protocol](architecture/protocol.md)
- [Accounts and signatures](architecture/accounts.md)
- [Blobs and boxes](architecture/boxes.md)
- [Hosted pages](architecture/pages.md)
- [Method language](architecture/language.md)
- [Tasks and effects](architecture/tasks.md)
- [BOXOS values](architecture/values.md)
