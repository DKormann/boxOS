import { copyBoxValue, parseBoxValue, stringifyBoxValue, type BoxValue } from "../core/values.ts"

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const RESERVED_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MILLISECONDS = 30_000

export type StructuredRequest = Readonly<{
  host: string
  path: string
  method: "GET" | "POST"
  headers: Readonly<Record<string, string>>
  body?: BoxValue
}>

function record(value: BoxValue, description: string): Record<string, BoxValue> {
  if (value === null || Array.isArray(value) || typeof value != "object") {
    throw new TypeError(`${description} must be an object`)
  }
  return value
}

/** Validate the deliberately small HTTPS API exposed as ctx.request. */
export function parseStructuredRequest(value: BoxValue): StructuredRequest {
  const input = record(value, "Request")
  const hostValue = input["host"]
  const pathValue = input["path"]
  const methodValue = input["method"]
  const headersValue = input["headers"]
  const allowedKeys = new Set(["host", "path", "method", "headers", "body"])
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown request field ${JSON.stringify(key)}`)
  }

  if (typeof hostValue != "string") throw new TypeError("Request host must be a DNS name")
  const host = hostValue.toLowerCase()
  if (host.length > 253 || host.endsWith(".")) throw new TypeError("Request host must be a DNS name")
  const labels = host.split(".")
  if (
    labels.length < 2
    || labels.some(label => !HOST_LABEL.test(label))
    || !/[a-z]/.test(labels[labels.length - 1]!)
  ) {
    throw new TypeError("Request host must be a public DNS name")
  }

  if (
    typeof pathValue != "string"
    || pathValue.length == 0
    || pathValue.length > 4_096
    || !pathValue.startsWith("/")
    || pathValue.startsWith("//")
    || pathValue.includes("#")
    || /[\u0000-\u001f\u007f]/.test(pathValue)
  ) throw new TypeError("Request path must be an absolute HTTP path")

  if (methodValue !== "GET" && methodValue !== "POST") {
    throw new TypeError("Request method must be GET or POST")
  }
  if (methodValue == "GET" && "body" in input) throw new TypeError("GET requests cannot have a body")

  const headers: Record<string, string> = Object.create(null)
  if (headersValue !== undefined) {
    const supplied = record(headersValue, "Request headers")
    const entries = Object.entries(supplied)
    if (entries.length > 32) throw new TypeError("Requests may contain at most 32 headers")
    for (const [name, value] of entries) {
      const normalized = name.toLowerCase()
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(normalized)) {
        throw new TypeError(`Request header ${JSON.stringify(name)} is not available`)
      }
      if (
        typeof value != "string"
        || value.length > 8_192
        || /[\u0000-\u001f\u007f]/.test(value)
      ) throw new TypeError(`Invalid value for request header ${JSON.stringify(name)}`)
      headers[normalized] = value
    }
  }

  const result: {
    host: string
    path: string
    method: "GET" | "POST"
    headers: Record<string, string>
    body?: BoxValue
  } = { host, path: pathValue, method: methodValue, headers }
  if ("body" in input) result.body = copyBoxValue(input["body"])
  const encodedBody = result.body === undefined ? "" : stringifyBoxValue(result.body)
  if (new TextEncoder().encode(encodedBody).length > MAX_REQUEST_BYTES) {
    throw new TypeError(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`)
  }
  return result
}

function publicIpv4(address: string): boolean {
  const parts = address.split(".")
  if (parts.length != 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false
  const octets = parts.map(Number)
  if (octets.some(octet => octet > 255)) return false
  const [a, b, c] = octets as [number, number, number, number]
  if (a == 0 || a == 10 || a == 127 || a >= 224) return false
  if (a == 100 && b >= 64 && b <= 127) return false
  if (a == 169 && b == 254) return false
  if (a == 172 && b >= 16 && b <= 31) return false
  if (a == 192 && (b == 0 || (b == 168) || (b == 88 && c == 99))) return false
  if (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) return false
  if (a == 203 && b == 0 && c == 113) return false
  return true
}

function ipv6Bytes(address: string): Uint8Array | null {
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return null
  function words(part: string): number[] | null {
    if (!part) return []
    const output: number[] = []
    for (const item of part.split(":")) {
      if (item.includes(".")) {
        const pieces = item.split(".").map(Number)
        if (pieces.length != 4 || pieces.some(piece => !Number.isInteger(piece) || piece < 0 || piece > 255)) return null
        output.push(pieces[0]! * 256 + pieces[1]!, pieces[2]! * 256 + pieces[3]!)
      } else {
        if (!/^[a-f0-9]{1,4}$/.test(item)) return null
        output.push(Number.parseInt(item, 16))
      }
    }
    return output
  }
  const left = words(halves[0]!)
  const right = words(halves[1] ?? "")
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if ((halves.length == 1 && missing != 0) || (halves.length == 2 && missing < 1)) return null
  const all = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (all.length != 8) return null
  const bytes = new Uint8Array(16)
  for (let index = 0; index < all.length; index++) {
    bytes[index * 2] = all[index]! >> 8
    bytes[index * 2 + 1] = all[index]! & 255
  }
  return bytes
}

/** True only for ordinary globally routable IPv4 and IPv6 destinations. */
export function isPublicNetworkAddress(address: string, family: number): boolean {
  if (family == 4) return publicIpv4(address)
  if (family != 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  const mapped = bytes.slice(0, 10).every(byte => byte == 0) && bytes[10] == 255 && bytes[11] == 255
  if (mapped) return publicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`)
  // Currently allocated global unicast space is 2000::/3. This excludes
  // loopback, link-local, unique-local, multicast, and documentation ranges.
  if ((bytes[0]! & 0xe0) != 0x20) return false
  if (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8) return false
  return true
}

type PinnedAddress = Readonly<{ address: string; family: 4 | 6 }>

async function resolvePublicAddress(host: string): Promise<PinnedAddress> {
  const [ipv4, ipv6] = await Promise.allSettled([
    Bun.dns.resolve(host, "A"),
    Bun.dns.resolve(host, "AAAA"),
  ])
  const answers: PinnedAddress[] = []
  if (ipv4.status == "fulfilled") {
    for (const answer of ipv4.value) answers.push({ address: answer.address, family: 4 })
  }
  if (ipv6.status == "fulfilled") {
    for (const answer of ipv6.value) answers.push({ address: answer.address, family: 6 })
  }
  if (!answers.length) throw new Error("Request host has no addresses")
  if (answers.some(answer => !isPublicNetworkAddress(answer.address, answer.family))) {
    throw new Error("Request host does not resolve exclusively to public addresses")
  }
  return answers[0]!
}

function responseBody(text: string): BoxValue {
  if (text.length == 0) return null
  try {
    return parseBoxValue(text)
  } catch {
    return copyBoxValue(text)
  }
}

async function send(request: StructuredRequest): Promise<{ status: number; contentType: string; body: BoxValue }> {
  const pinned = await resolvePublicAddress(request.host)
  const encodedBody = request.body === undefined ? undefined : stringifyBoxValue(request.body)
  const address = pinned.family == 6 ? `[${pinned.address}]` : pinned.address
  const headers: Record<string, string> = {
    accept: "application/json",
    ...request.headers,
    host: request.host,
  }
  if (encodedBody !== undefined) headers["content-type"] = "application/json"
  const options: RequestInit & { tls: { serverName: string } } = {
    method: request.method,
    headers,
    body: encodedBody,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    tls: { serverName: request.host },
  }
  const response = await fetch(`https://${address}${request.path}`, options)
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(`Response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`Response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return {
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").slice(0, 256),
    body: responseBody(new TextDecoder().decode(bytes)),
  }
}

/** Execute one public HTTPS request and always return a callback-safe value. */
export async function executeStructuredRequest(value: BoxValue, requestId: string): Promise<BoxValue> {
  try {
    const request = parseStructuredRequest(value)
    const response = await send(request)
    return {
      ok: response.status >= 200 && response.status < 300,
      requestId,
      status: response.status,
      contentType: response.contentType,
      body: response.body,
    }
  } catch (error) {
    return {
      ok: false,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
