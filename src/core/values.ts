export type BoxValue = null | boolean | number | string | BoxValue[] | { [key: string]: BoxValue };

export const BOX_VALUE_LIMITS = Object.freeze({
  encodedBytes: 1 * 1024 * 1024,
  depth: 32,
  arrayLength: 10_000,
  objectKeys: 10_000,
  stringBytes: 256 * 1024,
  keyBytes: 1024,
});

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

export function validateBoxKey(key: unknown, description = "BOXOS object keys"): asserts key is string {
  if (typeof key !== "string" || utf8Length(key) > BOX_VALUE_LIMITS.keyBytes) {
    throw new TypeError(`${description} must be strings of at most ${BOX_VALUE_LIMITS.keyBytes} UTF-8 bytes`);
  }
}

/** Validate and copy a value into a prototype-free finite BOXOS value tree. */
export function copyBoxValue(value: unknown): BoxValue {
  const active = new Set<object>();

  function copy(current: unknown, depth: number): BoxValue {
    if (depth > BOX_VALUE_LIMITS.depth) {
      throw new TypeError(`BOXOS value nesting exceeds ${BOX_VALUE_LIMITS.depth} levels`);
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (utf8Length(current) > BOX_VALUE_LIMITS.stringBytes) throw new TypeError("BOXOS string is too large");
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("BOXOS numbers must be finite");
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object") throw new TypeError("Unsupported BOXOS value");
    if (active.has(current)) throw new TypeError("Cyclic values are not BOXOS values");

    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > BOX_VALUE_LIMITS.arrayLength) throw new TypeError("BOXOS array is too large");
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some(key => {
          if (typeof key === "symbol") return true;
          if (key === "length") return false;
          if (!/^(0|[1-9][0-9]*)$/.test(key)) return true;
          const index = Number(key);
          return !Number.isSafeInteger(index) || index < 0 || index >= current.length;
        })) {
          throw new TypeError("BOXOS arrays may contain only indexed values");
        }
        const result: BoxValue[] = [];
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("Sparse arrays and accessors are not BOXOS values");
          }
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("BOXOS objects must be plain records");
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.length > BOX_VALUE_LIMITS.objectKeys) throw new TypeError("BOXOS object is too large");
      const result: { [key: string]: BoxValue } = Object.create(null);
      for (const key of ownKeys) {
        if (typeof key !== "string") throw new TypeError("BOXOS object keys must be strings");
        validateBoxKey(key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("BOXOS objects may contain only enumerable data properties");
        }
        try {
          result[key] = copy(descriptor.value, depth + 1);
        } catch (error) {
          if (error instanceof TypeError) throw new TypeError(`${error.message} at property ${JSON.stringify(key)}`);
          throw error;
        }
      }
      return result;
    } finally {
      active.delete(current);
    }
  }

  const result = copy(value, 0);
  if (encoder.encode(JSON.stringify(result)).length > BOX_VALUE_LIMITS.encodedBytes) {
    throw new TypeError("BOXOS value encoding is too large");
  }
  return result;
}

function canonicalize(value: BoxValue): BoxValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const result: { [key: string]: BoxValue } = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]!);
  return result;
}

/** Encode a value deterministically for hashing, signing, and persistence. */
export function stringifyBoxValue(value: unknown): string {
  return JSON.stringify(canonicalize(copyBoxValue(value)));
}

export function parseBoxValue(text: string): BoxValue {
  return copyBoxValue(JSON.parse(text));
}
