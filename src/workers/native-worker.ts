import type { BoxWorker, WorkerTurn, WorkerTurnResult } from "./scheduler.ts"

type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; requestId: number; result: WorkerTurnResult }
  | { type: "fatal"; error: string }

type Pending = {
  resolve(result: WorkerTurnResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** BoxWorker backed by a native Bun Web Worker. */
export class NativeBoxWorker implements BoxWorker {
  readonly id: string
  private readonly worker: Worker
  private readonly ready: Promise<void>
  private readonly pending = new Map<number, Pending>()
  private tail = Promise.resolve<void>(undefined)
  private nextRequestId = 1
  private stopped = false
  private rejectReady: ((error: Error) => void) | undefined

  constructor(options: {
    id: string
    databasePath: string
    maximumTurnMilliseconds: number
    onFailure?: (worker: NativeBoxWorker, error: Error) => void
  }) {
    this.id = options.id
    this.maximumTurnMilliseconds = options.maximumTurnMilliseconds
    this.onFailure = options.onFailure
    this.worker = new Worker(new URL("./worker-entry.ts", import.meta.url), { type: "module" })

    let markReady!: () => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      rejectReady = reject
      this.rejectReady = reject
    })

    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data
      if (message.type == "ready") {
        this.rejectReady = undefined
        markReady()
      } else if (message.type == "fatal") {
        const error = new Error(`Worker ${this.id} failed: ${message.error}`)
        rejectReady(error)
        this.fail(error)
      } else {
        const pending = this.pending.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.requestId)
        pending.resolve(message.result)
      }
    }
    this.worker.onerror = event => {
      const error = new Error(`Worker ${this.id} failed: ${event.message}`)
      rejectReady(error)
      this.fail(error)
    }
    this.worker.postMessage({ type: "initialize", databasePath: options.databasePath })
  }

  private readonly maximumTurnMilliseconds: number
  private readonly onFailure: ((worker: NativeBoxWorker, error: Error) => void) | undefined

  execute(turn: WorkerTurn): Promise<WorkerTurnResult> {
    const result = this.tail.then(async () => {
      await this.ready
      if (this.stopped) throw new Error(`Worker ${this.id} is stopped`)
      return this.dispatch(turn)
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  stop(): void {
    this.fail(new Error(`Worker ${this.id} was stopped`))
  }

  private dispatch(turn: WorkerTurn): Promise<WorkerTurnResult> {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Turn ${turn.id} exceeded ${this.maximumTurnMilliseconds}ms`)
        this.pending.delete(requestId)
        reject(error)
        this.fail(error)
      }, this.maximumTurnMilliseconds)
      this.pending.set(requestId, { resolve, reject, timer })
      this.worker.postMessage({ type: "execute", requestId, turn })
    })
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectReady?.(error)
    this.rejectReady = undefined
    this.worker.terminate()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.onFailure?.(this, error)
  }
}
