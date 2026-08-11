# Minimal BOXOS Studio

## Principle

Studio is an ordinary immutable BOXOS page published through the built-in page reducer, with no dedicated server route or special handling. Its isolated origin exposes the same `/client.js` and API routes as every other page.

Validation and publication happen through immutable system procedures. User-created procedures can use the same capabilities, so Studio has no privileged publishing API unavailable to ordinary BOXOS code.

The server remains a small kernel: content storage, invocation, transactions, public-state reads, page serving, and explicit capabilities.

## What can procedures do?

Procedures can now validate and publish code:

```js
let checked = ctx.validate(input.kind, input.code);
let published = await ctx.publish(input.kind, input.code);
return published;
```

`ctx.validate` applies the same parser used by registration and returns the kind and content hash. It does not store code.

`ctx.publish` validates and permanently registers reducer or procedure source. Storage fuel is charged to the original procedure caller. Publication is a permanent external effect, like fetch, and is not rolled back if the procedure later fails.

BOXOS always registers two tiny system procedures:

```js
return ctx.validate(input.kind, input.code);
```

```js
return await ctx.publish(input.kind, input.code);
```

Their immutable hashes are embedded in Studio's published source, just like any other userspace dependency. Studio invokes these procedures rather than requiring a special `/validate` endpoint. Direct HTTP registration remains a low-level compatibility route, but Studio does not need it.

## Minimal workspace

A workspace is local browser data containing a short list of nodes:

- reducer;
- procedure;
- page;
- pinned reference to published code.

A node contains only a name, kind, source, and named dependencies. Drafts are saved in IndexedDB. Export and import use one readable JSON file and never include the bearer identity.

There is no mutable server-side project. Publishing creates immutable hashes; editing a published node creates a new draft.

## Connected functionality

Dependencies are explicit named pins. Studio inserts published hashes into the final source and shows the exact source before publication.

Changing an upstream draft marks dependent drafts as changed. Publishing proceeds bottom-up:

1. publish reducers;
2. insert reducer hashes into procedures;
3. publish procedures;
4. insert final hashes into pages;
5. publish pages through the built-in page reducer.

No reference comments or separate manifest are required. The restricted JavaScript parser reports every 64-character code hash used as a string literal. Studio treats those literals as outgoing connections and attempts to inspect each target. For HTML pages, Studio scans for the same full hash literals.

```js
return tx.invoke("22b2e192642c1098fc5a59222ada9233decbe93294f91f6d068d6e63e63d63c0", input);
```

This keeps executable source authoritative and makes ordinary code directly inspectable. A hash assembled dynamically at runtime will not appear in the graph; Studio can simply label the node as having dynamic dependencies rather than introducing hidden metadata.

## Interface

Keep one screen with three simple columns.

### Nodes

A list of workspace nodes with only these states:

- Draft
- Published
- Changed
- Blocked by draft dependency

Selecting a dependency opens that node. A plain indented list is preferable to a graphical canvas.

### Editor

Use a native textarea initially. Show:

- node name and kind;
- source;
- dependencies;
- Check;
- Run;
- Publish;
- Fork, for immutable published source.

Do not show hash estimates or fuel estimates. After an operation, show the actual hash and fuel receipt returned by BOXOS.

### Run panel

For reducers and procedures:

- JSON input;
- Run button;
- JSON result or error;
- actual fuel receipt;
- public-state key reader.

For pages:

- source textarea;
- Publish button;
- resulting page URL.

There is no embedded page preview for now. Published pages open in a new tab at their isolated page origin.

## Inspection

Studio has one small “Open hash or page ID” field. It loads reducer or procedure source through `/code/<hash>`. A 16-character page ID is loaded from the built-in page reducer's public state. Published source opens read-only; **Fork** creates an editable local draft whose publication receives a new hash or page ID.

Do not add shareable Studio links yet. Keep the internal selection model clean so fragment links such as `#code=<hash>` or `#page=<id>` can be added later without server routing or special treatment.

## Self-hosting boundary

Studio can be implemented using existing BOXOS primitives:

- an immutable HTML page for the UI;
- `/client.js` for transport and bearer identity;
- the validation procedure;
- the publication procedure;
- ordinary invocation for running code;
- public state for inspection;
- the built-in page reducer for publishing pages;
- optional reducers for persistent workspace collaboration later.

The browser still needs generic kernel routes to invoke a hash and read immutable code or public state. Those are BOXOS primitives, not Studio-specific APIs. Studio should not require a privileged editor backend.

## First version

Build only:

1. local reducer, procedure, and page drafts;
2. a node list and explicit dependencies;
3. native source and JSON input textareas;
4. check through the validation procedure;
5. run through normal invocation;
6. publish through the publication procedure or page reducer;
7. read-only opening by manually entered hash;
8. public-state lookup;
9. local save plus JSON import/export;
10. account balance and actual operation receipts.

Defer graphical editing, collaboration, previews, estimates, package management, and shareable inspection routes.
