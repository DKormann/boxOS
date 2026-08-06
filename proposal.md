# Architecture summary

## The user-facing model

Submit a function definition over HTTP; it runs server-side with private persistent storage. Also host static assets addressed by SHA-256. A full-stack app is a handful of HTTP calls, no account required.

## Identity and state

- A function is identified by the hash of its code. State is namespaced per function — invocations of the same function share state, nothing else does.
- **Immutable and transparent by default.** Any upgradeability is built *in* the function (logic-as-data, hardcoded admin key) and is therefore visible to everyone who reads it. The invariant: every user can see exactly if and how a function can be updated.
- *Proposed, undecided:* submission becomes `{template: hash, params: {...}}` with namespace `= hash(template, params)`. Puts the owner key in params (closing an initialization front-running race), makes template recognition free, and lets one compiled artifact be shared across every user of a template.
- Writes carry a TTL. Indefinite storage deferred — the cost is a stock, not a flow, and betting on price decline needs an endowment model.

## Execution and transactions

- Restricted JS subset, validated by a custom parser at registration. Validator is **versioned**, and each function records which version it passed — because content-addressed code is permanent, so tightening the grammar later can't be a flag day.
- `eval` / `new Function` supported, validated at eval time under the enclosing function's validator version.
- **Standard eager JS async semantics, unmodified.** Subset, don't redefine. Safety comes from statically rejecting floating promises and enforcing structured concurrency at the invocation boundary.
- **`await` is the transaction boundary.** Each segment between awaits commits atomically; effects flush between segments. Segments are transactional by default — no opt-in ceremony for the common case.
- Effects are deferred to post-commit and delivered at-least-once, so contention resolves *before* money is spent. Storage effects are exactly-once; external effects are at-least-once with idempotency keys.
- **Replay-based durable execution.** An event-sourced log records reads, writes, effect results, and every nondeterministic value. Resumption re-runs from the top with committed segments served entirely from the log — never live storage — and concurrent effects resolved in logged order.
- Retry granularity is the whole invocation, not inner blocks. Avoids the captured-mutable-locals bug that every retry-callback API ships.
- `Promise.all` batches effects into a single segment: one commit, one suspension, one replay.

## Composition

- Function calls are **in-process, not RPC**. A whole call tree runs on one worker, in one transaction, one commit.
- **Reentrancy is illegal** — call-stack membership check, trap on re-entry. Default-deny, opt-out available. Note it only protects within a synchronous stack, not across awaits.
- Pinned hash references **cannot form cycles** (a hash cycle is infeasible to construct), so a fully-pinned call graph is acyclic by construction and reentrancy is unreachable within it. Free property, worth surfacing as something callers can demand.
- Dependencies injected as parameters rather than hardcoded, so upgrades are a caller-side decision instead of requiring redeploy of every transitive dependent.
- Fuel capped explicitly at each call site. A callee that awaits splits its caller's transaction, so "does this await?" is part of a function's public contract.

## Runtime and caching

**Code is replicable; state is not.** Replicate code everywhere, route by whatever clusters.

- V8, caching `UnboundScript` per isolate, bound into a **fresh Context per invocation** — reuses compiled code with no serialization, while making dirty state structurally impossible rather than statically argued.
- Content addressing means no cache invalidation, ever. Two-tier cache (worker-local → DB → compile), write-behind for artifacts, in-process single-flight per hash.
- Session/user affinity, strictly advisory. Buys cache locality, contention locality, and — most importantly under replay — lets a resumption skip replay entirely by finding its state already warm.
- One DB, N workers.

## Fuel

PoW-minted, later purchasable. Memory-hard hash function (the ASIC gap is the whole ballgame), adaptive difficulty. Metering covers storage writes and bytes-over-time, not just instructions. No pricing guarantees offered.

<details>
<summary><strong>Considered and set aside</strong></summary>

- **Mutable code pointer with owner key** — rejected; the transparency invariant is better.
- **Procedure as the default path** — resolved by the async model, which makes segments transactional by default.
- **Lazy futures** — JS promises are eager, and eager is actually better here because it batches effects.
- **QuickJS native** — simpler, exact metering, cheap fresh runtimes; still the fallback if V8 metering or isolate cost disappoints.
- **Wasmtime + Javy** — memory-level sandboxing, machine-code artifacts, built-in fuel, and language-agnostic submission. The path if the JS engine shouldn't be the only security boundary.
- **Routing by function hash** — inverted once it became clear code replicates freely and access clusters per user.

</details>

## Open

1. Submission format (template + params) — accept or keep raw source?
2. Whether PoW survives as the mint, or becomes a rate limiter with a different faucet.
3. Storage rent mechanism: TTL renewal vs. continuous drip vs. hard quota.
4. Replay history size limits and the continue-as-new equivalent.
5. Fuel for resumptions and replay — who pays, and how it's metered separately.
6. Whether a lint against pre-await reads used post-await is worth building (it's mechanically detectable and catches a silent hazard).
7. What happens when one DB stops being enough.