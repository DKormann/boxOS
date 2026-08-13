import { BOX_VALUE_LIMITS, copyBoxValue, parseBoxValue, stringifyBoxValue } from "../src/values.ts";

function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

test("copies the complete BOXOS value domain and normalizes negative zero", () => {
  const source = { null: null, boolean: true, number: -0, string: "text", array: [1, { ok: false }] };
  const copied = copyBoxValue(source);
  expect(copied).toEqual({ null: null, boolean: true, number: 0, string: "text", array: [1, { ok: false }] });
  expect(Object.getPrototypeOf(copied)).toBeNull();
  expect(Object.is((copied as Record<string, unknown>).number, -0)).toBe(false);
  expect(parseBoxValue(stringifyBoxValue(source))).toEqual(copied);
});

test("rejects unsupported, cyclic, sparse, accessor, and behavioral values", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const sparse = Array(1);
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { return 1; } });
  const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
  const symbol = { [Symbol("value")]: 1 };

  for (const value of [undefined, NaN, Infinity, 1n, function () {}, new Date(), cycle, sparse, accessor, hidden, symbol]) {
    expect(() => copyBoxValue(value)).toThrow();
  }
});

test("enforces depth, collection, string, key, and encoded-byte limits", () => {
  expect(() => copyBoxValue(nested(BOX_VALUE_LIMITS.depth))).not.toThrow();
  expect(() => copyBoxValue(nested(BOX_VALUE_LIMITS.depth + 1))).toThrow();
  expect(() => copyBoxValue(Array(BOX_VALUE_LIMITS.arrayLength + 1).fill(null))).toThrow();
  expect(() => copyBoxValue("x".repeat(BOX_VALUE_LIMITS.stringBytes + 1))).toThrow();
  expect(() => copyBoxValue({ ["x".repeat(BOX_VALUE_LIMITS.keyBytes + 1)]: null })).toThrow();

  const individuallyValidStrings = Array(5).fill("x".repeat(BOX_VALUE_LIMITS.stringBytes));
  expect(() => copyBoxValue(individuallyValidStrings)).toThrow("encoding is too large");
});
