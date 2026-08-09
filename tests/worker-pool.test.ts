import { expect, test } from "bun:test";
import { WorkerPool, WorkerPoolBusyError } from "../src/worker-pool.ts";

type FakeWorker = { id: number; terminated: boolean; terminate(): void };

function workers(size = 2, queue = 2) {
  const created: FakeWorker[] = [];
  const pool = new WorkerPool(size, queue, () => {
    const worker: FakeWorker = {
      id: created.length + 1,
      terminated: false,
      terminate() { this.terminated = true; },
    };
    created.push(worker);
    return worker;
  });
  return { pool, created };
}

test("workers are reused and concurrent work is bounded", async () => {
  const { pool, created } = workers(2);
  const first = await pool.acquire();
  const second = await pool.acquire();
  const waiting = pool.acquire();

  expect(created.length).toBe(2);
  first.release();
  const third = await waiting;
  expect(third.worker.id).toBe(first.worker.id);
  expect(created.length).toBe(2);

  second.release();
  third.release();
});

test("timed-out workers are discarded and replaced", async () => {
  const { pool, created } = workers(1);
  const first = await pool.acquire();
  first.discard();
  const second = await pool.acquire();

  expect(first.worker.terminated).toBe(true);
  expect(second.worker.id).toBe(2);
  second.release();
  expect(created.length).toBe(2);
});

test("excess queued work is rejected", async () => {
  const { pool } = workers(1, 1);
  const active = await pool.acquire();
  const waiting = pool.acquire();
  let error: unknown;
  try { await pool.acquire(); } catch (caught) { error = caught; }

  expect(error instanceof WorkerPoolBusyError).toBe(true);
  active.release();
  (await waiting).release();
});
