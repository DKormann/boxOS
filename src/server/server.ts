import type { Database } from "bun:sqlite"
import { deployStartupExamples } from "../../examples/startup/deploy.ts"
import { parseBoxValue, stringifyBoxValue } from "../core/values.ts"
import { openDatabase } from "../storage/database.ts"
import { WorkerPool } from "../workers/pool.ts"
import type { ClientNotification } from "../workers/scheduler.ts"
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
  type EventConnection = {
    controller: ReadableStreamDefaultController<Uint8Array>
    lastWrite: number
    close(): void
  }
  const eventConnections = new Map<string, Set<EventConnection>>()

  function broadcastClientNotification(notification: ClientNotification): boolean {
    const connections = eventConnections.get(notification.clientId)
    if (!connections?.size) return false
    const data = stringifyBoxValue({
      id: notification.id,
      sender: notification.sender,
      message: notification.message,
    })
    const bytes = new TextEncoder().encode(
      `id: ${notification.id}\nevent: message\ndata: ${data}\n\n`,
    )
    let delivered = false
    for (const connection of [...connections]) {
      try {
        connection.controller.enqueue(bytes)
        connection.lastWrite = Date.now()
        delivered = true
      } catch {
        connection.close()
      }
    }
    return delivered
  }

  function keepEventStreamsAlive(): void {
    const now = Date.now()
    for (const connections of eventConnections.values()) {
      for (const connection of [...connections]) {
        if (now - connection.lastWrite < 15_000) continue
        try {
          connection.controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
          connection.lastWrite = now
        } catch {
          connection.close()
        }
      }
    }
  }

  function eventStream(clientId: string): Response {
    let connection: EventConnection | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connection = {
          controller,
          lastWrite: Date.now(),
          close() {
            const connections = eventConnections.get(clientId)
            connections?.delete(connection!)
            if (connections?.size == 0) eventConnections.delete(clientId)
          },
        }
        let connections = eventConnections.get(clientId)
        if (!connections) {
          connections = new Set()
          eventConnections.set(clientId, connections)
        }
        connections.add(connection)
        controller.enqueue(new TextEncoder().encode(": connected\n\n"))
      },
      cancel() {
        connection?.close()
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

  pool.scheduler.setNotificationHandler(broadcastClientNotification)
  service.setNotificationHandler(broadcastClientNotification)

  const server = Bun.serve({
    port: options.port ?? 3000,
    idleTimeout: 255,
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
        if (
          (request.method == "GET" || request.method == "HEAD")
          && (url.pathname == "/" || url.pathname == "/index.html")
        ) {
          const deployments = database.query<{ name: string; id: string }>(
            "SELECT name, id FROM startup_deployments WHERE name IN ('default.css', 'app-explorer.page')",
          ).all()
          const ids = Object.fromEntries(deployments.map(deployment => [deployment.name, deployment.id]))
          if (!ids["default.css"] || !ids["app-explorer.page"]) {
            throw new Error("Landing page deployments are unavailable")
          }
          const explorerUrl = new URL(`https://${ids["app-explorer.page"]}.boxos.org/`)
          const source = (await Bun.file(new URL("../../public/index.html", import.meta.url)).text())
            .replaceAll("{{DEFAULT_CSS}}", ids["default.css"])
            .replaceAll("{{EXPLORER_URL}}", explorerUrl.href)
          return new Response(request.method == "HEAD" ? null : source, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=300",
              "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            },
          })
        }
        if (
          (request.method == "GET" || request.method == "HEAD")
          && (url.pathname == "/docs" || url.pathname == "/docs/")
        ) {
          return new Response(null, {
            status: 308,
            headers: { location: "/developers" },
          })
        }
        if (
          (request.method == "GET" || request.method == "HEAD")
          && (url.pathname == "/developers" || url.pathname == "/developers/")
        ) {
          const deployment = database.query<{ id: string }>(
            "SELECT id FROM startup_deployments WHERE name = 'default.css'",
          ).get()
          if (!deployment) throw new Error("Developer documentation stylesheet is unavailable")
          const source = (await Bun.file(new URL("../../public/developers.html", import.meta.url)).text())
            .replaceAll("{{DEFAULT_CSS}}", deployment.id)
          return new Response(request.method == "HEAD" ? null : source, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=300",
              "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            },
          })
        }
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
        if (
          (request.method == "GET" || request.method == "HEAD")
          && (url.pathname == "/boxos-cli.js" || url.pathname == "/boxos")
        ) {
          const source = await Bun.file(new URL("../../public/boxos-cli.js", import.meta.url)).text()
          return new Response(request.method == "HEAD" ? null : source, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "content-disposition": "attachment; filename=\"boxos\"",
              "cache-control": "public, max-age=300",
            },
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
        const status = error instanceof TypeError || error instanceof SyntaxError
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
  const eventTimer = setInterval(keepEventStreamsAlive, 5_000)
  drainEffects()

  return {
    url: server.url,
    stop(): void {
      clearInterval(effectTimer)
      clearInterval(eventTimer)
      for (const connections of eventConnections.values()) {
        for (const connection of connections) {
          try { connection.controller.close() } catch { /* already closed */ }
        }
      }
      eventConnections.clear()
      server.stop(true)
      pool.stop()
      database.close()
    },
  }
}
