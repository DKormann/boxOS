# BOXOS architecture draft

Status: **incremental implementation design for BOXOS 0.3.0**

This folder defines the architecture agreed for the next implementation. It is intentionally incomplete. The current repository will eventually be discarded and rebuilt from these specifications, so these documents describe the intended system rather than the current code.

Nothing here is a compatibility, migration, availability, or data-retention promise. Design clarity takes precedence over preserving the current implementation.

## Core statement

> BOXOS stores immutable blobs. A box binds an immutable validated method table to isolated mutable state. Methods coordinate owned asynchronous tasks and change their box's state only through synchronous atomic blocks. Boxes never share transactions. Accounts provide signing authority and fuel.

## Documents

1. [Principles and vocabulary](principles.md)
2. [BOXOS values](values.md)
3. [Blobs, boxes, and methods](boxes.md)
4. [Invocations and atomic state](execution.md)
5. [Tasks and effects](tasks.md)
6. [Accounts, signatures, and calls](accounts.md)
7. [Fuel accounting](fuel.md)
8. [Hosted pages](pages.md)
9. [Method language direction](language.md)
10. [HTTP protocol 0.3.0](protocol.md)
11. [Open decisions](open-decisions.md)

The language document records the agreed initial restrictions and asynchronous model. Implementation proceeds in small layers; blobs and box definitions precede method execution.

## Normative language

- **Must** defines a required semantic property.
- **Must not** defines prohibited behavior.
- **Should** records the current preferred design where implementation experience may still refine details.
- **May** leaves a choice to implementations.

## Deliberate omissions

These documents do not yet specify:

- method-language syntax;
- signature algorithms and signed-command details;
- invocation and browser SDK signatures;
- scheduling and physical box-state layout;
- scheduling algorithms;
- durable messaging;
- exact page ID encoding and hosting route;
- account issuance or initial fuel allocation;
- production security and operational policy.

Those layers must preserve the abstract model defined here rather than leak implementation details into it.
