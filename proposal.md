# Architecture proposal

## Model

Submit restricted JavaScript code over HTTP. It is stored as SHA-256-addressed code and runs per request with private persistent state. Function code is immutable and publicly readable. Upgrade behavior is expressed in the code, making it visible to callers.

## User accounts

A user is an implicit account identified by an unguessable bearer credential. No separate registration, username, password, or predefined account is required. The permanent store contains only a hash of the credential and the account's fuel balance. A function receives the stable, public user ID derived from that credential, never the credential itself.

A newly observed user receives a one-time allocation of **2,000,000 fuel**. There is no automatic replenishment or administrative top-up in the initial protocol. Fuel balances persist across server restarts. Creating another credential creates another account, so this initial model provides accounting and isolation rather than Sybil resistance.

Every invocation is attributed to its authenticated caller. Reducers and procedures receive a frozen context containing `caller`, the caller's user ID. Nested reducer calls retain the original caller; a procedure cannot substitute another identity.

## Fuel

Fuel is an integer account balance. Runtime costs **one fuel per elapsed millisecond**, rounded up with a minimum charge of one fuel. Execution reserves a caller-selected budget before starting, up to **10,000 fuel**. A successful invocation refunds its unused reservation. A timeout, runtime failure, invalid result, worker failure, or rolled-back transaction receives no runtime refund.

Initial limits are:

- initial account allocation: 2,000,000 fuel, granted once;
- maximum invocation reservation: 10,000 fuel;
- maximum source size: 128 KiB;
- maximum HTTP request body: 1 MiB;
- maximum individual canonical state value: 256 KiB;
- maximum reducer state operations per transaction: 1,000.

Prices and limits are exposed by a read-only server metadata endpoint. Deployment-wide disk and concurrency limits remain operator configuration and are also reported by that endpoint.

## Permanent storage pricing

All newly retained logical bytes cost **8 fuel per UTF-8 byte**, regardless of whether they contain registered function code or reducer state.

- Registering new code charges the caller for every UTF-8 byte of the exact source. Registering identical content again is free because it creates no bytes.
- Creating either private or public reducer state charges the caller for the UTF-8 bytes of the key plus the stored JSON value. Public and private entries are charged independently.
- Replacing state repays the deleting caller for the old entry, then charges that caller for the new entry.
- Deleting reducer state always repays the deleting caller exactly the amount of fuel locked in the deleted entry. There are no ownership exceptions and the original payer is irrelevant.
- Repayment from deletions may fund writes in the same transaction. The transaction commits only if its net storage charge and runtime reservation can be covered.
- Failed or rolled-back transactions neither charge nor repay storage fuel.
- Storage charges and repayments are committed atomically with state changes.
- Immutable function code cannot be deleted and therefore its storage fuel is not repayable.

Each state entry stores only its serialized JSON value and locked-fuel amount; it does not store a fuel owner. State uses the server's standard JSON serialization, and `undefined`, non-finite numbers, and other non-JSON values are rejected. Database implementation overhead, indexes, reducer hashes, code hashes, and accounting metadata are not billable. Pricing remains straightforward: exact source bytes for code, and key plus stored-value bytes for state.

If a reducer permits a deletion, the caller performing that deletion always receives the reward. A reducer may use `ctx.caller` to decide whether deletion itself is permitted, but it cannot redirect or suppress the reward after deleting state.

## Reducers

Reducers run transactionally. They can read and write only their own state. State is strictly encapsulated per reducer.

Each reducer key has two completely distinct slots: `private` and `public`. A reducer chooses the slot on every state operation through `ctx.state.private` or `ctx.state.public`; both expose `get`, `has`, `set`, and `delete`. The same key may exist in both slots with unrelated values. Private slots can be read only by their reducer. Public slots remain writable only by their reducer but are publicly readable through `GET /state/:reducerHash/:key`.

A reducer receives `ctx` and `input`. Its frozen context exposes `ctx.caller`, deterministic `ctx.sha256` and `ctx.pageHash`, and its own `ctx.state` capabilities. Reducers cannot make fetch requests, inspect another reducer's state, open nested transactions, or change the attributed caller.

Multiple reducer calls made in one transaction commit atomically. An exception, timeout, failed fuel reservation, serialization error, or storage limit violation rolls back the complete transaction, including storage charges and repayments.

## Procedures

Procedures can make fetch requests. They can invoke a transaction as a lambda function, and inside that transaction they can call reducers.

A procedure receives `ctx` and `input`. Its frozen context exposes `ctx.caller`, `ctx.transaction`, and `ctx.fetch`. Fetch runs outside reducer state access. Reducers called by a procedure observe the same caller as the procedure invocation.

`ctx.fetch` accepts only public `http:` and `https:` destinations. Loopback, private, link-local, multicast, and cloud-metadata addresses are blocked after DNS resolution; every redirect is resolved and checked again. Fetch follows at most five redirects, returns at most 1 MiB, and remains subject to the invocation's fuel deadline. These restrictions prevent procedures from using the server as an SSRF path into its private network.

## Built-in static page reducer

The server always registers one well-known reducer whose immutable source accepts a string, computes a short content ID from the first 80 bits of `SHA-256(string)` encoded as 16 lowercase Base32 characters, stores the string in its public slot under that ID, and returns the ID. Before writing, it rejects the operation if that ID already contains different content, so a collision never overwrites a page. Its source and reducer hash are exposed by the normal code API; the reducer hash and size limit are also returned by `GET /page`.

A caller publishes a page by invoking this reducer with the complete HTML string. Normal invocation and storage fuel charges apply to publication. The initial maximum page size is 256 KiB.

Requests to `http(s)://<16-character-id>.<server-host>/` directly read that reducer's public slot. For local development this is `http://<id>.localhost:4000/`. These reads require no identity and consume no fuel, up to the page size limit. They never start a worker or transaction. A found value is returned as `text/html; charset=utf-8` with its ID as an immutable ETag and cache key. Other reducers and private slots cannot be reached through a page host. Because every ID is a different origin, pages do not share local storage, cookies, service workers, or DOM access by default.

## Public code and upgrades

Code is addressed by the SHA-256 digest of its exact source and is immutable. Anyone may inspect registered source by hash. State remains attached to the reducer hash and is not directly readable through the public code API.

Upgradeability must be implemented explicitly in immutable code—for example, by checking `ctx.caller` and selecting another pinned hash—so callers can inspect the authorization and upgrade rules before invocation.

## Initial limitations

- Bearer credentials can be stolen and must be treated as secrets.
- Unrestricted creation of credentials makes the fixed initial allocation vulnerable to Sybil farming.
- Wall-clock metering is simple but less deterministic than instruction metering.
- Worker isolation is a capability boundary, not an operating-system process sandbox.
- External fetch effects cannot be rolled back with a database transaction.

## Chosen initial defaults

The initial protocol deliberately favors simple, inspectable accounting: a one-time 2,000,000-fuel account allocation, one fuel per runtime millisecond, an invocation cap of 10,000 fuel, and permanent logical storage priced at 8 fuel per UTF-8 byte. Deletion rewards the deleting caller. Fetch is restricted to bounded responses from public HTTP(S) destinations.

These values are explicit server constants reported by metadata. Every state entry stores its original locked-fuel amount, making repayment a direct credit to the deleting caller without ownership bookkeeping.
