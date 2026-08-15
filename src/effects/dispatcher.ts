import type { Database } from "bun:sqlite"
import { parseBoxValue, stringifyBoxValue, type BoxValue } from "../core/values.ts"
import { BOXOS_RUNTIME_VERSION } from "../version.ts"
import type { BoxScheduler, WorkerTurn, WorkerTurnResult } from "../workers/scheduler.ts"

type EffectRow = {
  id: string
  origin_box_id: string
  status: "pending" | "dispatched" | "succeeded" | "failed"
  arguments: string
  result: string | null
  account: string
  client_id: string | null
}

type CallbackRow = {
  source: string
  context: string
  runtime_version: string
  status: "waiting" | "queued" | "completed" | "discarded"
}

type InvocationArguments = {
  boxId: string
  method: string
  argument: BoxValue
}

function invocationArguments(encoded: string): InvocationArguments {
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

/** Delivers durable invoke effects and resumes their callbacks idempotently. */
export class EffectDispatcher {
  private readonly active = new Set<string>()

  constructor(
    private readonly database: Database,
    private readonly scheduler: BoxScheduler,
  ) {}

  /** Dispatch one available effect. Returns false when there is no work. */
  async dispatchNext(): Promise<boolean> {
    const row = this.database.query<{ id: string }>(
      `SELECT effects.id
       FROM effects
       LEFT JOIN effect_callbacks
         ON effect_callbacks.effect_id = effects.id
        AND effect_callbacks.role = 'success'
       WHERE effects.status IN ('pending', 'dispatched')
          OR (effects.status = 'succeeded' AND effect_callbacks.status = 'queued')
       ORDER BY effects.created_at, effects.id
       LIMIT 1`,
    ).get()
    if (!row || this.active.has(row.id)) return false
    await this.dispatch(row.id)
    return true
  }

  async dispatch(effectId: string): Promise<void> {
    if (this.active.has(effectId)) return
    this.active.add(effectId)
    try {
      let effect = this.readEffect(effectId)
      if (!effect) throw new Error(`Unknown effect ${effectId}`)

      if (effect.status == "pending" || effect.status == "dispatched") {
        if (effect.status == "pending") {
          this.database.query(
            "UPDATE effects SET status = 'dispatched' WHERE id = ? AND status = 'pending'",
          ).run(effectId)
        }

        let result: WorkerTurnResult
        try {
          const args = invocationArguments(effect.arguments)
          const method = this.database.query<{ source: string }>(
            "SELECT source FROM box_methods WHERE box_id = ? AND name = ?",
          ).get(args.boxId, args.method)
          if (!method) {
            result = { ok: false, error: `Unknown method ${args.boxId}.${args.method}` }
          } else {
            const turn: WorkerTurn = {
              id: `${effect.id}:invoke`,
              boxId: args.boxId,
              account: effect.account,
              clientId: effect.client_id,
              procedure: { kind: "method", source: method.source, input: args.argument },
            }
            result = await this.scheduler.run(turn)
          }
        } catch (error) {
          // Scheduler/worker failures are retryable. Persisted malformed work is not.
          if (error instanceof TypeError) {
            result = { ok: false, error: error.message }
          } else {
            throw error
          }
        }

        this.settle(effect.id, result)
        effect = this.readEffect(effectId)!
      }

      if (effect.status == "succeeded") await this.resumeSuccessCallback(effect)
    } finally {
      this.active.delete(effectId)
    }
  }

  private readEffect(effectId: string): EffectRow | null {
    return this.database.query<EffectRow>(
      `SELECT effects.id, effects.origin_box_id, effects.status, effects.arguments,
              effects.result, turns.account, turns.client_id
       FROM effects
       JOIN turns ON turns.id = effects.origin_turn_id
       WHERE effects.id = ?`,
    ).get(effectId)
  }

  private settle(effectId: string, result: WorkerTurnResult): void {
    this.database.transaction(() => {
      if (result.ok) {
        this.database.query(
          `UPDATE effects
           SET status = 'succeeded', result = ?, error = NULL, settled_at = ?
           WHERE id = ?`,
        ).run(stringifyBoxValue(result.value), Date.now(), effectId)
        this.database.query(
          `UPDATE effect_callbacks SET status = 'queued'
           WHERE effect_id = ? AND role = 'success' AND status = 'waiting'`,
        ).run(effectId)
      } else {
        this.database.query(
          `UPDATE effects
           SET status = 'failed', error = ?, result = NULL, settled_at = ?
           WHERE id = ?`,
        ).run(result.error, Date.now(), effectId)
        this.database.query(
          `UPDATE effect_callbacks SET status = 'discarded'
           WHERE effect_id = ? AND status = 'waiting'`,
        ).run(effectId)
      }
    })()
  }

  private async resumeSuccessCallback(effect: EffectRow): Promise<void> {
    const callback = this.database.query<CallbackRow>(
      `SELECT source, context, runtime_version, status FROM effect_callbacks
       WHERE effect_id = ? AND role = 'success'`,
    ).get(effect.id)
    if (!callback || callback.status == "completed" || callback.status == "discarded") return
    if (callback.runtime_version != BOXOS_RUNTIME_VERSION) {
      throw new Error(
        `Callback ${effect.id} requires runtime ${callback.runtime_version}; current runtime is ${BOXOS_RUNTIME_VERSION}`,
      )
    }
    if (effect.result == null) throw new Error(`Successful effect ${effect.id} has no result`)

    if (callback.status == "waiting") {
      this.database.query(
        `UPDATE effect_callbacks SET status = 'queued'
         WHERE effect_id = ? AND role = 'success'`,
      ).run(effect.id)
    }

    const callbackTurnId = `${effect.id}:success`
    await this.scheduler.run({
      id: callbackTurnId,
      boxId: effect.origin_box_id,
      account: effect.account,
      clientId: effect.client_id,
      procedure: {
        kind: "callback",
        source: callback.source,
        result: parseBoxValue(effect.result),
        context: parseBoxValue(callback.context),
      },
    })
    this.database.query(
      `UPDATE effect_callbacks
       SET status = 'completed', callback_turn_id = ?
       WHERE effect_id = ? AND role = 'success'`,
    ).run(callbackTurnId, effect.id)
  }
}
