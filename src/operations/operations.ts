import type { Database } from "bun:sqlite"
import { sha256Hex } from "../core/crypto.ts"
import { copyBoxValue, stringifyBoxValue, type BoxValue } from "../core/values.ts"
import { validateMethodCode } from "../language/parser.ts"

const PUBLIC_KEY = /^[a-f0-9]{64}$/

export async function publishBox(database: Database, value: unknown): Promise<string> {
  const copied = copyBoxValue(value)
  if (copied === null || Array.isArray(copied) || typeof copied != "object") {
    throw new TypeError("Box definition must be an object")
  }
  const methodsValue = copied["methods"]
  if (methodsValue === null || Array.isArray(methodsValue) || typeof methodsValue != "object") {
    throw new TypeError("Box methods must be an object")
  }

  const methods: Record<string, string> = Object.create(null)
  for (const [name, source] of Object.entries(methodsValue)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)) {
      throw new TypeError(`Invalid method name ${JSON.stringify(name)}`)
    }
    if (typeof source != "string") throw new TypeError(`Method ${name} source must be a string`)
    validateMethodCode(source)
    methods[name] = source
  }
  if (Object.keys(methods).length == 0) throw new TypeError("A box must define at least one method")

  const definition = stringifyBoxValue({ methods })
  const boxId = await sha256Hex(definition)
  database.transaction(() => {
    database.query(
      "INSERT OR IGNORE INTO boxes (id, definition, created_at) VALUES (?, ?, ?)",
    ).run(boxId, definition, Date.now())
    for (const [name, source] of Object.entries(methods)) {
      database.query(
        "INSERT OR IGNORE INTO box_methods (box_id, name, source) VALUES (?, ?, ?)",
      ).run(boxId, name, source)
    }
  })()
  return boxId
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

export function storeClientMessage(
  database: Database,
  id: string,
  sender: string,
  clientId: string,
  message: unknown,
): void {
  if (clientId.length == 0 || clientId.length > 256) throw new TypeError("Invalid client ID")
  database.query(
    `INSERT OR IGNORE INTO client_messages
      (id, sender_account, receiver_client_id, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sender, clientId, stringifyBoxValue(message), Date.now())
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
  throw new TypeError("Unknown operation type")
}
