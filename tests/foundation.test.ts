import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { touchAccount } from "../src/accounts/accounts.ts"
import { validateBoxDefinition } from "../src/core/box-definition.ts"
import { bytesToHex, sha256Hex } from "../src/core/crypto.ts"
import { stringifyBoxValue, type BoxValue } from "../src/core/values.ts"
import { deployStartupExamples } from "../examples/startup/deploy.ts"
import { buildCli } from "../scripts/build_cli.ts"
import { EffectDispatcher } from "../src/effects/dispatcher.ts"
import { isPublicNetworkAddress, parseStructuredRequest } from "../src/effects/request.ts"
import { executeTurn } from "../src/execution/turn.ts"
import { publishBox } from "../src/operations/operations.ts"
import {
  isValidCallbackCode,
  isValidMethodCode,
  validateCallbackCode,
} from "../src/language/parser.ts"
import {
  BoxOSService,
  boxPublicationSigningMessage,
  clientOperationSigningMessage,
  invocationSigningMessage,
  type BoxPublicationRequest,
  type ClientOperationRequest,
  type InvocationRequest,
} from "../src/server/service.ts"
import { openDatabase } from "../src/storage/database.ts"
import { NativeBoxWorker } from "../src/workers/native-worker.ts"
import {
  BoxScheduler,
  type BoxWorker,
  type ClientNotification,
  type WorkerTurn,
  type WorkerTurnResult,
} from "../src/workers/scheduler.ts"

function installBox(database: ReturnType<typeof openDatabase>): void {
  database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run("account-a", 1_000)
  database.query("INSERT INTO boxes (id, definition, created_at) VALUES (?, ?, ?)").run(
    "box-a",
    "{}",
    Date.now(),
  )
}

async function drain(dispatcher: EffectDispatcher): Promise<void> {
  while (await dispatcher.dispatchNext()) { /* drain durable work */ }
}

function methodTurn(id: string, source: string): WorkerTurn {
  return {
    id,
    boxId: "box-a",
    account: "account-a",
    clientId: null,
    procedure: { kind: "method", source, input: null },
  }
}

test("the landing page uses the BoxOS design and guides agents", async () => {
  const source = await Bun.file(new URL("../public/index.html", import.meta.url)).text()
  expect(source.includes('/v1/blobs/{{DEFAULT_CSS}}')).toBe(true)
  expect(source.includes("Try BoxOS")).toBe(true)
  expect(source.includes('href="/boxos-cli.js"')).toBe(true)
  expect(source.includes('href="/developers"')).toBe(true)
  expect(source.includes("agents: read /AGENTS.md")).toBe(true)

  const docs = await Bun.file(new URL("../public/developers.html", import.meta.url)).text()
  expect(docs.includes('/v1/blobs/{{DEFAULT_CSS}}')).toBe(true)
  expect(docs.includes("Durable Tasks")).toBe(true)
  expect(docs.includes("https://boxos.org/boxos-cli.js")).toBe(true)
})

test("the standalone CLI is generated and runs with Bun and Node", async () => {
  const directory = `/tmp/boxos-cli-${crypto.randomUUID()}`
  const key = `${directory}/account.json`
  const cli = decodeURIComponent(new URL("../public/boxos-cli.js", import.meta.url).pathname)
  const bun = Bun.which("bun")!
  try {
    expect(await Bun.file(cli).text()).toBe(await buildCli())
    const node = Bun.which("node")
    if (node) {
      expect(Bun.spawnSync({
        cmd: [node, cli, "--version"],
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode).toBe(0)
    }
    const created = Bun.spawnSync({
      cmd: [bun, cli, "--key", key, "account", "create"],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(created.exitCode).toBe(0)
    const account = JSON.parse(new TextDecoder().decode(created.stdout!)).account
    expect(typeof account == "string" && account.length == 64).toBe(true)
    if (node) {
      expect(Bun.spawnSync({
        cmd: [node, cli, "--key", key, "account", "show"],
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode).toBe(0)
    }

    const shown = Bun.spawnSync({
      cmd: [bun, cli, "--key", key, "account", "show"],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(shown.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(shown.stdout!)).account).toBe(account)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the CLI links and transitively publishes local box references", async () => {
  const directory = `/tmp/boxos-cli-links-${crypto.randomUUID()}`
  const key = `${directory}/account.json`
  const cli = decodeURIComponent(new URL("../public/boxos-cli.js", import.meta.url).pathname)
  const bun = Bun.which("bun")!
  const runtime = Bun.which("node") ?? bun
  const definitions: unknown[] = []
  let pageSource = ""
  const boxIds: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as {
        request: { definition?: unknown; operation?: { type: string; text?: string } }
      }
      if (new URL(request.url).pathname == "/v1/boxes") {
        definitions.push(body.request.definition)
        const id = await sha256Hex(stringifyBoxValue(body.request.definition))
        boxIds.push(id)
        return Response.json({ id })
      }
      const operation = body.request.operation!
      if (operation.type == "publishBlob") {
        pageSource = operation.text!
        return Response.json({ id: "b".repeat(64) })
      }
      if (operation.type == "publishPage") return Response.json({ id: "c".repeat(16) })
      return Response.json({ error: "Unexpected operation" }, { status: 400 })
    },
  })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/leaf.box.json`, JSON.stringify({
      methods: { read: "return input;" },
    }))
    await writeFile(`${directory}/middle.box.json`, JSON.stringify({
      methods: {
        read: "return ctx.invoke(\"{{BOXOS_BOX:./leaf.box.json}}\", \"read\", input);",
      },
    }))
    await writeFile(
      `${directory}/index.html`,
      `<script>const box = "{{BOXOS_BOX:./middle.box.json}}";</script>`,
    )
    expect(Bun.spawnSync({
      cmd: [bun, cli, "--key", key, "account", "create"],
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode).toBe(0)

    const process = Bun.spawn({
      cmd: [runtime, cli, "--url", server.url.href, "--key", key, "page", "publish", `${directory}/index.html`],
      stdout: "pipe",
      stderr: "pipe",
    }) as ReturnType<typeof Bun.spawn> & { exited: Promise<number> }
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout!).text(),
      new Response(process.stderr!).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.id).toBe("c".repeat(16))
    expect(result.boxes.map((box: { id: string }) => box.id)).toEqual(boxIds)
    expect(JSON.stringify(definitions[1]).includes(boxIds[0]!)).toBe(true)
    expect(pageSource.includes(boxIds[1]!)).toBe(true)
    expect(pageSource.includes("BOXOS_BOX")).toBe(false)

    await writeFile(`${directory}/invalid.box.json`, JSON.stringify({
      methods: { run: "return window.value;" },
    }))
    await writeFile(
      `${directory}/invalid.html`,
      `<script>const box = "{{BOXOS_BOX:./invalid.box.json}}";</script>`,
    )
    const invalid = Bun.spawn({
      cmd: [runtime, cli, "--url", server.url.href, "--key", key, "page", "publish", `${directory}/invalid.html`],
      stdout: "pipe",
      stderr: "pipe",
    }) as ReturnType<typeof Bun.spawn> & { exited: Promise<number> }
    const [invalidExit, invalidError] = await Promise.all([
      invalid.exited,
      new Response(invalid.stderr!).text(),
    ])
    expect(invalidExit).toBe(1)
    expect(invalidError.includes("invalid.box.json")).toBe(true)
    expect(invalidError.includes("Unknown variable 'window'")).toBe(true)
    expect(definitions.length).toBe(2)
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("canonical BOXOS values are independent of object insertion order", () => {
  expect(stringifyBoxValue({ z: 1, a: { y: true, x: null } })).toBe(
    stringifyBoxValue({ a: { x: null, y: true }, z: 1 }),
  )
})

test("an optional nonce creates a distinct box without account-bound identity", async () => {
  const database = openDatabase(":memory:")
  try {
    const methods = { read: "return input;" }
    const canonical = await publishBox(database, { methods })
    expect(await publishBox(database, { methods })).toBe(canonical)

    const first = await publishBox(database, {
      nonce: "first-box-nonce-value",
      methods,
    })
    expect(await publishBox(database, {
      nonce: "first-box-nonce-value",
      methods,
    })).toBe(first)
    const second = await publishBox(database, {
      nonce: "second-box-nonce-value",
      methods,
    })

    expect(first == canonical).toBe(false)
    expect(second == first).toBe(false)
    expect(database.query<{ count: number }>(
      "SELECT count(*) AS count FROM boxes",
    ).get()?.count).toBe(3)
    expect(database.query<{ definition: string }>(
      "SELECT definition FROM boxes WHERE id = ?",
    ).get(first)?.definition).toBe(
      stringifyBoxValue({ methods, nonce: "first-box-nonce-value" }),
    )
    expect(() => validateBoxDefinition({ nonce: "short", methods })).toThrow()
  } finally {
    database.close()
  }
})

test("methods reject ambient authority and asynchronous code", () => {
  expect(isValidMethodCode("return input.value;")).toBe(true)
  expect(isValidMethodCode("return globalThis.process;")).toBe(false)
  expect(isValidMethodCode("return input.constructor;")).toBe(false)
  expect(isValidMethodCode("return await ctx.invoke(input.box, 'run', null);")).toBe(false)
})

test("serialized callbacks use the method parser and cannot capture locals", () => {
  const callback = function completed(result: unknown, context: { key: string }) {
    ctx.storage.private.set(context.key, result)
  }
  expect(() => validateCallbackCode(Function.prototype.toString.call(callback))).not.toThrow()

  expect(isValidCallbackCode("function completed(result) { return missing + result; }")).toBe(false)
  expect(isValidCallbackCode("(result) => result")).toBe(false)
})

test("structured requests admit public HTTPS JSON APIs without raw transport access", () => {
  expect(parseStructuredRequest({
    host: "API.Example.com",
    path: "/v1/chat?mode=fast",
    method: "POST",
    headers: { Authorization: "Bearer secret", "X-Api-Key": "key" },
    body: { messages: [{ role: "user", content: "Hello" }] },
  })).toEqual({
    host: "api.example.com",
    path: "/v1/chat?mode=fast",
    method: "POST",
    headers: { authorization: "Bearer secret", "x-api-key": "key" },
    body: { messages: [{ role: "user", content: "Hello" }] },
  })
  expect(() => parseStructuredRequest({ host: "127.0.0.1", path: "/", method: "GET" })).toThrow()
  expect(() => parseStructuredRequest({ host: "example.com", path: "//other", method: "GET" })).toThrow()
  expect(() => parseStructuredRequest({
    host: "example.com",
    path: "/",
    method: "POST",
    headers: { Host: "internal" },
  })).toThrow()
  expect(isPublicNetworkAddress("93.184.216.34", 4)).toBe(true)
  expect(isPublicNetworkAddress("10.0.0.1", 4)).toBe(false)
  expect(isPublicNetworkAddress("127.0.0.1", 4)).toBe(false)
  expect(isPublicNetworkAddress("2606:2800:220:1:248:1893:25c8:1946", 6)).toBe(true)
  expect(isPublicNetworkAddress("fc00::1", 6)).toBe(false)
  expect(isPublicNetworkAddress("::1", 6)).toBe(false)
})

test("accounts are created and lazily topped up on interaction", () => {
  const database = openDatabase(":memory:")
  const policy = { initialFuel: 100, topUpFuel: 50, topUpIntervalMilliseconds: 100 }
  try {
    expect(touchAccount(database, "account", policy, 1_000)).toBe(100)
    database.query("UPDATE accounts SET fuel = 20 WHERE pubkey = 'account'").run()
    expect(touchAccount(database, "account", policy, 1_050)).toBe(20)
    expect(touchAccount(database, "account", policy, 1_100)).toBe(50)
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = 'account'",
    ).get()?.fuel).toBe(50)
  } finally {
    database.close()
  }
})

test("database initialization installs the first schema", () => {
  const database = openDatabase(":memory:")
  try {
    expect(database.query<{ timeout: number }>(
      "PRAGMA busy_timeout",
    ).get()?.timeout).toBe(5_000)
    const tables = database.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map(row => row.name)
    expect(tables).toEqual([
      "accounts",
      "blobs",
      "box_methods",
      "box_state",
      "boxes",
      "client_operations",
      "effects",
      "pages",
      "schema_meta",
      "startup_deployments",
      "task_continuations",
      "tasks",
      "turns",
    ])
  } finally {
    database.close()
  }
})

test("startup examples deploy account grants and public profiles", async () => {
  const database = openDatabase(":memory:")
  try {
    const deployment = await deployStartupExamples(database)
    expect(deployment.defaultCssBlobId.length).toBe(64)
    expect(deployment.grantsBoxId.length).toBe(64)
    expect(deployment.profilesBoxId.length).toBe(64)
    expect(deployment.accountsPageId.length).toBe(16)
    expect(deployment.profilePageId.length).toBe(16)
    expect(deployment.messagesBoxId.length).toBe(64)
    expect(deployment.socialPageId.length).toBe(16)
    expect(deployment.appsBoxId.length).toBe(64)
    expect(deployment.explorerPageId.length).toBe(16)
    expect(database.query<{ count: number }>(
      "SELECT count(*) AS count FROM startup_deployments",
    ).get()?.count).toBe(9)
    const page = database.query<{ bytes: Uint8Array }>(
      `SELECT blobs.bytes FROM pages JOIN blobs ON blobs.id = pages.blob_id
       WHERE pages.id = ?`,
    ).get(deployment.accountsPageId)
    const pageSource = new TextDecoder().decode(page?.bytes)
    expect(pageSource.includes("Choose an account")).toBe(true)
    expect(pageSource.includes("Copy key")).toBe(true)
    expect(pageSource.includes('id="import"')).toBe(true)
    expect(pageSource.includes("boxos-key-v1:")).toBe(true)
    expect(pageSource.includes("Display name")).toBe(false)
    expect(pageSource.includes("Change username")).toBe(false)
    const moduleMatch = pageSource.match(/<script type="module">([\s\S]*?)<\/script>/)
    if (!moduleMatch) throw new Error("Accounts page has no module script")
    const moduleSource = moduleMatch[1]!.replace(
      '    import { boxos } from "/client.js";\n',
      "",
    )
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor
    expect(() => new AsyncFunction(moduleSource)).not.toThrow()
    const profilePage = database.query<{ bytes: Uint8Array }>(
      `SELECT blobs.bytes FROM pages JOIN blobs ON blobs.id = pages.blob_id
       WHERE pages.id = ?`,
    ).get(deployment.profilePageId)
    const profileSource = new TextDecoder().decode(profilePage?.bytes)
    expect(profileSource.includes("Public profile")).toBe(true)
    const profileModule = profileSource.match(/<script type="module">([\s\S]*?)<\/script>/)
    if (!profileModule) throw new Error("Profile page has no module script")
    expect(() => new AsyncFunction(profileModule[1]!.replace(
      '    import { boxos } from "/client.js";\n',
      "",
    ))).not.toThrow()

    const socialPage = database.query<{ bytes: Uint8Array }>(
      `SELECT blobs.bytes FROM pages JOIN blobs ON blobs.id = pages.blob_id
       WHERE pages.id = ?`,
    ).get(deployment.socialPageId)
    const socialSource = new TextDecoder().decode(socialPage?.bytes)
    expect(socialSource.includes("manage messages,manage account")).toBe(true)
    expect(socialSource.includes("[hidden] { display: none !important; }")).toBe(true)
    const socialModule = socialSource.match(/<script type="module">([\s\S]*?)<\/script>/)
    if (!socialModule) throw new Error("Social page has no module script")
    expect(() => new AsyncFunction(socialModule[1]!.replace(
      '    import { boxos } from "/client.js";\n',
      "",
    ))).not.toThrow()

    const explorerPage = database.query<{ bytes: Uint8Array }>(
      `SELECT blobs.bytes FROM pages JOIN blobs ON blobs.id = pages.blob_id
       WHERE pages.id = ?`,
    ).get(deployment.explorerPageId)
    const explorerSource = new TextDecoder().decode(explorerPage?.bytes)
    expect(explorerSource.includes("Discover")).toBe(true)
    expect(explorerSource.includes("New version")).toBe(true)
    expect(explorerSource.includes("manage apps")).toBe(true)
    expect(explorerSource.includes("agents: read /AGENTS.md")).toBe(true)
    const explorerModule = explorerSource.match(/<script type="module">([\s\S]*?)<\/script>/)
    if (!explorerModule) throw new Error("App Explorer page has no module script")
    expect(() => new AsyncFunction(explorerModule[1]!.replace(
      '    import { boxos } from "/client.js";\n',
      "",
    ))).not.toThrow()

    const identity = "a".repeat(64)
    const profileManager = "b".repeat(64)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(identity, 1_000)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(profileManager, 1_000)
    const method = (boxId: string, name: string) => database.query<{ source: string }>(
      "SELECT source FROM box_methods WHERE box_id = ? AND name = ?",
    ).get(boxId, name)!.source
    expect(executeTurn(database, {
      id: "grant-manage-account",
      boxId: deployment.grantsBoxId,
      account: identity,
      clientId: identity,
      procedure: {
        kind: "method",
        source: method(deployment.grantsBoxId, "grant"),
        input: { grantee: profileManager, permission: "manage account" },
      },
    }).ok).toBe(true)
    expect(executeTurn(database, {
      id: "set-profile-name",
      boxId: deployment.profilesBoxId,
      account: profileManager,
      clientId: profileManager,
      procedure: {
        kind: "method",
        source: method(deployment.profilesBoxId, "setName"),
        input: { account: identity, name: "Ada", requestId: "request" },
      },
    }).ok).toBe(true)
    const scheduler = new BoxScheduler()
    const notifications: ClientNotification[] = []
    scheduler.setNotificationHandler(notification => {
      notifications.push(notification)
      return true
    })
    scheduler.addWorker({
      id: "startup-worker",
      async execute(turn: WorkerTurn) { return executeTurn(database, turn) },
    })
    const dispatcher = new EffectDispatcher(database, scheduler)
    await drain(dispatcher)
    expect(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND key = ?",
    ).get(deployment.profilesBoxId, `name|${identity}`)?.value).toBe('"Ada"')

    expect(executeTurn(database, {
      id: "rename-profile",
      boxId: deployment.profilesBoxId,
      account: profileManager,
      clientId: profileManager,
      procedure: {
        kind: "method",
        source: method(deployment.profilesBoxId, "setName"),
        input: { account: identity, name: "Augusta", requestId: "change" },
      },
    }).ok).toBe(true)
    await drain(dispatcher)
    expect(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND key = ?",
    ).get(deployment.profilesBoxId, `name|${identity}`)?.value).toBe('"Augusta"')

    const recipient = "c".repeat(64)
    const recipientManager = "d".repeat(64)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(recipient, 1_000)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(recipientManager, 1_000)
    for (const [id, owner, manager] of [
      ["grant-sender-messages", identity, profileManager],
      ["grant-recipient-messages", recipient, recipientManager],
    ] as const) {
      expect(executeTurn(database, {
        id,
        boxId: deployment.grantsBoxId,
        account: owner,
        clientId: owner,
        procedure: {
          kind: "method",
          source: method(deployment.grantsBoxId, "grant"),
          input: { grantee: manager, permission: "manage messages" },
        },
      }).ok).toBe(true)
    }
    for (const [id, owner, manager] of [
      ["connect-sender", identity, profileManager],
      ["connect-recipient", recipient, recipientManager],
    ] as const) {
      expect(executeTurn(database, {
        id,
        boxId: deployment.messagesBoxId,
        account: manager,
        clientId: manager,
        procedure: {
          kind: "method",
          source: method(deployment.messagesBoxId, "connect"),
          input: { owner },
        },
      }).ok).toBe(true)
      await drain(dispatcher)
    }
    expect(executeTurn(database, {
      id: "send-message",
      boxId: deployment.messagesBoxId,
      account: profileManager,
      clientId: profileManager,
      procedure: {
        kind: "method",
        source: method(deployment.messagesBoxId, "send"),
        input: { owner: identity, recipient, text: "Hello", messageId: "message-1" },
      },
    }).ok).toBe(true)
    await drain(dispatcher)
    const history = database.query<{ value: string }>(
      `SELECT value FROM box_state
       WHERE box_id = ? AND visibility = 'private' AND key = ?`,
    ).get(deployment.messagesBoxId, `history|${recipient}|${identity}`)
    expect(history?.value.includes("Hello")).toBe(true)
    const delivered = notifications.find(notification =>
      notification.clientId == recipientManager
      && stringifyBoxValue(notification.message).includes("chat.message")
    )
    expect(delivered != null).toBe(true)
  } finally {
    database.close()
  }
})

test("the app catalog publishes versions and keeps installations private", async () => {
  const database = openDatabase(":memory:")
  try {
    const deployment = await deployStartupExamples(database)
    const owner = "a".repeat(64)
    const appAccount = "b".repeat(64)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(owner, 1_000)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(appAccount, 1_000)
    const source = (boxId: string, name: string) => database.query<{ source: string }>(
      "SELECT source FROM box_methods WHERE box_id = ? AND name = ?",
    ).get(boxId, name)!.source

    expect(executeTurn(database, {
      id: "grant-apps",
      boxId: deployment.grantsBoxId,
      account: owner,
      clientId: owner,
      procedure: {
        kind: "method",
        source: source(deployment.grantsBoxId, "grant"),
        input: { grantee: appAccount, permission: "manage apps" },
      },
    }).ok).toBe(true)

    const scheduler = new BoxScheduler()
    scheduler.addWorker({
      id: "apps-worker",
      async execute(turn: WorkerTurn) { return executeTurn(database, turn) },
    })
    const dispatcher = new EffectDispatcher(database, scheduler)
    async function appsTurn(id: string, method: string, input: Record<string, BoxValue>): Promise<void> {
      expect(executeTurn(database, {
        id,
        boxId: deployment.appsBoxId,
        account: appAccount,
        clientId: appAccount,
        procedure: { kind: "method", source: source(deployment.appsBoxId, method), input },
      }).ok).toBe(true)
      await drain(dispatcher)
    }

    await appsTurn("publish-app", "publish", {
      owner,
      name: "Notes",
      pageId: "0123456789abcdef",
      requestId: "app-one",
    })
    expect(JSON.parse(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'public' AND key = 'app|app-one'",
    ).get(deployment.appsBoxId)!.value)).toEqual({
      id: "app-one",
      name: "Notes",
      owner,
      pageId: "0123456789abcdef",
      version: 1,
    })

    await appsTurn("install-app", "install", { owner, appId: "app-one", requestId: "install-one" })
    expect(JSON.parse(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'private' AND key = ?",
    ).get(deployment.appsBoxId, `installed|${owner}`)!.value)).toEqual([{ appId: "app-one", version: 1 }])
    expect(database.query(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'public' AND key = ?",
    ).get(deployment.appsBoxId, `installed|${owner}`)).toBe(null)

    await appsTurn("update-app", "update", {
      owner,
      appId: "app-one",
      name: "Notes",
      pageId: "fedcba9876543210",
      requestId: "version-two",
    })
    expect(JSON.parse(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'public' AND key = 'versions|app-one'",
    ).get(deployment.appsBoxId)!.value)).toEqual([
      { pageId: "0123456789abcdef", version: 1 },
      { pageId: "fedcba9876543210", version: 2 },
    ])
    expect(JSON.parse(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'private' AND key = ?",
    ).get(deployment.appsBoxId, `installed|${owner}`)!.value)).toEqual([{ appId: "app-one", version: 1 }])

    const otherOwner = "c".repeat(64)
    database.query("INSERT INTO accounts (pubkey, fuel) VALUES (?, ?)").run(otherOwner, 1_000)
    expect(executeTurn(database, {
      id: "grant-other-apps",
      boxId: deployment.grantsBoxId,
      account: otherOwner,
      clientId: otherOwner,
      procedure: {
        kind: "method",
        source: source(deployment.grantsBoxId, "grant"),
        input: { grantee: appAccount, permission: "manage apps" },
      },
    }).ok).toBe(true)
    await appsTurn("reject-other-publisher", "update", {
      owner: otherOwner,
      appId: "app-one",
      name: "Taken over",
      pageId: "aaaaaaaaaaaaaaaa",
      requestId: "takeover",
    })
    expect(database.query<{ status: string; error: string }>(
      "SELECT status, error FROM tasks WHERE id = 'reject-other-publisher:completion'",
    ).get()).toEqual({ status: "rejected", error: "Only the publisher can update this app" })

    await appsTurn("install-update", "install", { owner, appId: "app-one", requestId: "install-two" })
    expect(JSON.parse(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = ? AND visibility = 'private' AND key = ?",
    ).get(deployment.appsBoxId, `installed|${owner}`)!.value)).toEqual([{ appId: "app-one", version: 2 }])
  } finally {
    database.close()
  }
})

test("native turns commit or roll back all storage writes", () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    const success = executeTurn(database, methodTurn(
      "success",
      "ctx.storage.public.set('count', 1); return ctx.storage.public.get('count');",
    ))
    expect(success).toEqual({ ok: true, value: 1 })

    const failure = executeTurn(database, methodTurn(
      "failure",
      "ctx.storage.public.set('count', 2); throw 'abort';",
    ))
    expect(failure.ok).toBe(false)
    expect(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = 'box-a' AND visibility = 'public' AND key = 'count'",
    ).get()?.value).toBe("1")
  } finally {
    database.close()
  }
})

test("box notifications are emitted only after a successful atomic turn", () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    const receiver = "b".repeat(64)
    const success = executeTurn(database, methodTurn(
      "shared-operations",
      `
        ctx.transfer("${receiver}", 25);
        ctx.message("client-b", { hello: true });
        return null;
      `,
    ))
    expect(success.ok).toBe(true)
    if (!success.ok) throw new Error(success.error)
    expect(success.notifications?.length).toBe(1)
    expect(success.notifications?.[0]?.message).toEqual({ hello: true })
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(receiver)?.fuel).toBe(25)

    const failure = executeTurn(database, methodTurn(
      "rolled-back-operations",
      `
        ctx.transfer("${receiver}", 10);
        ctx.message("client-b", "discard");
        throw "abort";
      `,
    ))
    expect(failure.ok).toBe(false)
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(receiver)?.fuel).toBe(25)
  } finally {
    database.close()
  }
})

test("unavailable clients never abort a committed message turn", async () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    const scheduler = new BoxScheduler()
    scheduler.addWorker({
      id: "message-worker",
      async execute(turn: WorkerTurn) { return executeTurn(database, turn) },
    })
    scheduler.setNotificationHandler(() => false)
    const result = await scheduler.run(methodTurn(
      "offline-message",
      `
        ctx.storage.public.set("committed", true);
        let messageId = ctx.message("offline-client", { hello: true });
        return { messageId: messageId };
      `,
    ))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    const value = result.value as { messageId: string }
    expect(typeof value.messageId).toBe("string")
    expect(result.deliveries).toEqual([{
      id: value.messageId,
      clientId: "offline-client",
      delivered: false,
    }])
    expect(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = 'box-a' AND visibility = 'public' AND key = 'committed'",
    ).get()?.value).toBe("true")
  } finally {
    database.close()
  }
})

test("Tasks compose durable effects, continuations, adoption, and rejection", async () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    database.query("INSERT INTO boxes (id, definition, created_at) VALUES (?, ?, ?)").run("box-b", "{}", Date.now())
    database.query("INSERT INTO box_methods (box_id, name, source) VALUES (?, ?, ?)").run(
      "box-b", "work", "return { answer: input.value + 1 };",
    )
    database.query("INSERT INTO box_methods (box_id, name, source) VALUES (?, ?, ?)").run(
      "box-b", "fail", "throw 'nope';",
    )
    const started = executeTurn(database, methodTurn("task-origin", `
      return ctx.invoke("box-b", "work", { value: 41 }).then(
        function completed(result, saved) {
          ctx.storage.private.set(saved.key, result.answer);
          return result.answer;
        },
        { key: "answer" }
      );
    `))
    expect(started.ok).toBe(true)
    expect(database.query<{ count: number }>("SELECT count(*) AS count FROM tasks").get()?.count).toBe(3)

    const scheduler = new BoxScheduler()
    scheduler.addWorker({ id: "task-worker", async execute(turn) { return executeTurn(database, turn) } })
    const dispatcher = new EffectDispatcher(database, scheduler)
    await drain(dispatcher)

    expect(database.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = 'box-a' AND visibility = 'private' AND key = 'answer'",
    ).get()?.value).toBe("42")
    expect(database.query<{ status: string; result: string }>(
      "SELECT status, result FROM tasks WHERE id = 'task-origin:completion'",
    ).get()).toEqual({ status: "fulfilled", result: "42" })

    expect(executeTurn(database, methodTurn("caught-invoke", `
      return ctx.invoke("box-b", "fail", null)
        .then(function unexpected() { return "wrong"; })
        .catch(function recovered(error) { return "caught: " + error; });
    `)).ok).toBe(true)
    await drain(dispatcher)
    expect(database.query<{ result: string }>(
      "SELECT result FROM tasks WHERE id = 'caught-invoke:completion'",
    ).get()?.result).toBe('"caught: nope"')

    const recovered = executeTurn(database, methodTurn("caught-request", `
      return ctx.request({ host: "localhost", path: "/", method: "GET" })
        .catch(function failed(error) { return { recovered: error }; });
    `))
    expect(recovered.ok).toBe(false)
    expect(database.query("SELECT id FROM effects WHERE origin_turn_id = 'caught-request'").get()).toBe(null)

    const closure = executeTurn(database, methodTurn("closure-turn", `
      let captured = "not durable";
      return ctx.invoke("box-b", "work", null).then(function completed(result) {
        return captured + result;
      });
    `))
    expect(closure.ok).toBe(false)
  } finally {
    database.close()
  }
})

test("ctx.request and ctx.publish settle Tasks with effect results", async () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    const scheduler = new BoxScheduler()
    scheduler.addWorker({ id: "effect-worker", async execute(turn) { return executeTurn(database, turn) } })
    const dispatcher = new EffectDispatcher(database, scheduler, async (_request, requestId) => ({
      ok: true, requestId, status: 200, contentType: "application/json", body: { answer: 42 },
    }))

    expect(executeTurn(database, methodTurn("request-turn", `
      return ctx.request({ host: "api.example.com", path: "/answer", method: "GET" }).then(
        function completed(response) { return response.body.answer; }
      );
    `)).ok).toBe(true)
    expect(executeTurn(database, methodTurn("publish-turn", `
      return ctx.publish("blob", { text: "hello" }).then(
        function published(result) { return result.id; }
      );
    `)).ok).toBe(true)
    await drain(dispatcher)

    expect(database.query<{ result: string }>(
      "SELECT result FROM tasks WHERE id = 'request-turn:completion'",
    ).get()?.result).toBe("42")
    expect(database.query<{ status: string }>(
      "SELECT status FROM tasks WHERE id = 'publish-turn:completion'",
    ).get()?.status).toBe("fulfilled")
    expect(database.query<{ count: number }>("SELECT count(*) AS count FROM blobs").get()?.count).toBe(1)
  } finally {
    database.close()
  }
})

test("the service publishes boxes and verifies signed invocations", async () => {
  const database = openDatabase(":memory:")
  try {
    const keys = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair
    const account = bytesToHex(await crypto.subtle.exportKey("raw", keys.publicKey))

    const scheduler = new BoxScheduler()
    scheduler.addWorker({
      id: "service-worker",
      async execute(turn: WorkerTurn): Promise<WorkerTurnResult> {
        return executeTurn(database, turn)
      },
    })
    const service = new BoxOSService(database, scheduler)
    const publication: BoxPublicationRequest = {
      nonce: crypto.randomUUID(),
      definition: { methods: { read: "return input.value + 1;" } },
    }
    const publicationSignature = bytesToHex(await crypto.subtle.sign(
      { name: "Ed25519" },
      keys.privateKey,
      new TextEncoder().encode(boxPublicationSigningMessage(publication)),
    ))
    const boxId = await service.publishBoxForAccount(account, publicationSignature, publication)
    const request: InvocationRequest = {
      nonce: crypto.randomUUID(),
      boxId,
      method: "read",
      input: { value: 41 },
      clientId: account,
    }
    const signature = bytesToHex(await crypto.subtle.sign(
      { name: "Ed25519" },
      keys.privateKey,
      new TextEncoder().encode(invocationSigningMessage(request)),
    ))

    expect(await service.invoke(account, signature, request)).toEqual({ ok: true, value: 42 })
    expect(await service.invoke(account, signature, request)).toEqual({ ok: true, value: 42 })
    expect(database.query<{ count: number }>("SELECT count(*) AS count FROM turns").get()?.count).toBe(1)
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(account)?.fuel).toBe(10_000)

    const receiverKeys = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair
    const receiver = bytesToHex(await crypto.subtle.exportKey("raw", receiverKeys.publicKey))
    const operation: ClientOperationRequest = {
      nonce: crypto.randomUUID(),
      operation: { type: "transfer", receiver, amount: 100 },
    }
    const operationSignature = bytesToHex(await crypto.subtle.sign(
      { name: "Ed25519" },
      keys.privateKey,
      new TextEncoder().encode(clientOperationSigningMessage(operation)),
    ))
    await service.operate(account, operationSignature, operation)
    await service.operate(account, operationSignature, operation)
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(account)?.fuel).toBe(9_900)
    expect(database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(receiver)?.fuel).toBe(100)

    service.setNotificationHandler(() => false)
    const messageOperation: ClientOperationRequest = {
      nonce: crypto.randomUUID(),
      operation: { type: "message", clientId: receiver, message: { hello: true } },
    }
    const messageSignature = bytesToHex(await crypto.subtle.sign(
      { name: "Ed25519" },
      keys.privateKey,
      new TextEncoder().encode(clientOperationSigningMessage(messageOperation)),
    ))
    const messageResult = await service.operate(account, messageSignature, messageOperation)
    expect(typeof (messageResult as { id: string }).id).toBe("string")
    expect(messageResult).toEqual({
      id: (messageResult as { id: string }).id,
      delivered: false,
    })
    expect(await service.operate(account, messageSignature, messageOperation)).toEqual(messageResult)
  } finally {
    database.close()
  }
})

test("a native worker executes validated methods against SQLite", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/boxos-worker-${crypto.randomUUID()}.sqlite`
  const database = openDatabase(path)
  installBox(database)
  database.close()

  const worker = new NativeBoxWorker({
    id: "native-1",
    databasePath: path,
    maximumTurnMilliseconds: 1_000,
  })
  try {
    const result = await worker.execute(methodTurn(
      "native-turn",
      "ctx.storage.private.set('answer', 42); return 42;",
    ))
    expect(result).toEqual({ ok: true, value: 42 })
  } finally {
    worker.stop()
  }

  const verification = openDatabase(path)
  try {
    expect(verification.query<{ value: string }>(
      "SELECT value FROM box_state WHERE box_id = 'box-a' AND visibility = 'private' AND key = 'answer'",
    ).get()?.value).toBe("42")
  } finally {
    verification.close()
    await rm(path, { force: true })
    await rm(`${path}-shm`, { force: true })
    await rm(`${path}-wal`, { force: true })
  }
})

test("a scheduler keeps one sticky owner and serializes a box", async () => {
  let active = 0
  let maximumActive = 0
  const calls: string[] = []
  const worker: BoxWorker = {
    id: "worker-1",
    async execute(turn: WorkerTurn): Promise<WorkerTurnResult> {
      active++
      maximumActive = Math.max(maximumActive, active)
      calls.push(turn.id)
      await Bun.sleep(1)
      active--
      return { ok: true, value: null }
    },
  }

  const scheduler = new BoxScheduler()
  scheduler.addWorker(worker)
  const turn = (id: string): WorkerTurn => ({
    id,
    boxId: "box-a",
    account: "account-a",
    clientId: null,
    procedure: { kind: "method", source: "return null;", input: null },
  })
  await Promise.all([scheduler.run(turn("one")), scheduler.run(turn("two"))])

  expect(maximumActive).toBe(1)
  expect(calls).toEqual(["one", "two"])
  expect(scheduler.ownerOf("box-a")).toBe("worker-1")
})

declare const ctx: {
  storage: { private: { set(key: string, value: unknown): void } }
}
