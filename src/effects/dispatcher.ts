import type { Database } from "bun:sqlite"
import { parseBoxValue, stringifyBoxValue, type BoxValue } from "../core/values.ts"
import {
  instantiateBox,
  publishAccount,
  publishBox,
  publishPage,
  publishTextBlob,
} from "../operations/operations.ts"
import { BOXOS_RUNTIME_VERSION } from "../version.ts"
import { executeStructuredRequest } from "./request.ts"
import type { BoxScheduler, ClientDelivery, WorkerTurnResult } from "../workers/scheduler.ts"

type EffectRow = {
  id: string
  origin_box_id: string
  kind: string
  arguments: string
  account: string
  client_id: string | null
  root_task_id: string
}

type TaskRow = {
  id: string
  status: "pending" | "fulfilled" | "rejected"
  result: string | null
  error: string | null
}

type ContinuationRow = {
  result_task_id: string
  source_task_id: string
  origin_box_id: string
  role: "success" | "failure"
  source: string
  context: string
  runtime_version: string
  account: string
  client_id: string | null
  source_status: "fulfilled" | "rejected"
  source_result: string | null
  source_error: string | null
  root_task_id: string
}

export type RequestExecutor = (value: BoxValue, requestId: string) => Promise<BoxValue>

function invocationArguments(encoded: string): { boxId: string; method: string; argument: BoxValue } {
  const value = parseBoxValue(encoded)
  if (value === null || Array.isArray(value) || typeof value != "object") {
    throw new TypeError("Invalid persisted invocation arguments")
  }
  const boxId = value["boxId"]
  const method = value["method"]
  if (typeof boxId != "string" || typeof method != "string" || !("argument" in value)) {
    throw new TypeError("Invalid persisted invocation arguments")
  }
  return { boxId, method, argument: value["argument"]! }
}

/** Advances the durable effect and Task graph one idempotent step at a time. */
export class EffectDispatcher {
  private readonly deliveries = new Map<string, ClientDelivery[]>()
  private readonly trackedRoots = new Set<string>()

  constructor(
    private readonly database: Database,
    private readonly scheduler: BoxScheduler,
    private readonly requestExecutor: RequestExecutor = executeStructuredRequest,
  ) {}

  trackDeliveries(rootTaskId: string): void {
    this.trackedRoots.add(rootTaskId)
  }

  takeDeliveries(rootTaskId: string): ClientDelivery[] {
    const deliveries = this.deliveries.get(rootTaskId) ?? []
    this.deliveries.delete(rootTaskId)
    this.trackedRoots.delete(rootTaskId)
    return deliveries
  }

  async dispatchNext(): Promise<boolean> {
    const effect = this.database.query<{ id: string }>(
      `SELECT id FROM effects WHERE status IN ('pending', 'dispatched')
       ORDER BY created_at, id LIMIT 1`,
    ).get()
    if (effect) {
      await this.dispatchEffect(effect.id)
      return true
    }

    const adoption = this.database.query<{ id: string; adopted_task_id: string }>(
      `SELECT child.id, child.adopted_task_id
       FROM tasks child JOIN tasks parent ON parent.id = child.adopted_task_id
       WHERE child.status = 'pending' AND parent.status != 'pending'
       ORDER BY child.created_at, child.id LIMIT 1`,
    ).get()
    if (adoption) {
      const parent = this.readTask(adoption.adopted_task_id)!
      this.copySettlement(adoption.id, parent)
      return true
    }

    const continuation = this.readReadyContinuation()
    if (continuation) {
      await this.resume(continuation)
      return true
    }
    return false
  }

  private async dispatchEffect(effectId: string): Promise<void> {
    const effect = this.database.query<EffectRow>(
      `SELECT effects.id, turns.box_id AS origin_box_id, effects.kind,
              effects.arguments, turns.account, turns.client_id, tasks.root_task_id
       FROM effects JOIN turns ON turns.id = effects.origin_turn_id
       JOIN tasks ON tasks.id = effects.id
       WHERE effects.id = ?`,
    ).get(effectId)
    if (!effect) throw new Error(`Unknown effect ${effectId}`)
    const task = this.readTask(effect.id)!
    if (task.status != "pending") {
      this.finishEffect(effect.id)
      return
    }
    this.database.query(
      "UPDATE effects SET status = 'dispatched' WHERE id = ? AND status = 'pending'",
    ).run(effect.id)

    if (effect.kind == "invoke") {
      let args: ReturnType<typeof invocationArguments>
      try {
        args = invocationArguments(effect.arguments)
      } catch (error) {
        this.reject(effect.id, error instanceof Error ? error.message : String(error))
        this.finishEffect(effect.id)
        return
      }
      const method = this.database.query<{ source: string }>(
        "SELECT source FROM box_methods WHERE box_id = ? AND name = ?",
      ).get(args.boxId, args.method)
      if (!method) {
        this.reject(effect.id, `Unknown method ${args.boxId}.${args.method}`)
        this.finishEffect(effect.id)
        return
      }
      // Worker rejection is infrastructure failure: leave the dispatched
      // effect retryable. A box-level failure is persisted on its Task.
      const result = await this.scheduler.run({
        id: `${effect.id}:invoke`,
        boxId: args.boxId,
        account: effect.account,
        clientId: effect.client_id,
        completionTaskId: effect.id,
        rootTaskId: effect.root_task_id,
        procedure: { kind: "method", source: method.source, input: args.argument },
      })
      this.captureDeliveries(effect.root_task_id, result)
      this.finishEffect(effect.id)
      return
    }

    try {
      const args = parseBoxValue(effect.arguments)
      let value: BoxValue
      if (effect.kind == "request") {
        value = await this.requestExecutor(args, effect.id)
      } else if (effect.kind == "publish.box") {
        value = { id: await publishBox(this.database, args) }
      } else if (effect.kind == "instantiate.box") {
        value = { id: await instantiateBox(this.database, effect.account, args) }
      } else {
        if (args === null || Array.isArray(args) || typeof args != "object") {
          throw new TypeError("Publication arguments must be an object")
        }
        let id: string
        if (effect.kind == "publish.blob") {
          const text = args["text"]
          const contentType = args["contentType"]
          if (typeof text != "string" || (contentType !== undefined && typeof contentType != "string")) {
            throw new TypeError("Blob publication requires text")
          }
          id = await publishTextBlob(this.database, text, contentType)
        } else if (effect.kind == "publish.page") {
          const blobId = args["blobId"]
          if (typeof blobId != "string") throw new TypeError("Page publication requires a blob ID")
          id = await publishPage(this.database, blobId)
        } else if (effect.kind == "publish.account") {
          const pubkey = args["pubkey"]
          if (typeof pubkey != "string") throw new TypeError("Account publication requires a public key")
          id = publishAccount(this.database, pubkey)
        } else {
          throw new TypeError(`Unknown effect kind ${effect.kind}`)
        }
        value = { id }
      }
      this.fulfill(effect.id, value)
    } catch (error) {
      this.reject(effect.id, error instanceof Error ? error.message : String(error))
    }
    this.finishEffect(effect.id)
  }

  private readReadyContinuation(): ContinuationRow | null {
    return this.database.query<ContinuationRow>(
      `SELECT continuation.result_task_id, continuation.source_task_id,
              result.origin_box_id, continuation.role, continuation.source,
              continuation.context, continuation.runtime_version,
              result.account, result.client_id, result.root_task_id,
              source.status AS source_status, source.result AS source_result,
              source.error AS source_error
       FROM task_continuations continuation
       JOIN tasks source ON source.id = continuation.source_task_id
       JOIN tasks result ON result.id = continuation.result_task_id
       WHERE continuation.status IN ('waiting', 'queued') AND source.status != 'pending'
       ORDER BY continuation.created_at, continuation.result_task_id LIMIT 1`,
    ).get()
  }

  private async resume(row: ContinuationRow): Promise<void> {
    const selected = (row.source_status == "fulfilled" && row.role == "success")
      || (row.source_status == "rejected" && row.role == "failure")
    if (!selected) {
      this.copySettlement(row.result_task_id, {
        id: row.source_task_id,
        status: row.source_status,
        result: row.source_result,
        error: row.source_error,
      })
      this.completeContinuation(row.result_task_id, null)
      return
    }
    if (row.runtime_version != BOXOS_RUNTIME_VERSION) {
      this.reject(row.result_task_id, `Continuation requires runtime ${row.runtime_version}`)
      this.completeContinuation(row.result_task_id, null)
      return
    }

    this.database.query(
      "UPDATE task_continuations SET status = 'queued' WHERE result_task_id = ?",
    ).run(row.result_task_id)
    const turnId = `${row.result_task_id}:continuation`
    const result = await this.scheduler.run({
      id: turnId,
      boxId: row.origin_box_id,
      account: row.account,
      clientId: row.client_id,
      completionTaskId: row.result_task_id,
      rootTaskId: row.root_task_id,
      procedure: {
        kind: "continuation",
        source: row.source,
        value: row.source_status == "fulfilled"
          ? parseBoxValue(row.source_result!)
          : row.source_error ?? "Task rejected",
        context: parseBoxValue(row.context),
      },
    })
    this.captureDeliveries(row.root_task_id, result)
    this.completeContinuation(row.result_task_id, turnId)
  }

  private captureDeliveries(rootTaskId: string, result: WorkerTurnResult): void {
    if (!this.trackedRoots.has(rootTaskId) || !result.ok || !result.deliveries) return
    const deliveries = this.deliveries.get(rootTaskId) ?? []
    deliveries.push(...result.deliveries)
    this.deliveries.set(rootTaskId, deliveries)
  }

  private readTask(id: string): TaskRow | null {
    return this.database.query<TaskRow>(
      "SELECT id, status, result, error FROM tasks WHERE id = ?",
    ).get(id)
  }

  private fulfill(id: string, value: BoxValue): void {
    this.database.query(
      `UPDATE tasks SET status = 'fulfilled', result = ?, settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(stringifyBoxValue(value), Date.now(), id)
  }

  private reject(id: string, error: string): void {
    this.database.query(
      `UPDATE tasks SET status = 'rejected', error = ?, settled_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(error, Date.now(), id)
  }

  private copySettlement(id: string, source: TaskRow): void {
    if (source.status == "fulfilled") this.fulfill(id, parseBoxValue(source.result!))
    else this.reject(id, source.error ?? "Task rejected")
  }

  private finishEffect(id: string): void {
    this.database.query(
      "UPDATE effects SET status = 'completed', completed_at = ? WHERE id = ?",
    ).run(Date.now(), id)
  }

  private completeContinuation(resultTaskId: string, turnId: string | null): void {
    this.database.query(
      `UPDATE task_continuations SET status = 'completed', callback_turn_id = ?
       WHERE result_task_id = ?`,
    ).run(turnId, resultTaskId)
  }
}
