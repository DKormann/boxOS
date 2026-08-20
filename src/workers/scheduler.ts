import type { BoxValue } from "../core/values.ts"

export type WorkerTurn = {
  id: string
  boxId: string
  account: string
  clientId: string | null
  completionTaskId?: string
  rootTaskId?: string
  procedure:
    | { kind: "method"; source: string; input: BoxValue }
    | { kind: "continuation"; source: string; value: BoxValue; context: BoxValue }
}

export type ClientNotification = {
  id: string
  sender: string
  clientId: string
  message: BoxValue
}

export type ClientDelivery = {
  id: string
  clientId: string
  delivered: boolean
}

export type WorkerTurnResult =
  | {
    ok: true
    value?: BoxValue
    notifications?: ClientNotification[]
    deliveries?: ClientDelivery[]
  }
  | { ok: false; error: string }

export interface BoxWorker {
  readonly id: string
  execute(turn: WorkerTurn): Promise<WorkerTurnResult>
}

/**
 * Maintains sticky, process-local box ownership and serializes turns per box.
 * Removing a failed worker releases all of its boxes before later turns run.
 */
export class BoxScheduler {
  private readonly workers = new Map<string, BoxWorker>()
  private readonly owners = new Map<string, string>()
  private readonly tails = new Map<string, Promise<void>>()
  private notificationHandler: (notification: ClientNotification) => boolean = () => false

  setNotificationHandler(handler: (notification: ClientNotification) => boolean): void {
    this.notificationHandler = handler
  }

  addWorker(worker: BoxWorker): void {
    if (this.workers.has(worker.id)) throw new Error(`Worker ${worker.id} already exists`)
    this.workers.set(worker.id, worker)
  }

  removeWorker(workerId: string): void {
    this.workers.delete(workerId)
    for (const [boxId, ownerId] of this.owners) {
      if (ownerId == workerId) this.owners.delete(boxId)
    }
  }

  ownerOf(boxId: string): string | undefined {
    return this.owners.get(boxId)
  }

  run(turn: WorkerTurn): Promise<WorkerTurnResult> {
    const previous = this.tails.get(turn.boxId) ?? Promise.resolve()
    const result = previous.then(() => this.execute(turn))
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(turn.boxId, tail)
    void tail.finally(() => {
      if (this.tails.get(turn.boxId) == tail) this.tails.delete(turn.boxId)
    })
    return result
  }

  private async execute(turn: WorkerTurn): Promise<WorkerTurnResult> {
    let ownerId = this.owners.get(turn.boxId)
    let worker = ownerId == null ? undefined : this.workers.get(ownerId)

    if (!worker) {
      worker = this.leastLoadedWorker()
      if (!worker) throw new Error("No box workers are available")
      ownerId = worker.id
      this.owners.set(turn.boxId, ownerId)
    }

    const result = await worker.execute(turn)
    if (!result.ok) return result
    const deliveries: ClientDelivery[] = []
    for (const notification of result.notifications ?? []) {
      let delivered = false
      try {
        delivered = this.notificationHandler(notification)
      } catch {
        // Notifications are best-effort and cannot change a committed turn.
      }
      deliveries.push({ id: notification.id, clientId: notification.clientId, delivered })
    }
    return {
      ok: true,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(deliveries.length ? { deliveries } : {}),
    }
  }

  private leastLoadedWorker(): BoxWorker | undefined {
    const loads = new Map<string, number>()
    for (const workerId of this.owners.values()) loads.set(workerId, (loads.get(workerId) ?? 0) + 1)

    let selected: BoxWorker | undefined
    for (const worker of this.workers.values()) {
      if (!selected || (loads.get(worker.id) ?? 0) < (loads.get(selected.id) ?? 0)) selected = worker
    }
    return selected
  }
}
