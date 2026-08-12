# BOXOS contributor instructions

## Project phase: 0.2

BOXOS 0.2 is a design-stage experiment. There are **no durability or compatibility guarantees of any kind**.

Assume all of the following may change or be discarded without migration:

- HTTP and browser APIs;
- restricted-language syntax and runtime semantics;
- code hashes and built-in reducer hashes;
- reducer state and SQLite schemas;
- bearer identities, signed accounts, grants, and profiles;
- immutable page IDs, origins, and published examples;
- fuel balances, prices, and limits.

Do not preserve an inferior abstraction merely to keep current data or applications working. Breaking changes are expected. Existing deployments may be reset, and migration work is optional unless it helps evaluate the new design.

The current priority is **beauty of design**:

1. a small model that can be explained completely;
2. explicit semantics and boundaries;
3. clean composition of a few orthogonal primitives;
4. an implementation whose structure reflects the public model;
5. a credible path to scale without premature machinery.

Performance optimization is secondary until the model is right. Compatibility, migration, and operational durability become requirements only when the project explicitly leaves this design phase.

When documentation uses words such as “immutable”, “permanent”, or “durable”, treat them as properties of the intended content-addressed model—not promises that the 0.2 hosted service will retain data or preserve APIs.

## Working practices

- Read `docs/development.md` and the relevant architecture documents before changing core semantics.
- Prefer deleting accidental complexity over adding compatibility layers.
- Update public documentation and examples when an API changes.
- Keep tests focused on current semantics, not compatibility with discarded semantics.
- Run `bun test` and `bunx tsc --noEmit` before finishing.
