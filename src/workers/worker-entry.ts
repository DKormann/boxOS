import type { Database } from "bun:sqlite"
import { openDatabase } from "../storage/database.ts"
import { executeTurn } from "../execution/turn.ts"
import type { WorkerTurn, WorkerTurnResult } from "./scheduler.ts"

type HostMessage =
  | { type: "initialize"; databasePath: string }
  | { type: "execute"; requestId: number; turn: WorkerTurn }

type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; requestId: number; result: WorkerTurnResult }
  | { type: "fatal"; error: string }

const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HostMessage>) => void) | null
  postMessage(message: WorkerMessage): void
}

let database: Database | undefined

port.onmessage = event => {
  const message = event.data
  try {
    if (message.type == "initialize") {
      if (database) throw new Error("Worker is already initialized")
      database = openDatabase(message.databasePath)
      port.postMessage({ type: "ready" })
      return
    }

    if (!database) throw new Error("Worker has not been initialized")
    port.postMessage({
      type: "result",
      requestId: message.requestId,
      result: executeTurn(database, message.turn),
    })
  } catch (error) {
    port.postMessage({
      type: "fatal",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
