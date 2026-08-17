import type { Database } from "bun:sqlite"
import { copyBoxValue, parseBoxValue, stringifyBoxValue, validateBoxKey, type BoxValue } from "../core/values.ts"
import { parseStructuredRequest } from "../effects/request.ts"
import { validateCallbackCode } from "../language/parser.ts"
import { transferFuel } from "../operations/operations.ts"
import { compileCallback, compileMethod, type RuntimeContext, type RuntimeStorage } from "./native.ts"
import { BOXOS_RUNTIME_VERSION } from "../version.ts"
import type {
  ClientNotification,
  WorkerTurn,
  WorkerTurnResult,
} from "../workers/scheduler.ts"

type Visibility = "public" | "private"
const functionToString = Function.prototype.toString

function checkedName(value: unknown, description: string): string {
  if (typeof value != "string" || value.length == 0 || value.length > 256) {
    throw new TypeError(`${description} must be a non-empty string of at most 256 characters`)
  }
  return value
}

function storage(database: Database, boxId: string, visibility: Visibility): RuntimeStorage {
  const read = database.query<{ value: string }>(
    "SELECT value FROM box_state WHERE box_id = ? AND visibility = ? AND key = ?",
  )
  const write = database.query(
    `INSERT INTO box_state (box_id, visibility, key, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (box_id, visibility, key) DO UPDATE SET value = excluded.value`,
  )
  const remove = database.query(
    "DELETE FROM box_state WHERE box_id = ? AND visibility = ? AND key = ?",
  )

  return Object.freeze({
    get(key: string): BoxValue | null {
      validateBoxKey(key, "Storage keys")
      const row = read.get(boxId, visibility, key)
      return row == null ? null : parseBoxValue(row.value)
    },
    set(key: string, value: unknown): void {
      validateBoxKey(key, "Storage keys")
      write.run(boxId, visibility, key, stringifyBoxValue(value))
    },
    delete(key: string): void {
      validateBoxKey(key, "Storage keys")
      remove.run(boxId, visibility, key)
    },
  })
}

function context(
  database: Database,
  turn: WorkerTurn,
  notifications: ClientNotification[],
): RuntimeContext {
  function declareEffect(
    kind: string,
    argumentsValue: unknown,
    callback: Function,
    callbackContext: unknown,
  ): void {
    if (typeof callback != "function") throw new TypeError("Effect callback must be a function")
    const callbackSource = functionToString.call(callback)
    validateCallbackCode(callbackSource)
    const effectId = crypto.randomUUID()
    database.query(
      `INSERT INTO effects
        (id, origin_turn_id, origin_box_id, kind, arguments, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      effectId,
      turn.id,
      turn.boxId,
      kind,
      stringifyBoxValue(argumentsValue),
      Date.now(),
    )
    database.query(
      `INSERT INTO effect_callbacks
        (effect_id, role, source, context, runtime_version)
       VALUES (?, 'success', ?, ?, ?)`,
    ).run(
      effectId,
      callbackSource,
      stringifyBoxValue(callbackContext),
      BOXOS_RUNTIME_VERSION,
    )
  }

  return Object.freeze({
    account: turn.account,
    clientId: turn.clientId,
    invoke(
      targetBoxId: string,
      method: string,
      argument: unknown,
      callback: Function,
      callbackContext: unknown = null,
    ): void {
      checkedName(targetBoxId, "Target box ID")
      checkedName(method, "Method name")
      declareEffect("invoke", {
        boxId: targetBoxId,
        method,
        argument: copyBoxValue(argument),
      }, callback, callbackContext)
    },
    message(clientId: string, message: unknown): void {
      if (typeof clientId != "string" || clientId.length == 0 || clientId.length > 256) {
        throw new TypeError("Invalid client ID")
      }
      notifications.push({
        id: crypto.randomUUID(),
        sender: turn.account,
        clientId,
        message: copyBoxValue(message),
      })
    },
    publish(
      kind: "account" | "blob" | "box" | "page",
      argumentsValue: unknown,
      callback: Function,
      callbackContext: unknown = null,
    ): void {
      if (!["account", "blob", "box", "page"].includes(kind)) {
        throw new TypeError("Invalid publication kind")
      }
      declareEffect(`publish.${kind}`, copyBoxValue(argumentsValue), callback, callbackContext)
    },
    request(
      requestValue: unknown,
      callback: Function,
      callbackContext: unknown = null,
    ): void {
      const request = parseStructuredRequest(copyBoxValue(requestValue))
      declareEffect("request", request, callback, callbackContext)
    },
    transfer(receiver: string, amount: number): void {
      transferFuel(database, turn.account, receiver, amount)
    },
    storage: Object.freeze({
      public: storage(database, turn.boxId, "public"),
      private: storage(database, turn.boxId, "private"),
    }),
  })
}

/** Execute one synchronous method or callback in one SQLite transaction. */
export function executeTurn(database: Database, turn: WorkerTurn): WorkerTurnResult {
  const existing = database.query<{ status: string; result: string | null; error: string | null }>(
    "SELECT status, result, error FROM turns WHERE id = ?",
  ).get(turn.id)
  if (existing?.status == "succeeded" && existing.result != null) {
    return { ok: true, value: parseBoxValue(existing.result) }
  }
  if (existing?.status == "failed") return { ok: false, error: existing.error ?? "Turn failed" }

  if (!existing) {
    database.query(
      `INSERT INTO turns
        (id, box_id, account, client_id, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      turn.id,
      turn.boxId,
      turn.account,
      turn.clientId,
      turn.procedure.kind,
      Date.now(),
    )
  }
  database.query("UPDATE turns SET status = 'running' WHERE id = ?").run(turn.id)

  try {
    const notifications: ClientNotification[] = []
    const run = database.transaction((): BoxValue => {
      const ctx = context(database, turn, notifications)
      const procedure = turn.procedure
      const value = procedure.kind == "method"
        ? compileMethod(procedure.source)(ctx, copyBoxValue(procedure.input))
        : compileCallback(procedure.source, ctx)(
          copyBoxValue(procedure.result),
          copyBoxValue(procedure.context),
        )
      const result = value === undefined ? null : copyBoxValue(value)
      database.query(
        "UPDATE turns SET status = 'succeeded', result = ?, finished_at = ? WHERE id = ?",
      ).run(stringifyBoxValue(result), Date.now(), turn.id)
      return result
    })
    const value = run()
    return notifications.length
      ? { ok: true, value, notifications }
      : { ok: true, value }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    database.query(
      "UPDATE turns SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    ).run(message, Date.now(), turn.id)
    return { ok: false, error: message }
  }
}
