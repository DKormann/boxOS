import type { Database } from "bun:sqlite"
import { validateBoxDefinition } from "../core/box-definition.ts"
import { sha256Hex } from "../core/crypto.ts"
import {
  copyBoxValue,
  stringifyBoxValue,
  validateBoxKey,
  type BoxValue,
} from "../core/values.ts"

const PUBLIC_KEY = /^[a-f0-9]{64}$/

export async function publishBox(database: Database, value: unknown): Promise<string> {
  const validated = validateBoxDefinition(value)
  const methods = validated.methods
  const definition = stringifyBoxValue(validated)
  const definitionId = await sha256Hex(definition)
  database.transaction(() => {
    database.query(
      "INSERT OR IGNORE INTO box_definitions (id, definition, created_at) VALUES (?, ?, ?)",
    ).run(definitionId, definition, Date.now())
    for (const [name, source] of Object.entries(methods)) {
      database.query(
        `INSERT OR IGNORE INTO box_definition_methods
          (definition_id, name, source) VALUES (?, ?, ?)`,
      ).run(definitionId, name, source)
    }
    // Backwards compatibility: publishing a definition also creates its
    // canonical singleton box whose ID is the historical definition hash.
    database.query(
      `INSERT OR IGNORE INTO boxes
        (id, definition_id, creator_account, nonce, created_at)
       VALUES (?, ?, NULL, NULL, ?)`,
    ).run(definitionId, definitionId, Date.now())
  })()
  return definitionId
}

type InitialState = Readonly<Record<string, BoxValue>>

export type BoxInstantiation = Readonly<{
  definitionId: string
  nonce: string
  initialPublic: InitialState
  initialPrivate: InitialState
}>

function initialState(value: unknown, description: string): InitialState {
  const copied = copyBoxValue(value ?? {})
  if (copied === null || Array.isArray(copied) || typeof copied != "object") {
    throw new TypeError(`${description} must be an object`)
  }
  for (const key of Object.keys(copied)) validateBoxKey(key, `${description} keys`)
  return copied
}

export function parseBoxInstantiation(value: unknown): BoxInstantiation {
  const copied = copyBoxValue(value)
  if (copied === null || Array.isArray(copied) || typeof copied != "object") {
    throw new TypeError("Box instantiation must be an object")
  }
  const definitionId = copied["definitionId"]
  const nonce = copied["nonce"]
  if (typeof definitionId != "string" || !/^[a-f0-9]{64}$/.test(definitionId)) {
    throw new TypeError("Invalid box definition ID")
  }
  if (typeof nonce != "string" || nonce.length < 16 || nonce.length > 128) {
    throw new TypeError("Box instance nonce must contain 16 to 128 characters")
  }
  return {
    definitionId,
    nonce,
    initialPublic: initialState(copied["initialPublic"], "Initial public storage"),
    initialPrivate: initialState(copied["initialPrivate"], "Initial private storage"),
  }
}

export async function instantiateBox(
  database: Database,
  creatorAccount: string,
  value: unknown,
): Promise<string> {
  if (!PUBLIC_KEY.test(creatorAccount)) throw new TypeError("Invalid creator account")
  const instance = parseBoxInstantiation(value)
  const id = await sha256Hex(`boxos.box-instance.v1\n${stringifyBoxValue({
    definitionId: instance.definitionId,
    creatorAccount,
    nonce: instance.nonce,
  })}`)

  database.transaction(() => {
    if (!database.query("SELECT 1 FROM box_definitions WHERE id = ?").get(instance.definitionId)) {
      throw new Error(`Unknown box definition ${instance.definitionId}`)
    }
    const existing = database.query("SELECT 1 FROM boxes WHERE id = ?").get(id)
    if (existing) return
    database.query(
      `INSERT INTO boxes (id, definition_id, creator_account, nonce, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, instance.definitionId, creatorAccount, instance.nonce, Date.now())
    const insert = database.query(
      "INSERT INTO box_state (box_id, visibility, key, value) VALUES (?, ?, ?, ?)",
    )
    for (const [key, stateValue] of Object.entries(instance.initialPublic)) {
      insert.run(id, "public", key, stringifyBoxValue(stateValue))
    }
    for (const [key, stateValue] of Object.entries(instance.initialPrivate)) {
      insert.run(id, "private", key, stringifyBoxValue(stateValue))
    }
  })()
  return id
}

export function publishAccount(database: Database, pubkey: string): string {
  if (!PUBLIC_KEY.test(pubkey)) throw new TypeError("Invalid account public key")
  database.query(
    "INSERT OR IGNORE INTO accounts (pubkey, fuel, last_top_up_at) VALUES (?, 0, 0)",
  ).run(pubkey)
  return pubkey
}

export function transferFuel(
  database: Database,
  sender: string,
  receiver: string,
  amount: number,
): void {
  if (!PUBLIC_KEY.test(receiver)) throw new TypeError("Invalid receiver public key")
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError("Fuel amount must be a positive integer")
  database.transaction(() => {
    const senderRow = database.query<{ fuel: number }>(
      "SELECT fuel FROM accounts WHERE pubkey = ?",
    ).get(sender)
    if (!senderRow || senderRow.fuel < amount) throw new Error("Insufficient fuel")
    database.query(
      "INSERT OR IGNORE INTO accounts (pubkey, fuel, last_top_up_at) VALUES (?, 0, 0)",
    ).run(receiver)
    database.query("UPDATE accounts SET fuel = fuel - ? WHERE pubkey = ?").run(amount, sender)
    database.query("UPDATE accounts SET fuel = fuel + ? WHERE pubkey = ?").run(amount, receiver)
  })()
}

export async function publishTextBlob(
  database: Database,
  text: string,
  contentType = "text/plain; charset=utf-8",
): Promise<string> {
  if (typeof text != "string") throw new TypeError("Blob text must be a string")
  if (
    typeof contentType != "string"
    || contentType.length == 0
    || contentType.length > 128
    || /[\r\n]/.test(contentType)
  ) throw new TypeError("Invalid blob content type")
  const bytes = new TextEncoder().encode(text)
  const id = await sha256Hex(text)
  const existing = database.query<{ content_type: string }>(
    "SELECT content_type FROM blobs WHERE id = ?",
  ).get(id)
  if (existing && existing.content_type != contentType) {
    throw new Error(`Blob ${id} is already published as ${existing.content_type}`)
  }
  database.query(
    "INSERT OR IGNORE INTO blobs (id, bytes, content_type) VALUES (?, ?, ?)",
  ).run(id, bytes, contentType)
  return id
}

export async function publishPage(database: Database, blobId: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(blobId)) throw new TypeError("Invalid blob ID")
  if (!database.query("SELECT 1 FROM blobs WHERE id = ?").get(blobId)) throw new Error("Unknown blob")
  const id = (await sha256Hex(`boxos.page.v1\n${blobId}`)).slice(0, 16)
  const existing = database.query<{ blob_id: string }>("SELECT blob_id FROM pages WHERE id = ?").get(id)
  if (existing && existing.blob_id != blobId) throw new Error("Page ID collision")
  database.query("INSERT OR IGNORE INTO pages (id, blob_id) VALUES (?, ?)").run(id, blobId)
  return id
}

export type ClientOperation =
  | { type: "transfer"; receiver: string; amount: number }
  | { type: "message"; clientId: string; message: BoxValue }
  | { type: "publishBlob"; text: string; contentType?: string }
  | { type: "publishPage"; blobId: string }
  | ({ type: "instantiateBox" } & BoxInstantiation)

export function parseClientOperation(value: unknown): ClientOperation {
  const operation = copyBoxValue(value)
  if (operation === null || Array.isArray(operation) || typeof operation != "object") {
    throw new TypeError("Operation must be an object")
  }
  const type = operation["type"]
  if (type == "transfer") {
    const receiver = operation["receiver"]
    const amount = operation["amount"]
    if (typeof receiver != "string" || typeof amount != "number") throw new TypeError("Invalid transfer")
    return { type, receiver, amount }
  }
  if (type == "message") {
    const clientId = operation["clientId"]
    if (typeof clientId != "string" || !("message" in operation)) throw new TypeError("Invalid message")
    return { type, clientId, message: operation["message"]! }
  }
  if (type == "publishBlob") {
    const text = operation["text"]
    const contentType = operation["contentType"]
    if (typeof text != "string" || (contentType !== undefined && typeof contentType != "string")) {
      throw new TypeError("Invalid blob publication")
    }
    return contentType === undefined ? { type, text } : { type, text, contentType }
  }
  if (type == "publishPage") {
    const blobId = operation["blobId"]
    if (typeof blobId != "string") throw new TypeError("Invalid page publication")
    return { type, blobId }
  }
  if (type == "instantiateBox") {
    return { type, ...parseBoxInstantiation(operation) }
  }
  throw new TypeError("Unknown operation type")
}
