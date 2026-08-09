export class WorkerPoolBusyError extends Error {
  constructor() {
    super("Worker pool is busy");
    this.name = "WorkerPoolBusyError";
  }
}

export type WorkerLease<T> = {
  worker: T;
  release(): void;
  discard(): void;
};

type Waiter<T> = {
  resolve: (lease: WorkerLease<T>) => void;
  reject: (error: Error) => void;
};

export class WorkerPool<T extends { terminate(): void }> {
  private readonly idle: T[] = [];
  private readonly waiting: Waiter<T>[] = [];
  private total = 0;

  constructor(
    private readonly size: number,
    private readonly maximumQueue: number,
    private readonly create: () => T,
  ) {
    if (!Number.isInteger(size) || size < 1) throw new TypeError("Worker pool size must be a positive integer");
    if (!Number.isInteger(maximumQueue) || maximumQueue < 0) throw new TypeError("Worker queue limit must be a non-negative integer");
  }

  acquire(): Promise<WorkerLease<T>> {
    if (this.waiting.length >= this.maximumQueue && this.total >= this.size && this.idle.length === 0) {
      return Promise.reject(new WorkerPoolBusyError());
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.serve();
    });
  }

  private lease(worker: T): WorkerLease<T> {
    let active = true;
    return {
      worker,
      release: () => {
        if (!active) return;
        active = false;
        this.idle.push(worker);
        this.serve();
      },
      discard: () => {
        if (!active) return;
        active = false;
        worker.terminate();
        this.total--;
        this.serve();
      },
    };
  }

  private serve(): void {
    while (this.waiting.length > 0) {
      let worker = this.idle.pop();
      if (!worker) {
        if (this.total >= this.size) return;
        try {
          worker = this.create();
          this.total++;
        } catch (error) {
          this.waiting.shift()!.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
      }
      this.waiting.shift()!.resolve(this.lease(worker));
    }
  }
}
