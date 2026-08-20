import type { Database } from "bun:sqlite"
import { copyBoxValue, parseBoxValue, stringifyBoxValue, validateBoxKey, type BoxValue } from "../core/values.ts"
import { parseStructuredRequest } from "../effects/request.ts"
import { validateCallbackCode } from "../language/parser.ts"
import { transferFuel } from "../operations/operations.ts"
import {
  compileCallback,
  compileMethod,
  createRuntimeTask,
  runtimeTaskId,
  type RuntimeContext,
  type RuntimeStorage,
  type TaskRegistrar,
} from "./native.ts"
import { BOXOS_RUNTIME_VERSION } from "../version.ts"
import type { ClientNotification, WorkerTurn, WorkerTurnResult } from "../workers/scheduler.ts"

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

function insertTask(database: Database, id: string, turn: WorkerTurn): void {
  database.query(
    `INSERT INTO tasks (id, origin_box_id, account, client_id, root_task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, turn.boxId, turn.account, turn.clientId, turn.rootTaskId ?? id, Date.now())
}

function rejectTask(database: Database, id: string, error: string): void {
  database.query(
    `UPDATE tasks SET status = 'rejected', error = ?, settled_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(error, Date.now(), id)
}

function completeTask(database: Database, id: string, value: unknown): void {
  const adopted = runtimeTaskId(value)
  if (adopted != null) {
    if (adopted == id) throw new TypeError("Task adoption cycle")
    let cursor: string | null = adopted
    while (cursor != null) {
      if (cursor == id) throw new TypeError("Task adoption cycle")
      cursor = database.query<{ adopted_task_id: string | null }>(
        "SELECT adopted_task_id FROM tasks WHERE id = ?",
      ).get(cursor)?.adopted_task_id ?? null
    }
    database.query(
      "UPDATE tasks SET adopted_task_id = ? WHERE id = ? AND status = 'pending'",
    ).run(adopted, id)
    return
  }
  if (value === undefined) throw new TypeError("A turn must return a BoxOS value or Task")
  database.query(
    `UPDATE tasks SET status = 'fulfilled', result = ?, settled_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(stringifyBoxValue(value), Date.now(), id)
}

function context(database: Database, turn: WorkerTurn, notifications: ClientNotification[]): RuntimeContext {
  const register: TaskRegistrar = (sourceTaskId, role, callback, callbackContext) => {
    if (typeof callback != "function") throw new TypeError("Task callback must be a function")
    const source = functionToString.call(callback)
    validateCallbackCode(source)
    const contextValue = copyBoxValue(callbackContext)
    const resultTaskId = crypto.randomUUID()
    insertTask(database, resultTaskId, turn)
    database.query(
      `INSERT INTO task_continuations
        (result_task_id, source_task_id, role, source, context, runtime_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      resultTaskId,
      sourceTaskId,
      role,
      source,
      stringifyBoxValue(contextValue),
      BOXOS_RUNTIME_VERSION,
      Date.now(),
    )
    return createRuntimeTask(resultTaskId, register)
  }

  function declareEffect(kind: string, argumentsValue: unknown) {
    const id = crypto.randomUUID()
    insertTask(database, id, turn)
    database.query(
      `INSERT INTO effects (id, origin_turn_id, kind, arguments, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(id, turn.id, kind, stringifyBoxValue(argumentsValue), Date.now())
    return createRuntimeTask(id, register)
  }

  return Object.freeze({
    account: turn.account,
    clientId: turn.clientId,
    invoke(targetBoxId: string, method: string, argument: unknown) {
      checkedName(targetBoxId, "Target box ID")
      checkedName(method, "Method name")
      return declareEffect("invoke", {
        boxId: targetBoxId,
        method,
        argument: copyBoxValue(argument),
      })
    },
    message(clientId: string, message: unknown): string {
      if (typeof clientId != "string" || clientId.length == 0 || clientId.length > 256) {
        throw new TypeError("Invalid client ID")
      }
      const id = crypto.randomUUID()
      notifications.push({ id, sender: turn.account, clientId, message: copyBoxValue(message) })
      return id
    },
    publish(kind: "account" | "blob" | "box" | "page", argumentsValue: unknown) {
      if (!["account", "blob", "box", "page"].includes(kind)) {
        throw new TypeError("Invalid publication kind")
      }
      return declareEffect(`publish.${kind}`, copyBoxValue(argumentsValue))
    },
    request(requestValue: unknown) {
      return declareEffect("request", parseStructuredRequest(copyBoxValue(requestValue)))
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

/** Execute one method or continuation as one atomic SQLite turn. */
export function executeTurn(database: Database, turn: WorkerTurn): WorkerTurnResult {
  const completionTaskId = turn.completionTaskId ?? `${turn.id}:completion`
  const activeTurn: WorkerTurn = {
    ...turn,
    completionTaskId,
    rootTaskId: turn.rootTaskId ?? completionTaskId,
  }
  const existing = database.query<{ status: string; result: string | null; error: string | null }>(
    "SELECT status, result, error FROM turns WHERE id = ?",
  ).get(turn.id)
  if (existing?.status == "succeeded") {
    return { ok: true, ...(existing.result == null ? {} : { value: parseBoxValue(existing.result) }) }
  }
  if (existing?.status == "failed") return { ok: false, error: existing.error ?? "Turn failed" }

  if (!existing) {
    database.transaction(() => {
      const task = database.query("SELECT id FROM tasks WHERE id = ?").get(completionTaskId)
      if (!task) insertTask(database, completionTaskId, activeTurn)
      database.query(
        `INSERT INTO turns
          (id, box_id, account, client_id, kind, completion_task_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(turn.id, turn.boxId, turn.account, turn.clientId, turn.procedure.kind, completionTaskId, Date.now())
    })()
  }
  database.query("UPDATE turns SET status = 'running' WHERE id = ?").run(turn.id)

  try {
    const notifications: ClientNotification[] = []
    const run = database.transaction((): BoxValue | undefined => {
      const ctx = context(database, activeTurn, notifications)
      const procedure = activeTurn.procedure
      const value = procedure.kind == "method"
        ? compileMethod(procedure.source)(ctx, copyBoxValue(procedure.input))
        : compileCallback(procedure.source, ctx)(
          copyBoxValue(procedure.value),
          copyBoxValue(procedure.context),
        )
      completeTask(database, completionTaskId, value)
      const pure = runtimeTaskId(value) == null ? copyBoxValue(value) : undefined
      database.query(
        "UPDATE turns SET status = 'succeeded', result = ?, finished_at = ? WHERE id = ?",
      ).run(pure === undefined ? null : stringifyBoxValue(pure), Date.now(), turn.id)
      return pure
    })
    const value = run()
    return {
      ok: true,
      ...(value === undefined ? {} : { value }),
      ...(notifications.length ? { notifications } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    database.transaction(() => {
      database.query(
        "UPDATE turns SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      ).run(message, Date.now(), turn.id)
      rejectTask(database, completionTaskId, message)
    })()
    return { ok: false, error: message }
  }
}
