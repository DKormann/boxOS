import { BoxMethodSyntaxError, isValidMethodCode, validateMethodCode } from "../src/parser.ts";

test("accepts the synchronous BOXOS method subset", () => {
  expect(isValidMethodCode("return input;")).toBe(true);
  expect(isValidMethodCode("return input.delete;")).toBe(true);
  expect(isValidMethodCode(`
    return ctx.atomic(function update(tx) {
      let count = tx.state.public.get("count") || 0;
      tx.state.public.set("count", count + 1);
      return count + 1;
    });
  `)).toBe(true);
});

test("rejects ambient authority and reflective escapes", () => {
  const invalid = [
    "return globalThis.process;",
    "return input.constructor.constructor('return process')();",
    "return eval('1');",
    "return Function('return 1')();",
    "return import('node:fs');",
    "return input['constructor'];",
    "input.value = 1; return input;",
    "return (() => 1)();",
    "return new Date();",
    "class Example {}",
  ];

  for (const source of invalid) expect(isValidMethodCode(source)).toBe(false);
});

test("allows await only at method top level when asynchronous methods are enabled", () => {
  expect(() => validateMethodCode("return await ctx.call(input.box, input.method, null);", undefined, true)).not.toThrow();
  expect(() => validateMethodCode("function helper() { return await ctx.call(input.box, input.method, null); }", undefined, true)).toThrow();
});

test("reports source locations", () => {
  try {
    validateMethodCode("return globalThis;");
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(BoxMethodSyntaxError);
    expect((error as BoxMethodSyntaxError).line).toBe(1);
    expect((error as BoxMethodSyntaxError).column).toBe(8);
  }
});
