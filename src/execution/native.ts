import type { BoxValue } from "../core/values.ts"
import { validateCallbackCode, validateMethodCode } from "../language/parser.ts"

export type TaskRole = "success" | "failure"
export type TaskRegistrar = (
  sourceTaskId: string,
  role: TaskRole,
  callback: Function,
  context: unknown,
) => RuntimeTask

export interface RuntimeTask {
  then(callback: Function, context?: unknown): RuntimeTask
  catch(callback: Function, context?: unknown): RuntimeTask
}

const taskIds = new WeakMap<object, string>()

export function createRuntimeTask(id: string, register: TaskRegistrar): RuntimeTask {
  const then = Object.freeze((callback: Function, context: unknown = null) =>
    register(id, "success", callback, context))
  const recover = Object.freeze((callback: Function, context: unknown = null) =>
    register(id, "failure", callback, context))
  const task = Object.freeze({ then, catch: recover })
  taskIds.set(task, id)
  return task
}

export function runtimeTaskId(value: unknown): string | null {
  return value !== null && typeof value == "object" ? taskIds.get(value) ?? null : null
}

export type RuntimeContext = Readonly<{
  account: string
  clientId: string | null
  invoke(boxId: string, method: string, argument: unknown): RuntimeTask
  message(clientId: string, message: unknown): string
  publish(kind: "account" | "blob" | "box" | "page", argumentsValue: unknown): RuntimeTask
  request(request: unknown): RuntimeTask
  transfer(receiver: string, amount: number): void
  storage: Readonly<{
    public: RuntimeStorage
    private: RuntimeStorage
  }>
}>

export type RuntimeStorage = Readonly<{
  get(key: string): BoxValue | null
  set(key: string, value: unknown): void
  delete(key: string): void
}>

type Method = (ctx: RuntimeContext, input: BoxValue) => unknown
type CompiledMethod = (
  ctx: RuntimeContext,
  input: BoxValue,
  json: JSON,
  math: object,
  string: StringConstructor,
  number: NumberConstructor,
) => unknown
type Callback = (result: BoxValue, context: BoxValue) => unknown

const NativeFunction = Function
const safeMath = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter(name => name != "random")
    .map(name => [name, Object.getOwnPropertyDescriptor(Math, name)?.value]),
))

export function compileMethod(source: string): Method {
  validateMethodCode(source)
  const factory = NativeFunction(
    "ctx", "input", "JSON", "Math", "String", "Number",
    `"use strict";\n${source}`,
  ) as CompiledMethod
  return (ctx, input) => factory(ctx, input, JSON, safeMath, String, Number)
}

export function compileCallback(source: string, ctx: RuntimeContext): Callback {
  validateCallbackCode(source)
  const factory = NativeFunction(
    "ctx", "JSON", "Math", "String", "Number",
    `"use strict"; return (${source}\n);`,
  ) as (
    ctx: RuntimeContext,
    json: JSON,
    math: object,
    string: StringConstructor,
    number: NumberConstructor,
  ) => Callback
  return factory(ctx, JSON, safeMath, String, Number)
}
