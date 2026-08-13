# BOXOS values

## Value domain

All method inputs, method results, state values, Task results, errors exposed to methods, and signed structured messages are built from one finite value domain:

```text
null
boolean
finite number
string
array of BOXOS values
object mapping string keys to BOXOS values
```

No other runtime value may cross a BOXOS boundary.

In particular, reject:

- `undefined`;
- `NaN` and positive or negative infinity;
- functions;
- Tasks;
- symbols and big integers;
- dates, regular expressions, maps, sets, typed arrays, and host objects;
- sparse arrays;
- cyclic arrays or objects;
- objects with custom prototypes, accessors, or behavior.

Negative zero is normalized to positive zero at a value boundary.

## Objects

Object key order has no semantic meaning. Objects are plain string-keyed records. Dangerous host-language property behavior such as prototypes and accessors must not be observable through the BOXOS value model.

Duplicate keys in method source literals should be rejected. Protocol JSON is decoded with ordinary `JSON.parse`, whose standard last-key behavior applies.

## Strings

Strings are Unicode text. JSON strings are encoded as UTF-8 for hashing and signing. Implementations must not apply locale-sensitive comparison or implicit Unicode normalization.

## Boundaries

Values are validated and copied at every authority or persistence boundary:

- root invocation input;
- cross-box call input and result;
- request options and response;
- atomic state read and write;
- method result;
- Task callback result;
- signing and verification API.

A method cannot use object identity or mutation to share memory across invocations, Tasks executing in separate invocations, or stored state snapshots.

## Limits

Every implementation must enforce finite limits on:

- total encoded bytes;
- nesting depth;
- array length;
- object key count;
- string and key byte length.

The initial implementation limits are:

- 1 MiB total JSON-encoded bytes;
- 32 levels of nesting below the root value;
- 10,000 array elements;
- 10,000 object keys;
- 256 KiB UTF-8 per string;
- 1,024 UTF-8 bytes per object or state key.

Limit failures reject the containing operation rather than truncate or silently transform the value. These values remain deployment policy rather than stable protocol guarantees.

## JSON encoding

BOXOS 0.3.0 validates a BOXOS value and then serializes it with ordinary `JSON.stringify`; the resulting text is encoded as UTF-8. There is no canonicalization or object-key sorting. Property insertion order is significant for hashes and signatures.

Validation must happen before serialization because `JSON.stringify` otherwise drops or transforms unsupported values. Negative zero is normalized before serialization.
