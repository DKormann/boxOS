import type { AtomicSession } from "./atomic.ts";

/** Host-side ownership for one invocation's effects and atomic session. */
export class InvocationScope {
  private readonly controller = new AbortController();
  private readonly hostEffects = new Set<Promise<unknown>>();
  private pendingRpc: Promise<void> = Promise.resolve();
  private atomicSession: AtomicSession | null = null;
  private readonly abortFromParent: () => void;

  constructor(private readonly parentSignal?: AbortSignal) {
    this.abortFromParent = () => this.controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) this.abortFromParent();
    else parentSignal?.addEventListener("abort", this.abortFromParent, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get atomic(): AtomicSession | null {
    return this.atomicSession;
  }

  setAtomic(session: AtomicSession | null): void {
    this.atomicSession = session;
  }

  setPendingRpc(operation: Promise<void>): void {
    this.pendingRpc = operation;
  }

  trackEffect<T>(effect: Promise<T>): Promise<T> {
    this.hostEffects.add(effect);
    void effect.then(() => this.hostEffects.delete(effect), () => this.hostEffects.delete(effect));
    return effect;
  }

  cancel(reason: Error): void {
    this.controller.abort(reason);
  }

  async settle(): Promise<void> {
    await this.pendingRpc;
    this.atomicSession?.abort();
    this.atomicSession = null;
    while (this.hostEffects.size > 0) await Promise.allSettled([...this.hostEffects]);
    this.parentSignal?.removeEventListener("abort", this.abortFromParent);
  }
}
