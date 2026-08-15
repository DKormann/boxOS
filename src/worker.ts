import { BOX_VALUE_LIMITS, type BoxValue, copyBoxValue, parseBoxValue, stringifyBoxValue, utf8Length } from "./values.ts";
import type { EffectResultMessage, InvocationWorkerRequest, StateVisibility, StateWrite } from "./worker-protocol.ts";

const decoder = new TextDecoder();

function workerRpc(request: InvocationWorkerRequest, message: unknown): Record<string, unknown> {
  const control = new Int32Array(request.controlBuffer);
  const data = new Uint8Array(request.dataBuffer);
  Atomics.store(control, 0, 0);
  Atomics.store(control, 1, 0);
  self.postMessage(message);
  const status = Atomics.wait(control, 0, 0);
  if (status !== "ok" && status !== "not-equal") throw new Error("Atomic RPC timed out");
  const length = Atomics.load(control, 1);
  if (length < 0 || length > data.length) throw new Error("Invalid atomic RPC response");
  const response: unknown = JSON.parse(decoder.decode(data.slice(0, length)));
  if (Atomics.load(control, 0) !== 1) {
    const error = typeof response === "object" && response !== null && "error" in response &&
      typeof response.error === "string" ? response.error : "Atomic RPC failed";
    throw new Error(error);
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) throw new Error("Invalid atomic RPC response");
  return response as Record<string, unknown>;
}

function stateNamespace(request: InvocationWorkerRequest, visibility: StateVisibility, writes: Map<string, StateWrite>, active: () => boolean) {
  function checkKey(key: unknown): asserts key is string {
    if (!active()) throw new Error("Atomic transaction is no longer active");
    if (typeof key !== "string" || utf8Length(key) > BOX_VALUE_LIMITS.keyBytes) {
      throw new TypeError(`State keys must be strings of at most ${BOX_VALUE_LIMITS.keyBytes} UTF-8 bytes`);
    }
  }
  function read(key: string): { found: boolean; value?: BoxValue } {
    const write = writes.get(key);
    if (write?.operation === "delete") return { found: false };
    if (write?.operation === "set" || write?.operation === "create") return { found: true, value: copyBoxValue(write.value) };
    const response = workerRpc(request, { type: "state.read", visibility, key });
    if (typeof response.found !== "boolean") throw new Error("Invalid atomic state read response");
    return response.found ? { found: true, value: copyBoxValue(response.value) } : { found: false };
  }
  const namespace: Record<string, (...args: unknown[]) => unknown> = {
    get(key: unknown) { checkKey(key); const value = read(key); return value.found ? copyBoxValue(value.value) : null; },
    has(key: unknown) { checkKey(key); return read(key).found; },
    set(key: unknown, value: unknown) {
      checkKey(key);
      if (visibility === "shared" && !read(key).found) throw new Error("Shared state entry does not exist");
      writes.set(key, { visibility, key, operation: "set", value: copyBoxValue(value) });
    },
    delete(key: unknown) { checkKey(key); const found = read(key).found; writes.set(key, { visibility, key, operation: "delete" }); return found; },
  };
  if (visibility === "shared") {
    namespace.create = (key: unknown, authority: unknown, value: unknown) => {
      checkKey(key);
      if (typeof authority !== "string") throw new TypeError("Shared state authority must be a public key");
      if (read(key).found) throw new Error("Shared state entry already exists");
      writes.set(key, { visibility: "shared", key, operation: "create", authority, value: copyBoxValue(value) });
    };
  }
  return Object.freeze(namespace);
}

function safeMath(): Readonly<Record<string, number | ((...values: number[]) => number)>> {
  const allowed = ["abs", "ceil", "floor", "max", "min", "round", "sign", "sqrt", "trunc"];
  const result: Record<string, number | ((...values: number[]) => number)> = Object.create(null);
  for (const name of allowed) result[name] = (Math as unknown as Record<string, (...values: number[]) => number>)[name]!.bind(Math);
  result.E = Math.E;
  result.PI = Math.PI;
  return Object.freeze(result);
}

self.onmessage = (initialEvent: MessageEvent<InvocationWorkerRequest>) => {
  const request = initialEvent.data;
  let atomicActive = false;
  let nextEffectId = 1;
  let methodSettled = false;
  let candidate: { ok: true; value: BoxValue } | { ok: false; error: string } | undefined;
  const pendingEffects = new Map<number, { resolve(value: BoxValue): void; reject(error: BoxValue): void }>();
  const owned = new Set<Promise<unknown>>();

  function errorValue(value: unknown): BoxValue {
    const message = value instanceof Error ? value.message :
      typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" ? value.message :
      typeof value === "string" ? value : "Effect failed";
    return copyBoxValue({ message });
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    owned.add(promise);
    void promise.then(() => owned.delete(promise), () => owned.delete(promise));
    return promise;
  }

  const taskPromises = new WeakMap<BoxTask, Promise<BoxValue>>();

  function isNativeContinuation(value: unknown): value is (value: BoxValue) => unknown {
    return typeof value === "function" && value.name === "" && value.length === 1 &&
      Function.prototype.toString.call(value).includes("[native code]");
  }

  class BoxTask {
    constructor(promise: Promise<BoxValue>) {
      taskPromises.set(this, track(promise));
      Object.freeze(this);
    }
    then(onFulfilled?: unknown, onRejected?: unknown): BoxTask {
      if (atomicActive) throw new Error("Tasks cannot be derived inside ctx.atomic");
      const source = taskPromises.get(this)!;
      // `await task` calls then with native resolve/reject continuations. Their
      // return value is undefined and is not a BOXOS callback result or Task.
      if (isNativeContinuation(onFulfilled) && isNativeContinuation(onRejected)) {
        void source.then(
          value => onFulfilled(copyBoxValue(value)),
          error => onRejected(copyBoxValue(error)),
        );
        return undefined as unknown as BoxTask;
      }
      const promise = source.then(
        value => typeof onFulfilled === "function" ? adopt(onFulfilled(copyBoxValue(value))) : value,
        error => typeof onRejected === "function" ? adopt(onRejected(copyBoxValue(error))) : Promise.reject(error),
      ).then(copyBoxValue);
      return new BoxTask(promise);
    }
    catch(onRejected: unknown): BoxTask {
      if (atomicActive) throw new Error("Tasks cannot be derived inside ctx.atomic");
      return this.then(undefined, onRejected);
    }
  }

  function adopt(value: unknown): Promise<BoxValue> {
    if (value instanceof BoxTask) return taskPromises.get(value)!;
    return Promise.resolve(copyBoxValue(value));
  }

  function effect(effect: string, args: unknown): BoxTask {
    if (atomicActive) throw new Error("Effects are not allowed inside ctx.atomic");
    if (pendingEffects.size >= 64) throw new Error("Invocation has too many concurrent effects");
    const id = nextEffectId++;
    const promise = new Promise<BoxValue>((resolve, reject) => pendingEffects.set(id, { resolve, reject }));
    self.postMessage({ type: "effect", id, effect, args: copyBoxValue(args) });
    return new BoxTask(promise);
  }

  async function finishWhenIdle(): Promise<void> {
    if (!methodSettled) return;
    while (owned.size > 0) await Promise.allSettled([...owned]);
    if (!candidate) return;
    self.postMessage(candidate.ok
      ? { type: "result", ok: true, result: candidate.value }
      : { type: "result", ok: false, error: candidate.error });
  }

  self.onmessage = (event: MessageEvent<EffectResultMessage>) => {
    const message = event.data;
    if (message?.type !== "effect.result" || !Number.isInteger(message.id)) return;
    const pending = pendingEffects.get(message.id);
    if (!pending) return;
    pendingEffects.delete(message.id);
    try {
      if (message.ok) pending.resolve(copyBoxValue(message.value));
      else pending.reject(errorValue(message.error));
    } catch (error) {
      pending.reject(errorValue(error));
    }
  };

  try {
    const ctx = Object.freeze({
      rootCaller: request.context.rootCaller,
      box: request.context.box,
      method: request.context.method,
      immediateCaller: request.context.immediateCaller === null ? null : Object.freeze(copyBoxValue(request.context.immediateCaller)),
      request(url: unknown, options: unknown = null) { return effect("request", { url, options }); },
      call(box: unknown, method: unknown, input: unknown = null) { return effect("call", { box, method, input }); },
      hostPage(blob: unknown) { return effect("hostPage", { blob }); },
      verify(publicKey: unknown, message: unknown, signature: unknown) {
        return effect("verify", { publicKey, message, signature });
      },
      atomic(callback: unknown) {
        if (typeof callback !== "function") throw new TypeError("ctx.atomic requires a function");
        if (atomicActive) throw new Error("Nested atomic blocks are not allowed");
        atomicActive = true;
        let active = true;
        let sessionOpen = false;
        const publicWrites = new Map<string, StateWrite>();
        const sharedWrites = new Map<string, StateWrite>();
        const privateWrites = new Map<string, StateWrite>();
        const tx = Object.freeze({ state: Object.freeze({
          public: stateNamespace(request, "public", publicWrites, () => active),
          shared: stateNamespace(request, "shared", sharedWrites, () => active),
          private: stateNamespace(request, "private", privateWrites, () => active),
        }) });
        try {
          workerRpc(request, { type: "state.begin" });
          sessionOpen = true;
          const raw = callback(tx);
          if (raw instanceof BoxTask) throw new Error("Atomic callbacks cannot return Tasks");
          const value = copyBoxValue(raw);
          try {
            workerRpc(request, { type: "state.commit", writes: [...publicWrites.values(), ...sharedWrites.values(), ...privateWrites.values()] });
          } finally {
            // The host ends the session on every commit outcome.
            sessionOpen = false;
          }
          return value;
        } finally {
          if (sessionOpen) {
            try { workerRpc(request, { type: "state.abort" }); } catch { /* host termination also releases the lock */ }
          }
          active = false;
          atomicActive = false;
        }
      },
    });

    const safeJSON = Object.freeze({ parse(text: string) { return parseBoxValue(text); }, stringify(value: unknown) { return stringifyBoxValue(value); } });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const execute = new AsyncFunction("ctx", "input", "JSON", "Math", "String", "Number", `"use strict";\n${request.source}`);
    void execute(ctx, copyBoxValue(request.input), safeJSON, safeMath(), String, Number).then(
      async raw => {
        try {
          const value = raw instanceof BoxTask ? await taskPromises.get(raw)! : copyBoxValue(raw);
          candidate = { ok: true, value: copyBoxValue(value) };
        } catch (error) { candidate = { ok: false, error: (errorValue(error) as { message: string }).message }; }
        methodSettled = true;
        await finishWhenIdle();
      },
      async error => {
        candidate = { ok: false, error: (errorValue(error) as { message: string }).message };
        methodSettled = true;
        await finishWhenIdle();
      },
    );
  } catch (error) {
    candidate = { ok: false, error: (errorValue(error) as { message: string }).message };
    methodSettled = true;
    void finishWhenIdle();
  }
};
