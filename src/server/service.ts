import type { Database } from "bun:sqlite"
import {
  DEFAULT_FUEL_POLICY,
  touchAccount,
  type FuelPolicy,
} from "../accounts/accounts.ts"
import { sha256Hex, verifyEd25519 } from "../core/crypto.ts"
import { copyBoxValue, parseBoxValue, stringifyBoxValue, type BoxValue } from "../core/values.ts"
import { EffectDispatcher } from "../effects/dispatcher.ts"
import {
  parseClientOperation,
  publishBox as executePublishBox,
  publishPage,
  publishTextBlob,
  storeClientMessage,
  transferFuel,
} from "../operations/operations.ts"
import type { BoxScheduler, WorkerTurnResult } from "../workers/scheduler.ts"

export type BoxDefinition = { methods: Record<string, string> }

export type BoxPublicationRequest = {
  nonce: string
  definition: BoxValue
}

export type EventSubscriptionRequest = {
  nonce: string
  clientId: string
}

export type ClientOperationRequest = {
  nonce: string
  operation: BoxValue
}

export type InvocationRequest = {
  nonce: string
  boxId: string
  method: string
  input: BoxValue
  clientId: string | null
}

const METHOD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
const HASH = /^[a-f0-9]{64}$/

function checkedInvocationRequest(value: unknown): InvocationRequest {
  const copied = copyBoxValue(value)
  if (copied === null || Array.isArray(copied) || typeof copied != "object") {
    throw new TypeError("Invocation request must be an object")
  }
  const { nonce, boxId, method, input, clientId } = copied
  if (typeof nonce != "string" || nonce.length < 16 || nonce.length > 128) {
    throw new TypeError("Invocation nonce must contain 16 to 128 characters")
  }
  if (typeof boxId != "string" || !HASH.test(boxId)) throw new TypeError("Invalid box ID")
  if (typeof method != "string" || !METHOD_NAME.test(method)) throw new TypeError("Invalid method name")
  if (!("input" in copied)) throw new TypeError("Invocation input is required")
  if (clientId !== null && typeof clientId != "string") throw new TypeError("Invalid client ID")
  return { nonce, boxId, method, input: input!, clientId }
}

export function boxPublicationSigningMessage(request: BoxPublicationRequest): string {
  return `boxos.publish-box.v1\n${stringifyBoxValue(request)}`
}

export function eventSubscriptionSigningMessage(request: EventSubscriptionRequest): string {
  return `boxos.events.v1\n${stringifyBoxValue(request)}`
}

export function clientOperationSigningMessage(request: ClientOperationRequest): string {
  return `boxos.operation.v1\n${stringifyBoxValue(request)}`
}

export function invocationSigningMessage(request: InvocationRequest): string {
  return `boxos.invoke.v1\n${stringifyBoxValue(request)}`
}

export class BoxOSService {
  private readonly dispatcher: EffectDispatcher
  private draining = false

  constructor(
    private readonly database: Database,
    private readonly scheduler: BoxScheduler,
    private readonly fuelPolicy: FuelPolicy = DEFAULT_FUEL_POLICY,
  ) {
    this.dispatcher = new EffectDispatcher(database, scheduler)
  }

  async publishBoxForAccount(
    account: string,
    signature: string,
    requestValue: unknown,
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new TypeError("Invalid Ed25519 account public key")
    const copied = copyBoxValue(requestValue)
    if (copied === null || Array.isArray(copied) || typeof copied != "object") {
      throw new TypeError("Box publication request must be an object")
    }
    const nonce = copied["nonce"]
    const definition = copied["definition"]
    if (typeof nonce != "string" || nonce.length < 16 || nonce.length > 128 || definition === undefined) {
      throw new TypeError("Invalid box publication request")
    }
    const request: BoxPublicationRequest = { nonce, definition }
    if (!await verifyEd25519(account, signature, boxPublicationSigningMessage(request))) {
      throw new Error("Invalid box publication signature")
    }
    touchAccount(this.database, account, this.fuelPolicy)
    return this.publishBox(definition)
  }

  async publishBox(value: unknown): Promise<string> {
    return executePublishBox(this.database, value)
  }

  async authenticateEventSubscription(
    account: string,
    signature: string,
    requestValue: unknown,
  ): Promise<EventSubscriptionRequest> {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new TypeError("Invalid Ed25519 account public key")
    const copied = copyBoxValue(requestValue)
    if (copied === null || Array.isArray(copied) || typeof copied != "object") {
      throw new TypeError("Event subscription request must be an object")
    }
    const nonce = copied["nonce"]
    const clientId = copied["clientId"]
    if (typeof nonce != "string" || nonce.length < 16 || nonce.length > 128 || typeof clientId != "string") {
      throw new TypeError("Invalid event subscription request")
    }
    if (clientId != account) throw new Error("A page account may subscribe only to its own client ID")
    const request: EventSubscriptionRequest = { nonce, clientId }
    if (!await verifyEd25519(account, signature, eventSubscriptionSigningMessage(request))) {
      throw new Error("Invalid event subscription signature")
    }
    touchAccount(this.database, account, this.fuelPolicy)
    return request
  }

  async operate(account: string, signature: string, requestValue: unknown): Promise<BoxValue> {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new TypeError("Invalid Ed25519 account public key")
    const copied = copyBoxValue(requestValue)
    if (copied === null || Array.isArray(copied) || typeof copied != "object") {
      throw new TypeError("Client operation request must be an object")
    }
    const nonce = copied["nonce"]
    const operationValue = copied["operation"]
    if (typeof nonce != "string" || nonce.length < 16 || nonce.length > 128 || operationValue === undefined) {
      throw new TypeError("Invalid client operation request")
    }
    const request: ClientOperationRequest = { nonce, operation: operationValue }
    if (!await verifyEd25519(account, signature, clientOperationSigningMessage(request))) {
      throw new Error("Invalid operation signature")
    }
    touchAccount(this.database, account, this.fuelPolicy)
    const operation = parseClientOperation(operationValue)
    const operationId = await sha256Hex(
      `boxos.operation.id.v1\n${account}\n${stringifyBoxValue(request)}`,
    )
    const existing = this.database.query<{ result: string }>(
      "SELECT result FROM client_operations WHERE id = ?",
    ).get(operationId)
    if (existing) return parseBoxValue(existing.result)

    const save = (result: BoxValue): BoxValue => {
      this.database.query(
        "INSERT INTO client_operations (id, account, result, created_at) VALUES (?, ?, ?, ?)",
      ).run(operationId, account, stringifyBoxValue(result), Date.now())
      return result
    }

    if (operation.type == "transfer") {
      return this.database.transaction(() => {
        transferFuel(this.database, account, operation.receiver, operation.amount)
        return save({ id: operationId })
      })()
    }
    if (operation.type == "message") {
      storeClientMessage(this.database, operationId, account, operation.clientId, operation.message)
      return save({ id: operationId })
    }
    if (operation.type == "publishBlob") {
      return save({
        id: await publishTextBlob(this.database, operation.text, operation.contentType),
      })
    }
    return save({ id: await publishPage(this.database, operation.blobId) })
  }

  async invoke(account: string, signature: string, requestValue: unknown): Promise<WorkerTurnResult> {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new TypeError("Invalid Ed25519 account public key")
    const request = checkedInvocationRequest(requestValue)
    if (request.clientId != null && request.clientId != account) {
      throw new Error("A page account may invoke only with its own client ID")
    }
    if (!await verifyEd25519(account, signature, invocationSigningMessage(request))) {
      throw new Error("Invalid invocation signature")
    }
    touchAccount(this.database, account, this.fuelPolicy)
    const method = this.database.query<{ source: string }>(
      "SELECT source FROM box_methods WHERE box_id = ? AND name = ?",
    ).get(request.boxId, request.method)
    if (!method) throw new Error(`Unknown method ${request.boxId}.${request.method}`)

    const turnId = await sha256Hex(`boxos.invoke.turn.v1\n${account}\n${stringifyBoxValue(request)}`)
    const result = await this.scheduler.run({
      id: turnId,
      boxId: request.boxId,
      account,
      clientId: request.clientId,
      procedure: { kind: "method", source: method.source, input: request.input },
    })
    void this.drainEffects()
    return result
  }

  async drainEffects(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (await this.dispatcher.dispatchNext()) { /* drain durable outbox */ }
    } finally {
      this.draining = false
    }
  }
}
