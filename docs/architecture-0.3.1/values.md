# BOXOS values

## Value domain

Every persistent or cross-boundary value is finite and built from:

```text
null
boolean
finite number
string
array of BOXOS values
plain object mapping strings to BOXOS values
```

Reject `undefined`, non-finite numbers, functions, symbols, big integers, dates, regular expressions, maps, sets, typed arrays, sparse arrays, cycles, accessors, custom prototypes, and host objects. Normalize negative zero to positive zero at boundaries.

## Boundaries

Validate and copy values at least at:

- root invocation input;
- child invocation input and result;
- callback context;
- callback result or error input;
- state reads and writes;
- HTTP request and response boundaries;
- signed structured messages;
- provider settlement records.

Function source is persisted callback code, not a BOXOS value. A function may cross only the trusted callback-registration path and is never accepted as ordinary input, state, context, or result.

## Limits

Implementations must bound encoded bytes, nesting depth, array length, object key count, string size, and key size. A limit failure rejects the containing turn or protocol command; values are never truncated.

The initial limits may retain:

```text
1 MiB total JSON bytes
32 nesting levels
10,000 array elements
10,000 object keys
256 KiB UTF-8 per string
1,024 UTF-8 bytes per key
```

## Encoding

Validate first, then serialize structured protocol values with ordinary `JSON.stringify` and UTF-8. Object property insertion order is significant for hashes and signatures. Runtime 0.3.1 does not sort keys or claim a separate canonical JSON format.
