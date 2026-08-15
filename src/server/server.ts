import type { Database } from "bun:sqlite"
import { deployStartupExamples } from "../../examples/startup/deploy.ts"
import { parseBoxValue, stringifyBoxValue } from "../core/values.ts"
import { openDatabase } from "../storage/database.ts"
import { WorkerPool } from "../workers/pool.ts"
import { BoxOSService } from "./service.ts"

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function pageResponse(database: Database, id: string): Response {
  const row = database.query<{ bytes: Uint8Array }>(
    `SELECT blobs.bytes FROM pages
     JOIN blobs ON blobs.id = pages.blob_id
     WHERE pages.id = ?`,
  ).get(id)
  return row
    ? new Response(new TextDecoder().decode(row.bytes), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, immutable",
        "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      },
    })
    : json({ error: "Not found" }, 404)
}

async function requestBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > 2 * 1024 * 1024) throw new TypeError("Request body exceeds 2 MiB")
  return request.json()
}

export type BoxOSServer = {
  readonly url: URL
  stop(): void
}

export async function startBoxOSServer(options: {
  databasePath: string
  port?: number
  hostname?: string
  workerCount?: number
  maximumTurnMilliseconds?: number
}): Promise<BoxOSServer> {
  const database = openDatabase(options.databasePath)
  await deployStartupExamples(database)
  const pool = new WorkerPool({
    databasePath: options.databasePath,
    size: options.workerCount ?? 2,
    maximumTurnMilliseconds: options.maximumTurnMilliseconds ?? 1_000,
  })
  const service = new BoxOSService(database, pool.scheduler)
  const eventStreams = new Set<() => void>()

  function eventStream(clientId: string): Response {
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    let close = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let lastKeepalive = Date.now()
        const send = () => {
          if (closed) return
          try {
            const rows = database.transaction(() => {
              const pending = database.query<{
                id: string
                sender_account: string
                message: string
              }>(
                `SELECT id, sender_account, message FROM client_messages
                 WHERE receiver_client_id = ? AND status = 'pending'
                 ORDER BY created_at, id LIMIT 100`,
              ).all(clientId)
              for (const row of pending) {
                database.query(
                  "UPDATE client_messages SET status = 'delivered' WHERE id = ? AND status = 'pending'",
                ).run(row.id)
              }
              return pending
            })()
            for (const row of rows) {
              const data = stringifyBoxValue({
                id: row.id,
                sender: row.sender_account,
                message: parseBoxValue(row.message),
              })
              controller.enqueue(new TextEncoder().encode(`id: ${row.id}\nevent: message\ndata: ${data}\n\n`))
              lastKeepalive = Date.now()
            }
            if (Date.now() - lastKeepalive >= 15_000) {
              controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
              lastKeepalive = Date.now()
            }
          } catch (error) {
            close()
            controller.error(error)
          }
        }
        close = () => {
          closed = true
          if (timer) clearInterval(timer)
          eventStreams.delete(close)
        }
        eventStreams.add(close)
        controller.enqueue(new TextEncoder().encode(": connected\n\n"))
        send()
        timer = setInterval(send, 250)
      },
      cancel() {
        close()
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
      },
    })
  }

  const server = Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const pageHost = url.hostname.match(/^([a-f0-9]{16})\./)?.[1]
        if (
          request.method == "GET"
          && pageHost
          && (url.pathname == "/" || url.pathname == "/index.html")
        ) return pageResponse(database, pageHost)
        if (request.method == "GET" && url.pathname == "/health") {
          return json({ ok: true })
        }
        if (request.method == "GET" && url.pathname == "/AGENTS.md") {
          return new Response(await Bun.file(new URL("../../AGENTS.md", import.meta.url)).text(), {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "cache-control": "no-cache",
            },
          })
        }
        if (request.method == "GET" && url.pathname == "/v1/startup") {
          const rows = database.query<{ name: string; kind: string; id: string }>(
            "SELECT name, kind, id FROM startup_deployments ORDER BY name",
          ).all()
          return json({
            deployments: Object.fromEntries(rows.map(row => [
              row.name,
              { kind: row.kind, id: row.id },
            ])),
          })
        }
        if (request.method == "GET" && url.pathname == "/client.js") {
          return new Response(await Bun.file(new URL("../../public/client.js", import.meta.url)).text(), {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "public, max-age=300",
            },
          })
        }
        if (request.method == "POST" && url.pathname == "/v1/boxes") {
          const body = await requestBody(request)
          if (body === null || Array.isArray(body) || typeof body != "object") {
            throw new TypeError("Signed box publication must be an object")
          }
          const envelope = body as { account?: unknown; signature?: unknown; request?: unknown }
          if (typeof envelope.account != "string" || typeof envelope.signature != "string") {
            throw new TypeError("Publication account and signature must be strings")
          }
          const id = await service.publishBoxForAccount(
            envelope.account,
            envelope.signature,
            envelope.request,
          )
          return json({ id }, 201)
        }
        if (request.method == "GET" && /^\/v1\/boxes\/[a-f0-9]{64}\/storage\/public$/.test(url.pathname)) {
          const id = url.pathname.split("/")[3]!
          const key = url.searchParams.get("key")
          if (key == null) throw new TypeError("Public storage reads require a key")
          const row = database.query<{ value: string }>(
            `SELECT value FROM box_state
             WHERE box_id = ? AND visibility = 'public' AND key = ?`,
          ).get(id, key)
          return json(row ? { found: true, value: parseBoxValue(row.value) } : { found: false })
        }
        if (request.method == "GET" && /^\/v1\/boxes\/[a-f0-9]{64}$/.test(url.pathname)) {
          const id = url.pathname.slice("/v1/boxes/".length)
          const row = database.query<{ definition: string }>(
            "SELECT definition FROM boxes WHERE id = ?",
          ).get(id)
          return row ? json({ id, definition: JSON.parse(row.definition) }) : json({ error: "Not found" }, 404)
        }
        if (request.method == "POST" && url.pathname == "/v1/events") {
          const body = await requestBody(request)
          if (body === null || Array.isArray(body) || typeof body != "object") {
            throw new TypeError("Signed event subscription must be an object")
          }
          const envelope = body as { account?: unknown; signature?: unknown; request?: unknown }
          if (typeof envelope.account != "string" || typeof envelope.signature != "string") {
            throw new TypeError("Event account and signature must be strings")
          }
          const subscription = await service.authenticateEventSubscription(
            envelope.account,
            envelope.signature,
            envelope.request,
          )
          return eventStream(subscription.clientId)
        }
        if (request.method == "POST" && url.pathname == "/v1/operations") {
          const body = await requestBody(request)
          if (body === null || Array.isArray(body) || typeof body != "object") {
            throw new TypeError("Signed operation must be an object")
          }
          const envelope = body as { account?: unknown; signature?: unknown; request?: unknown }
          if (typeof envelope.account != "string" || typeof envelope.signature != "string") {
            throw new TypeError("Operation account and signature must be strings")
          }
          return json(await service.operate(envelope.account, envelope.signature, envelope.request))
        }
        if (request.method == "GET" && /^\/v1\/pages\/[a-f0-9]{16}$/.test(url.pathname)) {
          return pageResponse(database, url.pathname.slice("/v1/pages/".length))
        }
        if (request.method == "GET" && /^\/v1\/blobs\/[a-f0-9]{64}$/.test(url.pathname)) {
          const id = url.pathname.slice("/v1/blobs/".length)
          const row = database.query<{ bytes: Uint8Array; content_type: string }>(
            "SELECT bytes, content_type FROM blobs WHERE id = ?",
          ).get(id)
          return row
            ? new Response(new TextDecoder().decode(row.bytes), {
              headers: { "content-type": row.content_type, "cache-control": "public, immutable" },
            })
            : json({ error: "Not found" }, 404)
        }
        if (request.method == "POST" && url.pathname == "/v1/invoke") {
          const body = await requestBody(request)
          if (body === null || Array.isArray(body) || typeof body != "object") {
            throw new TypeError("Signed invocation must be an object")
          }
          const envelope = body as { account?: unknown; signature?: unknown; request?: unknown }
          if (typeof envelope.account != "string" || typeof envelope.signature != "string") {
            throw new TypeError("Invocation account and signature must be strings")
          }
          const result = await service.invoke(envelope.account, envelope.signature, envelope.request)
          return json(result, result.ok ? 200 : 422)
        }
        return json({ error: "Not found" }, 404)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = error instanceof TypeError
          ? 400
          : /signature|account/i.test(message)
            ? 401
            : message.startsWith("Unknown method ")
              ? 404
              : 500
        return json({ error: message }, status)
      }
    },
    error(error): Response {
      return json({ error: error.message }, 500)
    },
  })

  const drainEffects = () => {
    void service.drainEffects().catch(error => console.error("Effect dispatch failed", error))
  }
  const effectTimer = setInterval(drainEffects, 100)
  drainEffects()

  return {
    url: server.url,
    stop(): void {
      clearInterval(effectTimer)
      for (const close of eventStreams) close()
      server.stop(true)
      pool.stop()
      database.close()
    },
  }
}
