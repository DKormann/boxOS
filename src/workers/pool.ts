import { NativeBoxWorker } from "./native-worker.ts"
import { BoxScheduler } from "./scheduler.ts"

/** Owns native workers and replaces failed workers after releasing box ownership. */
export class WorkerPool {
  readonly scheduler = new BoxScheduler()
  private readonly workers = new Map<string, NativeBoxWorker>()
  private nextWorkerId = 1
  private stopped = false

  constructor(private readonly options: {
    databasePath: string
    size: number
    maximumTurnMilliseconds: number
  }) {
    if (!Number.isSafeInteger(options.size) || options.size < 1) {
      throw new TypeError("Worker pool size must be a positive integer")
    }
    for (let index = 0; index < options.size; index++) this.spawn()
  }

  stop(): void {
    this.stopped = true
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
  }

  private spawn(): void {
    const id = `worker-${this.nextWorkerId++}`
    const worker = new NativeBoxWorker({
      id,
      databasePath: this.options.databasePath,
      maximumTurnMilliseconds: this.options.maximumTurnMilliseconds,
      onFailure: (failed, _error) => {
        this.scheduler.removeWorker(failed.id)
        this.workers.delete(failed.id)
        if (!this.stopped) this.spawn()
      },
    })
    this.workers.set(id, worker)
    this.scheduler.addWorker(worker)
  }
}
