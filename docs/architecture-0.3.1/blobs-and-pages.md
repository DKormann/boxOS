# Blobs and pages

## Blobs

BOXOS retains one generic content-addressed byte store:

```text
put(bytes) -> blob ID
get(blob ID) -> exact bytes
```

A blob has no intrinsic type. Box definitions, method source, HTML, and ordinary data interpret immutable bytes according to their references.

Hash domains must include the protocol version. Exact prefixes and external encodings are protocol details to settle before implementation.

## Box code

A box definition references immutable method-source blobs and one runtime version. Providers may store physical copies, but the content identity is global. The responsible provider and stateful box address are distinct from the reusable code blob identity.

## Pages

A hosted page remains immutable HTML bytes served at a collision-checked content-derived address on an isolated browser origin. Serving a page does not execute a method or create an invocation.

Hosting new content is a fuel-charged operation. A page hosted by the central server is under server integrity responsibility. A page served by another provider is under that provider's responsibility and should have a provider-qualified address.

Public cached serving need not debit an invocation for each read. Retention and initial hosting may charge an account or invocation according to explicit server policy.
