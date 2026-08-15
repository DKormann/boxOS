import { AtomicCoordinator, isStateKey, isStateVisibility } from "./atomic.ts";
import { base32, contentIdentifier, decodeBase64Url, domainBytes, exactBuffer, sha256Domain, utf8 } from "./encoding.ts";
import { InvocationScope } from "./invocation-scope.ts";
import { subscribeToState, type SubscribableVisibility } from "./state-subscriptions.ts";
import { validateMethodCode } from "./parser.ts";
import { BOX_VALUE_LIMITS, type BoxValue, copyBoxValue, parseBoxValue, utf8Length } from "./values.ts";
import type { WorkerToHostMessage } from "./worker-protocol.ts";

const development = Bun.argv.includes("--dev");

// Keep production startup plain while making `--dev` the single opt-in for Bun's
// process-level hot reload. The marker prevents the hot child from spawning again.
if (development && Bun.env.BOXOS_HOT_CHILD !== "1") {
  console.log("BOXOS development mode: hot reload enabled");
  const child = Bun.spawn(["bun", "--hot", Bun.main, "--dev"], {
    env: { ...Bun.env, BOXOS_HOT_CHILD: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  Bun.exit(await child.exited);
}


const api = "/0.3.0";
const runtime = "boxos-js/0.3.0";
const initialAccountFuel = 1_000_000_000;
const stateSubscriptionFuel = 10_000;
const stateSubscriptionDurationMs = 60_000;
const stateSubscriptionEventLimit = 1_000;
type StateSubscription = {
  box: string;
  visibility: SubscribableVisibility;
  key: string;
  expires: number;
  active: boolean;
  entry?: string;
  close?: () => void;
};
const stateSubscriptions = new Map<string, StateSubscription>();
const configuredPublicUrl = new URL(Bun.env.BOXOS_PUBLIC_URL ?? "https://boxos.org");
if (configuredPublicUrl.pathname !== "/" || configuredPublicUrl.search || configuredPublicUrl.hash) {
  throw new Error("BOXOS_PUBLIC_URL must be an origin without a path, query, or fragment");
}
const database = new Bun.SQL(Bun.env.BOXOS_DB_URL ?? "sqlite://boxos.sqlite", {
  max: 1,
});

await database`
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
  )
`;
const oldBoxColumns = await database`PRAGMA table_info(boxes)`;
const hasLegacyBoxes = oldBoxColumns.some(column => column.name === "definition");
if (hasLegacyBoxes) {
  await database`DROP TABLE IF EXISTS boxes_legacy`;
  await database`ALTER TABLE boxes RENAME TO boxes_legacy`;
}
await database`
  CREATE TABLE IF NOT EXISTS boxes (
    id TEXT PRIMARY KEY,
    definition_blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id),
    runtime TEXT NOT NULL,
    instance TEXT NOT NULL
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS box_methods (
    box_id TEXT NOT NULL REFERENCES boxes(id),
    name TEXT NOT NULL,
    source_blob_id TEXT NOT NULL REFERENCES blobs(id),
    PRIMARY KEY (box_id, name)
  )
`;
await database`
  CREATE INDEX IF NOT EXISTS box_methods_source ON box_methods(source_blob_id)
`;
await database`
  CREATE TABLE IF NOT EXISTS box_state (
    box_id TEXT NOT NULL REFERENCES boxes(id),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (box_id, visibility, key)
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS box_shared_state (
    box_id TEXT NOT NULL REFERENCES boxes(id),
    key TEXT NOT NULL,
    entry_id TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    authority_public_key TEXT NOT NULL,
    PRIMARY KEY (box_id, key)
  )
`;
const sharedStateColumns = await database`PRAGMA table_info(box_shared_state)`;
if (!sharedStateColumns.some(column => column.name === "entry_id")) {
  await database`ALTER TABLE box_shared_state ADD COLUMN entry_id TEXT`;
  const rows = await database`SELECT box_id, key FROM box_shared_state`;
  for (const row of rows) {
    await database`UPDATE box_shared_state SET entry_id = ${`shared_${crypto.randomUUID()}`} WHERE box_id = ${row.box_id} AND key = ${row.key}`;
  }
}
await database`CREATE UNIQUE INDEX IF NOT EXISTS box_shared_state_entry ON box_shared_state(entry_id)`;
await database`
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id)
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS accounts (
    public_key TEXT PRIMARY KEY,
    fuel INTEGER NOT NULL,
    nonce INTEGER NOT NULL DEFAULT 0
  )
`;
if (hasLegacyBoxes) await migrateLegacyBoxes();

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function migrateLegacyBoxes(): Promise<void> {
  const rows = await database`SELECT id, definition FROM boxes_legacy`;
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.definition !== "string") continue;
    let transaction = false;
    try {
      const definition = JSON.parse(row.definition);
      if (!isRecord(definition) || definition.runtime !== runtime || typeof definition.instance !== "string" || !isRecord(definition.methods)) continue;
      const methods: { name: string; blob: string }[] = [];
      for (const [name, method] of Object.entries(definition.methods)) {
        if (!isRecord(method) || typeof method.blob !== "string") throw new Error("Invalid legacy method");
        const bytes = (await database`SELECT bytes FROM blobs WHERE id = ${method.blob}`)[0]?.bytes;
        if (!(bytes instanceof Uint8Array)) throw new Error("Missing legacy method blob");
        validateMethodCode(new TextDecoder("utf-8", { fatal: true }).decode(bytes), undefined, true);
        methods.push({ name, blob: method.blob });
      }
      const definitionBlob = await storeBlob(utf8(row.definition));
      await database`BEGIN`;
      transaction = true;
      await database`INSERT INTO boxes (id, definition_blob_id, runtime, instance) VALUES (${row.id}, ${definitionBlob}, ${definition.runtime}, ${definition.instance})`;
      for (const method of methods) {
        await database`INSERT INTO box_methods (box_id, name, source_blob_id) VALUES (${row.id}, ${method.name}, ${method.blob})`;
      }
      await database`COMMIT`;
      transaction = false;
    } catch (error) {
      if (transaction) await database`ROLLBACK`;
      console.warn(`Skipping invalid legacy box ${row.id}`, error);
    }
  }
  await database`DROP TABLE boxes_legacy`;
}

function validPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=").length === 32;
  } catch {
    return false;
  }
}

async function registerAccount(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !validPublicKey(value.publicKey)) {
    return problem(400, "invalid_public_key", "An account request must contain one Ed25519 publicKey");
  }
  const insertion = await database`
    INSERT INTO accounts (public_key, fuel) VALUES (${value.publicKey}, ${initialAccountFuel})
    ON CONFLICT DO NOTHING RETURNING public_key
  `;
  const row = (await database`SELECT fuel, nonce FROM accounts WHERE public_key = ${value.publicKey}`)[0];
  return json({ publicKey: value.publicKey, fuel: row?.fuel, nonce: row?.nonce, created: insertion.length === 1 }, insertion.length === 1 ? 201 : 200);
}

async function getAccount(publicKey: string): Promise<Response> {
  if (!validPublicKey(publicKey)) return problem(400, "invalid_public_key", "Invalid Ed25519 public key");
  const row = (await database`SELECT fuel, nonce FROM accounts WHERE public_key = ${publicKey}`)[0];
  if (!row) return problem(404, "account_not_found", "Account not found");
  return json({ publicKey, fuel: row.fuel, nonce: row.nonce });
}

async function storeBlob(bytes: Uint8Array): Promise<string> {
  const id = await contentIdentifier("blob", bytes);
  await database`INSERT OR IGNORE INTO blobs (id, bytes) VALUES (${id}, ${bytes})`;
  const stored = (await database`SELECT bytes FROM blobs WHERE id = ${id}`)[0]?.bytes;
  if (!(stored instanceof Uint8Array) || stored.length !== bytes.length || stored.some((byte, index) => byte !== bytes[index])) {
    throw new Error("Blob identifier collision");
  }
  return id;
}

async function createBlob(request: Request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const id = await storeBlob(bytes);
  return json({ id, bytes: bytes.length }, 201);
}

async function getBlob(id: string, head: boolean): Promise<Response> {
  const rows = await database`SELECT bytes FROM blobs WHERE id = ${id}`;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "blob_not_found", "Blob not found");
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(head ? null : body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function createBox(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }

  if (!isRecord(value) || Object.keys(value).some(key => !["runtime", "instance", "methods"].includes(key))) {
    return problem(400, "invalid_box", "A box may contain only runtime, instance, and methods");
  }
  if (value.runtime !== runtime) {
    return problem(400, "unsupported_runtime", `Runtime must be ${runtime}`);
  }
  if (typeof value.instance !== "string" || value.instance.length < 1 || value.instance.length > 128) {
    return problem(400, "invalid_instance", "Instance must be a non-empty string of at most 128 characters");
  }
  if (!isRecord(value.methods) || Object.keys(value.methods).length < 1 || Object.keys(value.methods).length > 128) {
    return problem(400, "invalid_methods", "Methods must contain between 1 and 128 entries");
  }

  const methods: { name: string; blob: string }[] = [];
  for (const [name, method] of Object.entries(value.methods)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !isRecord(method) || Object.keys(method).length !== 1 || typeof method.blob !== "string") {
      return problem(400, "invalid_method", `Invalid method: ${name}`);
    }
    const rows = await database`SELECT bytes FROM blobs WHERE id = ${method.blob}`;
    const bytes = rows[0]?.bytes;
    if (!(bytes instanceof Uint8Array)) return problem(400, "blob_not_found", `Method ${name} references a missing blob`);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateMethodCode(source, undefined, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid source";
      return problem(400, "invalid_method_source", `Method ${name}: ${message}`);
    }
    methods.push({ name, blob: method.blob });
  }

  // Property order is intentionally significant: BOXOS 0.3.0 uses plain JSON.stringify.
  const definitionBytes = utf8(JSON.stringify(value));
  const definitionBlob = await storeBlob(definitionBytes);
  const id = await contentIdentifier("box", definitionBytes);
  let transaction = false;
  try {
    await database`BEGIN`;
    transaction = true;
    const insertion = await database`
      INSERT INTO boxes (id, definition_blob_id, runtime, instance)
      VALUES (${id}, ${definitionBlob}, ${value.runtime}, ${value.instance})
      ON CONFLICT DO NOTHING RETURNING id
    `;
    const stored = (await database`SELECT definition_blob_id FROM boxes WHERE id = ${id}`)[0]?.definition_blob_id;
    if (stored !== definitionBlob) {
      await database`ROLLBACK`;
      transaction = false;
      return problem(409, "hash_collision", "Box identifier collision");
    }
    for (const method of methods) {
      await database`
        INSERT INTO box_methods (box_id, name, source_blob_id)
        VALUES (${id}, ${method.name}, ${method.blob})
        ON CONFLICT DO NOTHING
      `;
      const source = (await database`SELECT source_blob_id FROM box_methods WHERE box_id = ${id} AND name = ${method.name}`)[0]?.source_blob_id;
      if (source !== method.blob) throw new Error(`Stored method index mismatch: ${method.name}`);
    }
    await database`COMMIT`;
    transaction = false;
    return json({ id, definitionBlob, definition: value }, insertion.length === 1 ? 201 : 200);
  } catch (error) {
    if (transaction) await database`ROLLBACK`;
    throw error;
  }
}

async function getBox(id: string): Promise<Response> {
  const rows = await database`
    SELECT boxes.definition_blob_id, blobs.bytes
    FROM boxes JOIN blobs ON blobs.id = boxes.definition_blob_id
    WHERE boxes.id = ${id}
  `;
  const bytes = rows[0]?.bytes;
  const definitionBlob = rows[0]?.definition_blob_id;
  if (!(bytes instanceof Uint8Array) || typeof definitionBlob !== "string") return problem(404, "box_not_found", "Box not found");
  const definition = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return json({ id, definitionBlob, definition });
}

function decodeStateKey(encodedKey: string): string | Response {
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return problem(400, "invalid_state_key", "State key is not valid URL encoding");
  }
  if (utf8Length(key) > BOX_VALUE_LIMITS.keyBytes) {
    return problem(400, "invalid_state_key", `State keys may contain at most ${BOX_VALUE_LIMITS.keyBytes} UTF-8 bytes`);
  }
  return key;
}

async function getPublicState(box: string, encodedKey: string): Promise<Response> {
  const decoded = decodeStateKey(encodedKey);
  if (decoded instanceof Response) return decoded;
  const key = decoded;
  if (!(await database`SELECT 1 AS found FROM boxes WHERE id = ${box}`)[0]) {
    return problem(404, "box_not_found", "Box not found");
  }
  const row = (await database`
    SELECT value FROM box_state
    WHERE box_id = ${box} AND visibility = 'public' AND key = ${key}
  `)[0];
  return json(typeof row?.value === "string"
    ? { found: true, value: parseBoxValue(row.value) }
    : { found: false }, 200, { "cache-control": "no-store" });
}

async function getSharedStateMetadata(box: string, encodedKey: string): Promise<Response> {
  const decoded = decodeStateKey(encodedKey);
  if (decoded instanceof Response) return decoded;
  if (!(await database`SELECT 1 AS found FROM boxes WHERE id = ${box}`)[0]) {
    return problem(404, "box_not_found", "Box not found");
  }
  const row = (await database`
    SELECT entry_id, authority_public_key FROM box_shared_state WHERE box_id = ${box} AND key = ${decoded}
  `)[0];
  if (typeof row?.entry_id !== "string" || typeof row.authority_public_key !== "string") {
    return json({ found: false }, 200, { "cache-control": "no-store" });
  }
  return json({ found: true, entry: row.entry_id, authority: row.authority_public_key }, 200, { "cache-control": "no-store" });
}

async function readSharedState(request: Request): Promise<Response> {
  let envelope: unknown;
  try { envelope = JSON.parse(await request.text()); }
  catch { return problem(400, "invalid_json", "The request body must be valid JSON"); }
  if (!isRecord(envelope) || Object.keys(envelope).length !== 2 || !isRecord(envelope.command) || typeof envelope.signature !== "string") {
    return problem(400, "invalid_shared_read", "Shared read must contain command and signature");
  }
  const command = envelope.command;
  const commandFields = ["publicKey", "nonce", "box", "key", "authority", "grant", "grantSignature"];
  if (Object.keys(command).length !== commandFields.length || Object.keys(command).some(key => !commandFields.includes(key)) ||
      !validPublicKey(command.publicKey) || !Number.isSafeInteger(command.nonce) || (command.nonce as number) < 0 ||
      typeof command.box !== "string" || !/^box_[0-9a-f]{64}$/.test(command.box) ||
      typeof command.key !== "string" || utf8Length(command.key) > BOX_VALUE_LIMITS.keyBytes ||
      !validPublicKey(command.authority) || !isRecord(command.grant) || typeof command.grantSignature !== "string") {
    return problem(400, "invalid_shared_read", "Invalid shared read command");
  }
  const grant = command.grant;
  const grantFields = ["box", "key", "entry", "reader"];
  if (Object.keys(grant).length !== grantFields.length || Object.keys(grant).some(key => !grantFields.includes(key)) ||
      grant.box !== command.box || grant.key !== command.key || grant.reader !== command.publicKey ||
      typeof grant.entry !== "string" || !/^shared_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.entry)) {
    return problem(400, "invalid_shared_grant", "Invalid shared state grant");
  }
  if (!(await verifyDomainSignature(command.authority, "SHARED-READ", grant, command.grantSignature))) {
    return problem(401, "invalid_shared_grant", "Invalid shared state grant signature");
  }
  if (!(await verifyDomainSignature(command.publicKey, "SHARED-READ-COMMAND", command, envelope.signature))) {
    return problem(401, "invalid_signature", "Invalid shared read signature");
  }
  const row = (await database`
    SELECT entry_id, value, authority_public_key FROM box_shared_state WHERE box_id = ${command.box} AND key = ${command.key}
  `)[0];
  if (row?.entry_id !== grant.entry || row?.authority_public_key !== command.authority || typeof row?.value !== "string") {
    return problem(403, "shared_read_denied", "Shared state grant does not match the current entry");
  }
  const accepted = await database`
    UPDATE accounts SET nonce = nonce + 1
    WHERE public_key = ${command.publicKey} AND nonce = ${command.nonce}
    RETURNING nonce
  `;
  if (!accepted[0]) return problem(409, "account_rejected", "Account nonce is incorrect");
  return json({ box: command.box, key: command.key, entry: grant.entry, value: parseBoxValue(row.value), nonce: accepted[0].nonce }, 200, { "cache-control": "no-store" });
}

async function createStateSubscription(request: Request): Promise<Response> {
  let envelope: unknown;
  try { envelope = JSON.parse(await request.text()); }
  catch { return problem(400, "invalid_json", "The request body must be valid JSON"); }
  if (!isRecord(envelope) || Object.keys(envelope).length !== 2 || !isRecord(envelope.command) || typeof envelope.signature !== "string") {
    return problem(400, "invalid_subscription", "Subscription must contain command and signature");
  }
  const command = envelope.command;
  const commonFields = ["publicKey", "nonce", "box", "visibility", "key", "maxFuel"];
  const sharedFields = [...commonFields, "authority", "grant", "grantSignature"];
  const expectedFields = command.visibility === "shared" ? sharedFields : commonFields;
  if (Object.keys(command).length !== expectedFields.length || Object.keys(command).some(key => !expectedFields.includes(key)) ||
      !validPublicKey(command.publicKey) || !Number.isSafeInteger(command.nonce) || (command.nonce as number) < 0 ||
      typeof command.box !== "string" || !/^box_[0-9a-f]{64}$/.test(command.box) ||
      (command.visibility !== "public" && command.visibility !== "shared") ||
      typeof command.key !== "string" || utf8Length(command.key) > BOX_VALUE_LIMITS.keyBytes ||
      !Number.isSafeInteger(command.maxFuel) || (command.maxFuel as number) < stateSubscriptionFuel) {
    return problem(400, "invalid_subscription", "Invalid state subscription command");
  }
  if (!(await verifyDomainSignature(command.publicKey, "STATE-SUBSCRIBE", command, envelope.signature))) {
    return problem(401, "invalid_signature", "Invalid state subscription signature");
  }

  if (command.visibility === "public") {
    const found = (await database`
      SELECT 1 AS found FROM box_state WHERE box_id = ${command.box} AND visibility = 'public' AND key = ${command.key}
    `)[0];
    if (!found) return problem(404, "state_not_found", "Public state entry not found");
  } else {
    if (!validPublicKey(command.authority) || !isRecord(command.grant) || typeof command.grantSignature !== "string") {
      return problem(400, "invalid_shared_grant", "Invalid shared state grant");
    }
    const grant = command.grant;
    const grantFields = ["box", "key", "entry", "reader"];
    if (Object.keys(grant).length !== grantFields.length || Object.keys(grant).some(key => !grantFields.includes(key)) ||
        grant.box !== command.box || grant.key !== command.key || grant.reader !== command.publicKey ||
        typeof grant.entry !== "string" || !/^shared_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.entry) ||
        !(await verifyDomainSignature(command.authority, "SHARED-READ", grant, command.grantSignature))) {
      return problem(401, "invalid_shared_grant", "Invalid shared state grant");
    }
    const row = (await database`
      SELECT entry_id, authority_public_key FROM box_shared_state WHERE box_id = ${command.box} AND key = ${command.key}
    `)[0];
    if (row?.entry_id !== grant.entry || row?.authority_public_key !== command.authority) {
      return problem(403, "shared_read_denied", "Shared state grant does not match the current entry");
    }
  }

  const accepted = await database`
    UPDATE accounts SET nonce = nonce + 1, fuel = fuel - ${stateSubscriptionFuel}
    WHERE public_key = ${command.publicKey} AND nonce = ${command.nonce} AND fuel >= ${stateSubscriptionFuel}
    RETURNING nonce
  `;
  if (!accepted[0]) return problem(409, "account_rejected", "Account nonce or fuel is insufficient");

  const token = `subscription_${crypto.randomUUID()}`;
  const expires = Date.now() + stateSubscriptionDurationMs;
  const subscription: StateSubscription = {
    box: command.box,
    visibility: command.visibility,
    key: command.key,
    expires,
    active: false,
    entry: command.visibility === "shared" && isRecord(command.grant) && typeof command.grant.entry === "string"
      ? command.grant.entry : undefined,
  };
  stateSubscriptions.set(token, subscription);
  setTimeout(() => {
    stateSubscriptions.delete(token);
    subscription.close?.();
  }, stateSubscriptionDurationMs);
  return json({
    url: `${api}/state-subscriptions/${token}`,
    expires,
    receipt: { account: command.publicKey, spent: stateSubscriptionFuel, nonce: accepted[0].nonce },
  }, 201, { "cache-control": "no-store" });
}

async function openStateSubscription(token: string): Promise<Response> {
  const subscription = stateSubscriptions.get(token);
  if (!subscription || subscription.expires <= Date.now()) {
    stateSubscriptions.delete(token);
    return problem(410, "subscription_expired", "State subscription has expired");
  }
  if (subscription.active) return problem(409, "subscription_active", "State subscription is already connected");
  if (subscription.visibility === "shared") {
    const current = (await database`
      SELECT entry_id FROM box_shared_state WHERE box_id = ${subscription.box} AND key = ${subscription.key}
    `)[0];
    if (current?.entry_id !== subscription.entry) {
      stateSubscriptions.delete(token);
      return problem(410, "subscription_revoked", "Shared state entry was deleted");
    }
  }

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let events = 0;
      let closed = false;
      subscription.active = true;
      const send = (event: string, value: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      const unsubscribe = subscribeToState(subscription.box, subscription.visibility, subscription.key, write => {
        if (closed) return;
        events += 1;
        try {
          if (subscription.visibility === "shared" && write.operation === "delete") {
            stateSubscriptions.delete(token);
            send("reset", { reason: "entry_deleted" });
            cleanup();
            return;
          }
          if (events > stateSubscriptionEventLimit) {
            stateSubscriptions.delete(token);
            send("reset", { reason: "event_limit" });
            cleanup();
            return;
          }
          send("changed", {});
        } catch {
          cleanup();
        }
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
        catch { cleanup(); }
      }, 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        subscription.active = false;
        subscription.close = undefined;
        try { controller.close(); } catch { /* already disconnected */ }
      };
      subscription.close = cleanup;
      send("ready", { expires: subscription.expires });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

async function verifyDomainSignature(publicKey: string, domain: string, value: unknown, signature: string): Promise<boolean> {
  if (!validPublicKey(publicKey) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", exactBuffer(decodeBase64Url(publicKey)), { name: "Ed25519" }, false, ["verify"]);
    const message = domainBytes(domain, utf8(JSON.stringify(value)));
    return await crypto.subtle.verify("Ed25519", key, exactBuffer(decodeBase64Url(signature)), exactBuffer(message));
  } catch {
    return false;
  }
}

async function verifyInvocation(publicKey: string, command: Record<string, unknown>, signature: string): Promise<boolean> {
  return await verifyDomainSignature(publicKey, "INVOKE", command, signature);
}

const atomicCoordinator = new AtomicCoordinator(database);

const rpcEncoder = new TextEncoder();

function settleWorkerRpc(controlBuffer: SharedArrayBuffer, dataBuffer: SharedArrayBuffer, value: unknown, failed = false): void {
  const control = new Int32Array(controlBuffer);
  const data = new Uint8Array(dataBuffer);
  let encoded = rpcEncoder.encode(JSON.stringify(value));
  if (encoded.length > data.length) {
    encoded = rpcEncoder.encode(JSON.stringify({ error: "Atomic RPC response exceeds its limit" }));
    failed = true;
  }
  data.fill(0, 0, Math.min(data.length, Atomics.load(control, 1)));
  data.set(encoded);
  Atomics.store(control, 1, encoded.length);
  Atomics.store(control, 0, failed ? -1 : 1);
  Atomics.notify(control, 0);
}

type ExecutionResult = { ok: true; result: BoxValue } | { ok: false; error: string; timeout?: boolean };
type InvocationContext = {
  rootCaller: string;
  box: string;
  method: string;
  immediateCaller: { box: string; method: string } | null;
  lineage: string[];
};

async function methodSource(box: string, method: string): Promise<string | null> {
  const bytes = (await database`
    SELECT blobs.bytes FROM box_methods JOIN blobs ON blobs.id = box_methods.source_blob_id
    WHERE box_methods.box_id = ${box} AND box_methods.name = ${method}
  `)[0]?.bytes;
  return bytes instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
}

function effectError(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : "Effect failed" };
}

async function externalRequest(args: Record<string, unknown>, invocationSignal: AbortSignal): Promise<BoxValue> {
  if (typeof args.url !== "string" || args.url.length > 2048) throw new TypeError("Request URL must be a string of at most 2048 characters");
  const url = new URL(args.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Requests require an HTTP or HTTPS URL");
  const options = args.options;
  if (options !== null && !isRecord(options)) throw new TypeError("Request options must be an object or null");
  const allowed = ["method", "headers", "body"];
  if (isRecord(options) && Object.keys(options).some(key => !allowed.includes(key))) throw new TypeError("Unsupported request option");
  const method = isRecord(options) && options.method !== undefined ? options.method : "GET";
  if (typeof method !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new TypeError("Unsupported request method");
  const headers = new Headers();
  if (isRecord(options) && options.headers !== undefined) {
    if (!isRecord(options.headers)) throw new TypeError("Request headers must be an object");
    for (const [name, value] of Object.entries(options.headers)) {
      if (typeof value !== "string" || name.toLowerCase() === "host" || name.toLowerCase() === "content-length") throw new TypeError("Invalid request header");
      headers.set(name, value);
    }
  }
  const body = isRecord(options) && options.body !== undefined ? options.body : undefined;
  if (body !== undefined && typeof body !== "string") throw new TypeError("Request body must be a string");
  if (typeof body === "string" && utf8Length(body) > 256 * 1024) throw new TypeError("Request body is too large");
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(invocationSignal.reason);
  invocationSignal.addEventListener("abort", abortRequest, { once: true });
  const requestTimer = setTimeout(() => requestController.abort(new Error("Request deadline exceeded")), 750);
  let response: Response;
  let responseBody: string;
  try {
    response = await fetch(url, { method, headers, body, redirect: "error", signal: requestController.signal });
    responseBody = await response.text();
  } finally {
    clearTimeout(requestTimer);
    invocationSignal.removeEventListener("abort", abortRequest);
  }
  if (utf8Length(responseBody) > 256 * 1024) throw new TypeError("Response body is too large");
  const responseHeaders: Record<string, string> = Object.create(null);
  response.headers.forEach((value, name) => { responseHeaders[name] = value; });
  return copyBoxValue({ status: response.status, ok: response.ok, headers: responseHeaders, body: responseBody });
}

async function executeMethod(
  box: string,
  method: string,
  source: string,
  input: BoxValue,
  context: InvocationContext,
  parentSignal?: AbortSignal,
): Promise<ExecutionResult> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const dataBuffer = new SharedArrayBuffer(BOX_VALUE_LIMITS.encodedBytes + 1024);
  const scope = new InvocationScope(parentSignal);

  return await new Promise<ExecutionResult>(resolve => {
    let settled = false;
    const finish = async (result: ExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scope.cancel(new Error(!result.ok && result.timeout ? "Invocation deadline exceeded" : "Invocation settled"));
      worker.terminate();
      await scope.settle();
      scope.signal.removeEventListener("abort", cancelFromScope);
      resolve(result);
    };
    const timer = setTimeout(() => { void finish({ ok: false, error: "Method deadline exceeded", timeout: true }); }, 1_000);
    const cancelFromScope = () => { void finish({ ok: false, error: "Parent invocation cancelled", timeout: true }); };
    if (scope.signal.aborted) cancelFromScope();
    else scope.signal.addEventListener("abort", cancelFromScope, { once: true });

    worker.onmessage = event => {
      const message = event.data as WorkerToHostMessage;
      if (message?.type === "state.begin") {
        if (scope.atomic !== null) {
          settleWorkerRpc(controlBuffer, dataBuffer, { error: "Atomic session is already active" }, true);
        } else {
          const session = atomicCoordinator.createSession(box);
          scope.setAtomic(session);
          const operation = session.acquire().then(
            () => settleWorkerRpc(controlBuffer, dataBuffer, { acquired: true }),
            () => {
              scope.setAtomic(null);
              settleWorkerRpc(controlBuffer, dataBuffer, { error: "Could not acquire atomic lock" }, true);
            },
          );
          scope.setPendingRpc(operation);
        }
      } else if (message?.type === "state.read") {
        const session = scope.atomic;
        if (session === null || !isStateVisibility(message.visibility) || !isStateKey(message.key)) {
          settleWorkerRpc(controlBuffer, dataBuffer, { error: "Invalid atomic state read" }, true);
        } else {
          const operation = session.read(message.visibility, message.key).then(
            value => settleWorkerRpc(controlBuffer, dataBuffer, value),
            () => settleWorkerRpc(controlBuffer, dataBuffer, { error: "Atomic state read failed" }, true),
          );
          scope.setPendingRpc(operation);
        }
      } else if (message?.type === "state.commit") {
        const session = scope.atomic;
        if (session === null) {
          settleWorkerRpc(controlBuffer, dataBuffer, { error: "No atomic session is active" }, true);
        } else {
          const operation = session.commit(message.writes).then(
            () => {
              scope.setAtomic(null);
              settleWorkerRpc(controlBuffer, dataBuffer, { committed: true });
            },
            () => {
              scope.setAtomic(null);
              settleWorkerRpc(controlBuffer, dataBuffer, { error: "Atomic state commit failed" }, true);
            },
          );
          scope.setPendingRpc(operation);
        }
      } else if (message?.type === "state.abort") {
        const session = scope.atomic;
        if (session === null) {
          settleWorkerRpc(controlBuffer, dataBuffer, { error: "No atomic session is active" }, true);
        } else {
          session.abort();
          scope.setAtomic(null);
          settleWorkerRpc(controlBuffer, dataBuffer, { aborted: true });
        }
      } else if (message?.type === "effect" && Number.isSafeInteger(message.id) && typeof message.effect === "string" && isRecord(message.args)) {
        const args = message.args;
        const reply = (ok: boolean, value: unknown) => {
          if (!settled) worker.postMessage(ok
            ? { type: "effect.result", id: message.id, ok: true, value: copyBoxValue(value) }
            : { type: "effect.result", id: message.id, ok: false, error: effectError(value) });
        };
        const hostEffect = scope.trackEffect((async () => {
          if (scope.signal.aborted) throw new Error("Invocation cancelled");
          if (message.effect === "request") return await externalRequest(args, scope.signal);
          if (message.effect === "verify") {
            const publicKey = args.publicKey;
            const signature = args.signature;
            if (!validPublicKey(publicKey) || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
            try {
              const key = await crypto.subtle.importKey("raw", exactBuffer(decodeBase64Url(publicKey)), { name: "Ed25519" }, false, ["verify"]);
              const body = utf8(JSON.stringify(copyBoxValue(args.message)));
              return await crypto.subtle.verify("Ed25519", key, exactBuffer(decodeBase64Url(signature)), exactBuffer(domainBytes("MESSAGE", body)));
            } catch { return false; }
          }
          if (message.effect === "hostPage") {
            if (typeof args.blob !== "string") throw new TypeError("ctx.hostPage requires a blob ID");
            const page = await hostPage(args.blob);
            if (page instanceof Response) {
              const value = await page.json();
              throw new Error(value?.error?.message ?? "Page hosting failed");
            }
            return copyBoxValue(page);
          }
          if (message.effect === "call") {
            const target = args.box;
            const targetMethod = args.method;
            if (typeof target !== "string" || typeof targetMethod !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(targetMethod)) {
              throw new TypeError("Invalid cross-box call target");
            }
            if (context.lineage.length >= 16) throw new Error("Cross-box call depth exceeded");
            const childSource = await methodSource(target, targetMethod);
            if (childSource === null) throw new Error("Target box method not found");
            const childContext: InvocationContext = {
              rootCaller: context.rootCaller,
              box: target,
              method: targetMethod,
              immediateCaller: { box, method },
              lineage: [...context.lineage, target],
            };
            const child = await executeMethod(target, targetMethod, childSource, copyBoxValue(args.input), childContext, scope.signal);
            if (!child.ok) throw new Error(child.error);
            return child.result;
          }
          throw new Error("Unknown BOXOS effect");
        })());
        void hostEffect.then(value => reply(true, value), error => reply(false, error));
      } else if (message?.type === "result") {
        if (message.ok) {
          try {
            void finish({ ok: true, result: copyBoxValue(message.result) });
          } catch (error) {
            void finish({ ok: false, error: error instanceof Error ? error.message : "Invalid method result" });
          }
        } else {
          void finish({ ok: false, error: typeof message.error === "string" ? message.error : "Method failed" });
        }
      }
    };
    worker.onerror = () => { void finish({ ok: false, error: "Method worker failed" }); };
    worker.postMessage({
      source,
      input,
      context: { rootCaller: context.rootCaller, box: context.box, method: context.method, immediateCaller: context.immediateCaller },
      controlBuffer,
      dataBuffer,
    });
  });
}

async function invokeBox(request: Request): Promise<Response> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }
  if (!isRecord(envelope) || Object.keys(envelope).length !== 2 || !isRecord(envelope.command) || typeof envelope.signature !== "string") {
    return problem(400, "invalid_invocation", "Invocation must contain command and signature");
  }
  const command = envelope.command;
  const fields = ["publicKey", "nonce", "box", "method", "maxFuel", "input"];
  if (Object.keys(command).length !== fields.length || Object.keys(command).some(key => !fields.includes(key)) ||
      !validPublicKey(command.publicKey) || !Number.isSafeInteger(command.nonce) || (command.nonce as number) < 0 ||
      typeof command.box !== "string" || typeof command.method !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(command.method) ||
      !Number.isSafeInteger(command.maxFuel) || (command.maxFuel as number) < 1 || (command.maxFuel as number) > initialAccountFuel) {
    return problem(400, "invalid_invocation", "Invalid invocation command");
  }
  let input: BoxValue;
  try {
    input = copyBoxValue(command.input);
  } catch (error) {
    return problem(400, "invalid_input", error instanceof Error ? error.message : "Invalid input");
  }
  if (!(await verifyInvocation(command.publicKey, command, envelope.signature))) {
    return problem(401, "invalid_signature", "Invalid invocation signature");
  }

  const methodRows = await database`
    SELECT blobs.bytes
    FROM box_methods JOIN blobs ON blobs.id = box_methods.source_blob_id
    WHERE box_methods.box_id = ${command.box} AND box_methods.name = ${command.method}
  `;
  const sourceBytes = methodRows[0]?.bytes;
  if (!(sourceBytes instanceof Uint8Array)) return problem(404, "method_not_found", "Box method not found");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);

  const reservation = await database`
    UPDATE accounts
    SET fuel = fuel - ${command.maxFuel}, nonce = nonce + 1
    WHERE public_key = ${command.publicKey} AND nonce = ${command.nonce} AND fuel >= ${command.maxFuel}
    RETURNING nonce
  `;
  if (!reservation[0]) return problem(409, "account_rejected", "Account nonce or fuel is insufficient");

  const invocation = crypto.randomUUID();
  let spent = command.maxFuel as number;
  let execution: ExecutionResult;
  try {
    const context: InvocationContext = { rootCaller: command.publicKey, box: command.box, method: command.method, immediateCaller: null, lineage: [command.box] };
    execution = await executeMethod(command.box as string, command.method as string, source, input, context);
    spent = execution.ok ? Math.min(command.maxFuel as number, 10_000 + sourceBytes.length) : execution.timeout ? command.maxFuel as number : Math.min(command.maxFuel as number, 20_000 + sourceBytes.length);
  } catch (error) {
    execution = { ok: false, error: error instanceof Error ? error.message : "Invocation failed" };
    spent = Math.min(command.maxFuel as number, 20_000 + sourceBytes.length);
  }
  const refunded = (command.maxFuel as number) - spent;
  if (refunded > 0) await database`UPDATE accounts SET fuel = fuel + ${refunded} WHERE public_key = ${command.publicKey}`;
  const receipt = { invocation, account: command.publicKey, reserved: command.maxFuel, spent, refunded, nonce: reservation[0].nonce };
  if (execution.ok) return json({ result: execution.result, receipt });
  return json({ error: { code: execution.timeout ? "method_timeout" : "method_failed", message: execution.error }, receipt }, execution.timeout ? 408 : 422);
}

async function hostPage(blobId: string): Promise<{ id: string; blob: string; origin: string; fuel: number; created: boolean } | Response> {
  const rows = await database`SELECT bytes FROM blobs WHERE id = ${blobId}`;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "blob_not_found", "Blob not found");
  if (bytes.length === 0) return problem(400, "invalid_page", "A hosted page cannot be empty");

  // The first 20 digest bytes encode to exactly 32 lowercase base32 characters.
  const id = base32((await sha256Domain("PAGE", bytes)).slice(0, 20));
  const insertion = await database`
    INSERT INTO pages (id, blob_id) VALUES (${id}, ${blobId})
    ON CONFLICT DO NOTHING RETURNING id
  `;
  const stored = (await database`SELECT blob_id FROM pages WHERE id = ${id}`)[0]?.blob_id;
  if (stored !== blobId) {
    return problem(409, "page_id_collision", "The shortened page identifier is already in use");
  }

  const created = insertion.length === 1;
  return {
    id,
    blob: blobId,
    origin: pageUrlAtOrigin(configuredPublicUrl, id),
    fuel: created ? 100_000 + bytes.length * 100 : 1_000,
    created,
  };
}

async function createPage(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.blob !== "string") {
    return problem(400, "invalid_page", "A page request must contain one blob field");
  }
  const result = await hostPage(value.blob);
  return result instanceof Response ? result : json(result, result.created ? 201 : 200);
}

async function servePage(id: string, head: boolean): Promise<Response> {
  const rows = await database`
    SELECT blobs.bytes AS bytes
    FROM pages JOIN blobs ON blobs.id = pages.blob_id
    WHERE pages.id = ${id}
  `;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "page_not_found", "Hosted page not found");
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(head ? null : body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

function hostedPageId(request: Request): string | undefined {
  const hostname = requestAddress(request).hostname;
  return /^([a-z2-7]{32})\./.exec(hostname)?.[1];
}

type PublishedExample = { name: string; pageId: string; url: string; box: string | null };

function examplePath(value: unknown, extension: string, description: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(value) ||
      !value.endsWith(extension) || value.includes("..")) {
    throw new Error(`Invalid example ${description}: ${JSON.stringify(value)}`);
  }
  return `examples/${value}`;
}

async function publishExampleBox(name: string, manifest: unknown): Promise<string | null> {
  if (manifest === undefined) return null;
  if (!isRecord(manifest) || manifest.runtime !== runtime || typeof manifest.instance !== "string" || !isRecord(manifest.methods)) {
    throw new Error(`Invalid box definition for example: ${name}`);
  }

  const methods: Record<string, { blob: string }> = Object.create(null);
  for (const [methodName, method] of Object.entries(manifest.methods)) {
    if (!isRecord(method) || Object.keys(method).length !== 1) {
      throw new Error(`Invalid example method: ${name}.${methodName}`);
    }
    const path = examplePath(method.source, ".js", `method source for ${name}.${methodName}`);
    const sourceFile = Bun.file(path);
    if (!(await sourceFile.exists())) throw new Error(`Missing example method source: ${path}`);
    methods[methodName] = { blob: await storeBlob(new Uint8Array(await sourceFile.arrayBuffer())) };
  }

  const definition = { runtime: manifest.runtime, instance: manifest.instance, methods };
  const response = await createBox(new Request("http://boxos.internal/0.3.0/boxes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition),
  }));
  const result = await response.json();
  if (!response.ok || typeof result.id !== "string") throw new Error(`Could not publish example box: ${name}`);
  return result.id;
}

async function publishExamples(): Promise<PublishedExample[]> {
  const manifestFile = Bun.file("examples/manifest.json");
  if (!(await manifestFile.exists())) throw new Error("Missing examples/manifest.json");
  const manifest: unknown = JSON.parse(await manifestFile.text());
  if (!isRecord(manifest)) throw new Error("Example manifest must be an object");

  const published: PublishedExample[] = [];
  for (const [name, entry] of Object.entries(manifest)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !isRecord(entry) ||
        Object.keys(entry).some(key => key !== "page" && key !== "box")) {
      throw new Error(`Invalid example manifest entry: ${name}`);
    }
    const pagePath = examplePath(entry.page, ".html", `page for ${name}`);
    const pageFile = Bun.file(pagePath);
    if (!(await pageFile.exists())) throw new Error(`Missing example page: ${pagePath}`);
    const blob = await storeBlob(new Uint8Array(await pageFile.arrayBuffer()));
    const page = await hostPage(blob);
    if (page instanceof Response) throw new Error(`Could not publish example page: ${name}`);
    published.push({ name, pageId: page.id, url: page.origin, box: await publishExampleBox(name, entry.box) });
  }
  return published;
}

function requestAddress(request: Request): URL {
  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? `${forwardedProtocol}:` : requestUrl.protocol;
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  return new URL(`${protocol}//${host}`);
}

function deploymentRoot(request: Request): URL {
  const address = requestAddress(request);
  const pagePrefix = /^[a-z2-7]{32}\.(.+)$/.exec(address.hostname);
  if (pagePrefix) address.hostname = pagePrefix[1]!;
  return address;
}

function pageUrlAtOrigin(root: URL, pageId: string): string {
  const page = new URL(root.origin);
  page.hostname = `${pageId}.${page.hostname}`;
  return page.origin;
}

function localRequest(request: Request): boolean {
  return deploymentRoot(request).hostname === "localhost";
}

function boxosRoot(request: Request): string {
  return `${deploymentRoot(request).origin}/`;
}

function exampleUrl(request: Request, example: PublishedExample): string {
  return pageUrlAtOrigin(deploymentRoot(request), example.pageId);
}

function listExamples(request: Request): Response {
  const root = deploymentRoot(request);
  const local = root.hostname === "localhost";
  return json({
    examples: publishedExamples.map(example => ({
      name: example.name,
      url: example.url,
      currentUrl: pageUrlAtOrigin(root, example.pageId),
      localUrl: local ? pageUrlAtOrigin(root, example.pageId) : null,
      box: example.box,
    })),
  });
}

const publishedExamples = await publishExamples();
const aboutExample = publishedExamples.find(example => example.name === "about");
if (!aboutExample) throw new Error("Example manifest must define the about page");
const stylesheetBytes = new Uint8Array(await Bun.file("examples/boxos.css").arrayBuffer());
const stylesheetBlob = await storeBlob(stylesheetBytes);

function staticFile(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development,
  maxRequestBodySize: 10 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const pageId = hostedPageId(request);

    if (pageId && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return await servePage(pageId, request.method === "HEAD");
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      const response = await servePage(aboutExample.pageId, request.method === "HEAD");
      response.headers.set("cache-control", "no-cache");
      response.headers.set("content-security-policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.headers.set("referrer-policy", "no-referrer");
      return response;
    }
    if (request.method === "GET" && url.pathname === "/client.js") {
      return staticFile("public/client.js", "text/javascript; charset=utf-8");
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/boxos-cli.js") {
      return new Response(request.method === "HEAD" ? null : Bun.file("bin/boxos"), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/AGENTS.md") {
      return new Response(request.method === "HEAD" ? null : Bun.file("AGENTS.md"), {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/boxos.css") {
      const response = await getBlob(stylesheetBlob, request.method === "HEAD");
      response.headers.set("content-type", "text/css; charset=utf-8");
      return response;
    }
    try {
      if (request.method === "POST" && url.pathname === `${api}/accounts`) return await registerAccount(request);
      if (request.method === "GET" && url.pathname.startsWith(`${api}/accounts/`)) {
        return await getAccount(decodeURIComponent(url.pathname.slice(`${api}/accounts/`.length)));
      }
      if (request.method === "POST" && url.pathname === `${api}/blobs`) return await createBlob(request);
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith(`${api}/blobs/`)) {
        return await getBlob(url.pathname.slice(`${api}/blobs/`.length), request.method === "HEAD");
      }
      if (request.method === "POST" && url.pathname === `${api}/boxes`) return await createBox(request);
      if (request.method === "POST" && url.pathname === `${api}/invocations`) return await invokeBox(request);
      if (request.method === "POST" && url.pathname === `${api}/shared-state/read`) return await readSharedState(request);
      if (request.method === "POST" && url.pathname === `${api}/state-subscriptions`) return await createStateSubscription(request);
      const stateSubscription = /^\/0\.3\.0\/state-subscriptions\/(subscription_[0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && stateSubscription) return await openStateSubscription(stateSubscription[1]!);
      const publicState = /^\/0\.3\.0\/boxes\/(box_[0-9a-f]{64})\/state\/public\/(.*)$/.exec(url.pathname);
      if (request.method === "GET" && publicState) return await getPublicState(publicState[1]!, publicState[2]!);
      const sharedState = /^\/0\.3\.0\/boxes\/(box_[0-9a-f]{64})\/state\/shared\/(.*)$/.exec(url.pathname);
      if (request.method === "GET" && sharedState) return await getSharedStateMetadata(sharedState[1]!, sharedState[2]!);
      if (request.method === "GET" && url.pathname.startsWith(`${api}/boxes/`)) {
        return await getBox(url.pathname.slice(`${api}/boxes/`.length));
      }
      if (request.method === "POST" && url.pathname === `${api}/pages`) return await createPage(request);
      if (request.method === "GET" && url.pathname === `${api}/examples`) return listExamples(request);
      if (request.method === "GET" && url.pathname === "/about") return Response.redirect(boxosRoot(request), 302);
      if (request.method === "GET" && url.pathname.startsWith("/examples/")) {
        const name = decodeURIComponent(url.pathname.slice("/examples/".length));
        const example = publishedExamples.find(item => item.name === name);
        if (!example) return problem(404, "example_not_found", "Example not found");
        return Response.redirect(exampleUrl(request, example), 302);
      }
    } catch (error) {
      console.error(error);
      return problem(500, "internal_error", "The server could not complete the request");
    }

    return problem(404, "not_found", "Route not found");
  },
});

console.log(`BOXOS 0.3.0 listening on ${server.url}${development ? " (development)" : ""}`);
for (const example of publishedExamples) {
  console.log(`Example ${example.name}: ${example.url}`);
  console.log(`Example ${example.name} (local): http://${example.pageId}.localhost:${server.url.port}`);
}
