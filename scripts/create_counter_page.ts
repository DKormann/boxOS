import { bytesToHex } from "../src/core/crypto.ts"
import {
  boxPublicationSigningMessage,
  clientOperationSigningMessage,
  type BoxPublicationRequest,
  type ClientOperationRequest,
} from "../src/server/service.ts"

type SigningIdentity = {
  account: string
  privateKey: CryptoKey
}

async function identity(): Promise<SigningIdentity> {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
  return {
    account: bytesToHex(await crypto.subtle.exportKey("raw", keys.publicKey)),
    privateKey: keys.privateKey,
  }
}

async function signature(privateKey: CryptoKey, message: string): Promise<string> {
  return bytesToHex(await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(message),
  ))
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(String(result["error"] ?? `HTTP ${response.status}`))
  return result
}

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3000/").href
const signer = await identity()

const boxRequest: BoxPublicationRequest = {
  nonce: crypto.randomUUID(),
  definition: {
    methods: {
      increment: `
        let count = ctx.storage.public.get("count") || 0;
        count = count + 1;
        ctx.storage.public.set("count", count);
        return count;
      `,
    },
  },
}
const box = await post(baseUrl, "/v1/boxes", {
  account: signer.account,
  signature: await signature(signer.privateKey, boxPublicationSigningMessage(boxRequest)),
  request: boxRequest,
})
const boxId = String(box["id"])

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BoxOS Counter</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #171923; }
    main { width: min(28rem, calc(100% - 3rem)); padding: 3rem; text-align: center; color: #f7fafc;
      background: #252a3a; border: 1px solid #414862; border-radius: 1.25rem; box-shadow: 0 1rem 3rem #0006; }
    h1 { margin-top: 0; font-size: 1.2rem; font-weight: 600; color: #aeb8d4; }
    output { display: block; margin: 1rem; font-size: 6rem; font-variant-numeric: tabular-nums; }
    button { border: 0; border-radius: .75rem; padding: .9rem 1.4rem; color: white; background: #635bff;
      font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    p { min-height: 1.4em; color: #ffb4b4; }
  </style>
</head>
<body>
  <main>
    <h1>Shared BoxOS counter</h1>
    <output id="count">…</output>
    <button id="increment" type="button">Increment</button>
    <p id="error" role="alert"></p>
  </main>
  <script type="module">
    import { boxos } from "/client.js";
    const boxId = ${JSON.stringify(boxId)};
    const count = document.querySelector("#count");
    const button = document.querySelector("#increment");
    const error = document.querySelector("#error");

    async function refresh() {
      const state = await boxos.readPublic(boxId, "count");
      count.value = state.found ? state.value : 0;
      count.textContent = count.value;
    }

    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try {
        const result = await boxos.invoke(boxId, "increment", null);
        if (!result.ok) throw new Error(result.error);
        count.value = result.value;
        count.textContent = result.value;
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
      } finally {
        button.disabled = false;
      }
    });

    try { await refresh(); }
    catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); }
  </script>
</body>
</html>`

async function operation(operation: ClientOperationRequest["operation"]): Promise<Record<string, unknown>> {
  const request: ClientOperationRequest = { nonce: crypto.randomUUID(), operation }
  return post(baseUrl, "/v1/operations", {
    account: signer.account,
    signature: await signature(signer.privateKey, clientOperationSigningMessage(request)),
    request,
  })
}

const blob = await operation({ type: "publishBlob", text: page })
const publishedPage = await operation({ type: "publishPage", blobId: String(blob["id"]) })
const pageId = String(publishedPage["id"])
const server = new URL(baseUrl)

console.log(`Account: ${signer.account}`)
console.log(`Counter box: ${boxId}`)
console.log(`Page ID: ${pageId}`)
console.log(`Page API URL: ${new URL(`/v1/pages/${pageId}`, baseUrl)}`)
console.log(`Page host URL: ${server.protocol}//${pageId}.localhost:${server.port || "80"}/`)
