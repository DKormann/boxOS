import { copyBoxValue } from "./values.ts"
import { validateMethodCode } from "../language/parser.ts"

export type BoxDefinition = Readonly<{ methods: Readonly<Record<string, string>> }>

/** Validate and normalize a box definition without performing any I/O. */
export function validateBoxDefinition(value: unknown): BoxDefinition {
  const copied = copyBoxValue(value)
  if (copied === null || Array.isArray(copied) || typeof copied != "object") {
    throw new TypeError("Box definition must be an object")
  }
  const methodsValue = copied["methods"]
  if (methodsValue === null || Array.isArray(methodsValue) || typeof methodsValue != "object") {
    throw new TypeError("Box methods must be an object")
  }

  const methods: Record<string, string> = Object.create(null)
  for (const [name, source] of Object.entries(methodsValue)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)) {
      throw new TypeError(`Invalid method name ${JSON.stringify(name)}`)
    }
    if (typeof source != "string") throw new TypeError(`Method ${name} source must be a string`)
    try {
      validateMethodCode(source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new SyntaxError(`Method ${JSON.stringify(name)}: ${message}`)
    }
    methods[name] = source
  }
  if (Object.keys(methods).length == 0) throw new TypeError("A box must define at least one method")
  return { methods }
}
