const encoder = new TextEncoder()

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("boxos-client", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("keys")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function storedKeys() {
  const db = await database()
  const existing = await new Promise((resolve, reject) => {
    const request = db.transaction("keys").objectStore("keys").get("page-account")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  if (existing) return existing

  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const account = hex(await crypto.subtle.exportKey("raw", generated.publicKey))
  const privateBytes = await crypto.subtle.exportKey("pkcs8", generated.privateKey)
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateBytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  )
  const keys = { account, privateKey }
  await new Promise((resolve, reject) => {
    const request = db.transaction("keys", "readwrite").objectStore("keys").put(keys, "page-account")
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  return keys
}

async function envelope(purpose, request) {
  const keys = await storedKeys()
  const message = `${purpose}\n${JSON.stringify(canonical(request))}`
  const signature = hex(await crypto.subtle.sign(
    { name: "Ed25519" },
    keys.privateKey,
    encoder.encode(message),
  ))
  return { account: keys.account, signature, request }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `BoxOS request failed (${response.status})`)
  return result
}

async function operate(operation) {
  const request = { nonce: crypto.randomUUID(), operation }
  return post("/v1/operations", await envelope("boxos.operation.v1", request))
}

export const boxos = Object.freeze({
  async account() {
    return (await storedKeys()).account
  },
  async invoke(boxId, method, input = null) {
    const clientId = (await storedKeys()).account
    const request = { nonce: crypto.randomUUID(), boxId, method, input, clientId }
    return post("/v1/invoke", await envelope("boxos.invoke.v1", request))
  },
  async publishBox(definition) {
    const request = { nonce: crypto.randomUUID(), definition }
    return post("/v1/boxes", await envelope("boxos.publish-box.v1", request))
  },
  transfer(receiver, amount) {
    return operate({ type: "transfer", receiver, amount })
  },
  message(clientId, message) {
    return operate({ type: "message", clientId, message })
  },
  publishBlob(text, contentType) {
    return operate(contentType
      ? { type: "publishBlob", text, contentType }
      : { type: "publishBlob", text })
  },
  publishPage(blobId) {
    return operate({ type: "publishPage", blobId })
  },
  async events(onMessage, options = {}) {
    const clientId = (await storedKeys()).account
    const request = { nonce: crypto.randomUUID(), clientId }
    const response = await fetch("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(await envelope("boxos.events.v1", request)),
      signal: options.signal,
    })
    if (!response.ok) {
      const result = await response.json()
      throw new Error(result.error ?? `BoxOS event subscription failed (${response.status})`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        const data = event.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n")
        if (data) onMessage(JSON.parse(data))
      }
    }
  },
  async readPublic(boxId, key) {
    const response = await fetch(`/v1/boxes/${encodeURIComponent(boxId)}/storage/public?key=${encodeURIComponent(key)}`)
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `BoxOS request failed (${response.status})`)
    return result
  },
})
