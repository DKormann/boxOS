import { startBoxOSServer } from "./server/server.ts"

const port = Number(Bun.env.BOXOS_PORT ?? 3000)
const workerCount = Number(Bun.env.BOXOS_WORKERS ?? 2)
const maximumTurnMilliseconds = Number(Bun.env.BOXOS_TURN_TIMEOUT_MS ?? 1_000)

const server = await startBoxOSServer({
  databasePath: Bun.env.BOXOS_DATABASE ?? "boxos.sqlite",
  hostname: Bun.env.BOXOS_HOST ?? "127.0.0.1",
  port,
  workerCount,
  maximumTurnMilliseconds,
})

console.log(`BoxOS ${server.url}`)
