import type { BoxValue } from "../core/values.ts"
import { validateCallbackCode, validateMethodCode } from "../language/parser.ts"

export type RuntimeContext = Readonly<{
  account: string
  clientId: string | null
  invoke(
    boxId: string,
    method: string,
    argument: unknown,
    callback: Function,
    context?: unknown,
  ): void
  message(clientId: string, message: unknown): string
  publish(
    kind: "account" | "blob" | "box" | "page",
    argumentsValue: unknown,
    callback: Function,
    context?: unknown,
  ): void
  request(
    request: unknown,
    callback: Function,
    context?: unknown,
  ): void
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

// Capture compilation before running any box code. Dynamic compilation is a
// trusted-runtime operation and is never supplied as a box binding.
const NativeFunction = Function

const safeMath = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter(name => name != "random")
    .map(name => [name, Object.getOwnPropertyDescriptor(Math, name)?.value]),
))

export function compileMethod(source: string): Method {
  validateMethodCode(source)
  const factory = NativeFunction(
    "ctx",
    "input",
    "JSON",
    "Math",
    "String",
    "Number",
    `"use strict";\n${source}`,
  ) as CompiledMethod

  return (ctx, input) => factory(ctx, input, JSON, safeMath, String, Number)
}

export function compileCallback(source: string, ctx: RuntimeContext): Callback {
  validateCallbackCode(source)
  const factory = NativeFunction(
    "ctx",
    "JSON",
    "Math",
    "String",
    "Number",
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
