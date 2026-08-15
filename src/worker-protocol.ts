import type { BoxValue } from "./values.ts";

export type StateVisibility = "public" | "private" | "shared";
export type StateWrite =
  | { visibility: StateVisibility; key: string; operation: "set"; value: BoxValue }
  | { visibility: "shared"; key: string; operation: "create"; authority: string; value: BoxValue }
  | { visibility: StateVisibility; key: string; operation: "delete" };

export type InvocationWorkerContext = {
  rootCaller: string;
  box: string;
  method: string;
  immediateCaller: { box: string; method: string } | null;
};

export type InvocationWorkerRequest = {
  source: string;
  input: BoxValue;
  context: InvocationWorkerContext;
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
};

export type EffectName = "request" | "call" | "hostPage" | "verify";

export type WorkerToHostMessage =
  | { type: "state.begin" }
  | { type: "state.read"; visibility: unknown; key: unknown }
  | { type: "state.commit"; writes: unknown }
  | { type: "state.abort" }
  | { type: "effect"; id: unknown; effect: unknown; args: unknown }
  | { type: "result"; ok: true; result: unknown }
  | { type: "result"; ok: false; error: unknown };

export type EffectResultMessage =
  | { type: "effect.result"; id: number; ok: true; value: unknown }
  | { type: "effect.result"; id: number; ok: false; error: unknown };
