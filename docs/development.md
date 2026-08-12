# Development phase and stability policy

## BOXOS 0.2 is not durable

BOXOS is currently a design experiment. Version 0.2 provides **no API compatibility, data durability, account continuity, or availability guarantees**.

Anything created with the current service may become inaccessible or be deleted. This includes source registrations, reducer state, pages, page origins, bearer fuel accounts, browser-owned signed accounts, profiles, grants, application data, and fuel balances. A release may change hashes, runtime behavior, storage representation, or browser origins without migration.

Content addressing describes the design: within a particular runtime and retained dataset, source and pages are addressed by content. It is not currently an operational promise that the hosted 0.2 service will retain that content forever or continue executing it with historical semantics.

## Current decision rule

During 0.2, choose the cleanest long-term model even when it breaks every existing application.

In order of priority:

1. conceptual integrity;
2. a minimal and teachable public model;
3. explicit semantics and failure modes;
4. implementation structure that mirrors the model;
5. a plausible scaling path;
6. measured performance;
7. migration and compatibility.

Migration is welcome when it is simple and does not distort the design. It is never a reason to retain a poor abstraction during this phase. Compatibility layers should not be added unless they clarify a future versioning boundary that the project intends to keep.

## What “beauty” means here

A beautiful BOXOS design should:

- have few primitives with non-overlapping responsibilities;
- make expensive or remote boundaries visible;
- state concurrency and authorization rules in a few sentences;
- keep durable effects separate from external effects;
- avoid hidden registries, mutable deployment behavior, and framework machinery;
- allow the backing implementation to scale without changing userspace semantics;
- be inspectable enough that source remains the main explanation.

It should not optimize benchmark numbers by obscuring the model. It should also not preserve accidental behavior merely because data already exists under it.

## Before a stability promise

Durability and compatibility must remain explicitly disclaimed until the project deliberately defines:

- a stable API and runtime-version policy;
- database migration and rollback procedures;
- backups, restore testing, and retention policy;
- account recovery and browser-origin migration;
- deprecation periods and compatibility expectations;
- production security and availability targets.

Until then, deployments should be treated as disposable and users should keep their own source and any data they care about.
