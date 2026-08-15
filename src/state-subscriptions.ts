import type { StateVisibility, StateWrite } from "./worker-protocol.ts";

export type SubscribableVisibility = Extract<StateVisibility, "public" | "shared">;
export type StateChangeListener = (write: StateWrite) => void;

const listeners = new Map<string, Set<StateChangeListener>>();

function identity(box: string, visibility: SubscribableVisibility, key: string): string {
  return `${box}\0${visibility}\0${key}`;
}

export function subscribeToState(box: string, visibility: SubscribableVisibility, key: string, listener: StateChangeListener): () => void {
  const id = identity(box, visibility, key);
  let group = listeners.get(id);
  if (!group) {
    group = new Set();
    listeners.set(id, group);
  }
  group.add(listener);
  return () => {
    group?.delete(listener);
    if (group?.size === 0) listeners.delete(id);
  };
}

export function publishStateWrites(box: string, writes: StateWrite[]): void {
  for (const write of writes) {
    if (write.visibility !== "public" && write.visibility !== "shared") continue;
    for (const listener of listeners.get(identity(box, write.visibility, write.key)) ?? []) {
      try { listener(write); } catch { /* A disconnected stream cannot affect the committed write. */ }
    }
  }
}
