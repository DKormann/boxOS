# BOXOS architecture draft

Status: **pre-implementation design for BOXOS 0.2**

This folder defines the architecture agreed for the next implementation. It is intentionally incomplete. The current repository will eventually be discarded and rebuilt from these specifications, so these documents describe the intended system rather than the current code.

Nothing here is a compatibility, migration, availability, or data-retention promise. Design clarity takes precedence over preserving the current implementation.

## Core statement

> BOXOS stores immutable blobs. A box binds an immutable validated method table to isolated mutable state. Methods coordinate owned asynchronous tasks and change their box's state only through synchronous atomic blocks. Boxes never share transactions. Accounts provide signing authority and fuel.

## Documents

1. [Principles and vocabulary](principles.md)
2. [Blobs, boxes, and methods](boxes.md)
3. [Invocations and atomic state](execution.md)
4. [Tasks and effects](tasks.md)
5. [Accounts, signatures, and calls](accounts.md)
6. [Fuel accounting](fuel.md)
7. [Open decisions](open-decisions.md)

The restricted method language will be specified separately after this architectural layer is accepted.

## Normative language

- **Must** defines a required semantic property.
- **Must not** defines prohibited behavior.
- **Should** records the current preferred design where implementation experience may still refine details.
- **May** leaves a choice to implementations.

## Deliberate omissions

These documents do not yet specify:

- method-language syntax;
- canonical encodings and cryptographic algorithms;
- HTTP routes or browser SDK signatures;
- physical storage layout;
- scheduling algorithms;
- durable messaging;
- account issuance or initial fuel allocation;
- production security and operational policy.

Those layers must preserve the abstract model defined here rather than leak implementation details into it.
