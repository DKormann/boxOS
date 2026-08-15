import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { stringifyBoxValue } from "../src/core/values.ts"
import { executeTurn } from "../src/execution/turn.ts"
import {
  isValidCallbackCode,
  isValidMethodCode,
  validateCallbackCode,
} from "../src/language/parser.ts"
import { openDatabase } from "../src/storage/database.ts"
import { NativeBoxWorker } from "../src/workers/native-worker.ts"
import {
  BoxScheduler,
  type BoxWorker,
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

function methodTurn(id: string, source: string): WorkerTurn {
  return {
    id,
    boxId: "box-a",
    account: "account-a",
    clientId: null,
    procedure: { kind: "method", source, input: null },
  }
}

test("canonical BOXOS values are independent of object insertion order", () => {
  expect(stringifyBoxValue({ z: 1, a: { y: true, x: null } })).toBe(
    stringifyBoxValue({ a: { x: null, y: true }, z: 1 }),
  )
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

test("database initialization installs the first schema", () => {
  const database = openDatabase(":memory:")
  try {
    const tables = database.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map(row => row.name)
    expect(tables).toEqual([
      "accounts",
      "blobs",
      "box_methods",
      "box_state",
      "boxes",
      "effect_callbacks",
      "effects",
      "pages",
      "schema_meta",
      "turns",
    ])
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

test("invoke persists validated callbacks atomically with the turn", () => {
  const database = openDatabase(":memory:")
  try {
    installBox(database)
    const result = executeTurn(database, methodTurn(
      "invoke-turn",
      `
        ctx.storage.public.set("started", true);
        ctx.invoke(
          "box-b",
          "work",
          { value: 1 },
          function completed(result, context) {
            ctx.storage.private.set(context.key, result);
          },
          { key: "result" }
        );
        return null;
      `,
    ))
    expect(result).toEqual({ ok: true, value: null })
    expect(database.query<{ status: string }>("SELECT status FROM effects").get()?.status).toBe("pending")
    expect(database.query<{ context: string }>("SELECT context FROM effect_callbacks").get()?.context).toBe(
      '{"key":"result"}',
    )

    const rejected = executeTurn(database, methodTurn(
      "closure-turn",
      `
        let captured = "not durable";
        ctx.storage.public.set("rolled-back", true);
        ctx.invoke("box-b", "work", null, function completed(result) {
          return captured + result;
        });
        return null;
      `,
    ))
    expect(rejected.ok).toBe(false)
    expect(database.query("SELECT value FROM box_state WHERE key = 'rolled-back'").get()).toBe(null)
    expect(database.query<{ count: number }>("SELECT count(*) AS count FROM effects").get()?.count).toBe(1)
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
