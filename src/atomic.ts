import { BOX_VALUE_LIMITS, type BoxValue, copyBoxValue, parseBoxValue, stringifyBoxValue, utf8Length } from "./values.ts";
import type { StateVisibility, StateWrite } from "./worker-protocol.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStateVisibility(value: unknown): value is StateVisibility {
  return value === "public" || value === "private";
}

export function isStateKey(value: unknown): value is string {
  return typeof value === "string" && utf8Length(value) <= BOX_VALUE_LIMITS.keyBytes;
}

function normalizeStateWrites(value: unknown): StateWrite[] {
  if (!Array.isArray(value) || value.length > BOX_VALUE_LIMITS.objectKeys) throw new TypeError("Invalid atomic write set");
  const writes: StateWrite[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isStateVisibility(item.visibility) || !isStateKey(item.key) ||
        (item.operation !== "set" && item.operation !== "delete")) {
      throw new TypeError("Invalid atomic write");
    }
    const identity = `${item.visibility}\0${item.key}`;
    if (keys.has(identity)) throw new TypeError("Duplicate atomic write");
    keys.add(identity);
    const allowed = item.operation === "set" ? ["visibility", "key", "operation", "value"] : ["visibility", "key", "operation"];
    if (Object.keys(item).length !== allowed.length || Object.keys(item).some(key => !allowed.includes(key))) {
      throw new TypeError("Invalid atomic write fields");
    }
    if (item.operation === "set") {
      writes.push({ visibility: item.visibility, key: item.key, operation: "set", value: copyBoxValue(item.value) });
    } else {
      writes.push({ visibility: item.visibility, key: item.key, operation: "delete" });
    }
  }
  return writes;
}

export class AtomicCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly database: SqlClient) {}

  createSession(box: string): AtomicSession {
    return new AtomicSession(this, this.database, box);
  }

  async acquire(box: string): Promise<() => void> {
    const previous = this.queues.get(box) ?? Promise.resolve();
    let unlock = () => {};
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const tail = previous.then(() => gate);
    this.queues.set(box, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      if (this.queues.get(box) === tail) this.queues.delete(box);
    };
  }
}

export class AtomicSession {
  private release: (() => void) | null = null;
  private state: "new" | "waiting" | "active" | "closed" = "new";

  constructor(
    private readonly coordinator: AtomicCoordinator,
    private readonly database: SqlClient,
    private readonly box: string,
  ) {}

  async acquire(): Promise<void> {
    if (this.state !== "new") throw new Error("Atomic session has already started");
    this.state = "waiting";
    try {
      this.release = await this.coordinator.acquire(this.box);
      this.state = "active";
    } catch (error) {
      this.state = "closed";
      throw error;
    }
  }

  async read(visibility: StateVisibility, key: string): Promise<{ found: boolean; value?: BoxValue }> {
    if (this.state !== "active") throw new Error("Atomic session is not active");
    const row = (await this.database`
      SELECT value FROM box_state WHERE box_id = ${this.box} AND visibility = ${visibility} AND key = ${key}
    `)[0];
    return typeof row?.value === "string" ? { found: true, value: parseBoxValue(row.value) } : { found: false };
  }

  async commit(untrustedWrites: unknown): Promise<void> {
    if (this.state !== "active") throw new Error("Atomic session is not active");
    try {
      const writes = normalizeStateWrites(untrustedWrites);
      await this.database`BEGIN`;
      try {
        for (const write of writes) {
          if (write.operation === "set") {
            await this.database`
              INSERT INTO box_state (box_id, visibility, key, value)
              VALUES (${this.box}, ${write.visibility}, ${write.key}, ${stringifyBoxValue(write.value)})
              ON CONFLICT (box_id, visibility, key) DO UPDATE SET value = excluded.value
            `;
          } else {
            await this.database`
              DELETE FROM box_state WHERE box_id = ${this.box} AND visibility = ${write.visibility} AND key = ${write.key}
            `;
          }
        }
        await this.database`COMMIT`;
      } catch (error) {
        await this.database`ROLLBACK`;
        throw error;
      }
    } finally {
      this.close();
    }
  }

  abort(): void {
    this.close();
  }

  private close(): void {
    this.release?.();
    this.release = null;
    this.state = "closed";
  }
}
