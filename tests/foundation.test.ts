import { expect, test } from "bun:test"
import { stringifyBoxValue } from "../src/core/values.ts"
import {
  isValidCallbackCode,
  isValidMethodCode,
  validateCallbackCode,
} from "../src/language/parser.ts"
import { openDatabase } from "../src/storage/database.ts"
import {
  BoxScheduler,
  type BoxWorker,
  type WorkerTurn,
  type WorkerTurnResult,
} from "../src/workers/scheduler.ts"

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
  const turn = (id: string): WorkerTurn => ({ id, boxId: "box-a", source: "return null;", input: null })
  await Promise.all([scheduler.run(turn("one")), scheduler.run(turn("two"))])

  expect(maximumActive).toBe(1)
  expect(calls).toEqual(["one", "two"])
  expect(scheduler.ownerOf("box-a")).toBe("worker-1")
})

declare const ctx: {
  storage: { private: { set(key: string, value: unknown): void } }
}
