import type { Database } from "bun:sqlite"

export type FuelPolicy = Readonly<{
  initialFuel: number
  topUpFuel: number
  topUpIntervalMilliseconds: number
}>

export const DEFAULT_FUEL_POLICY: FuelPolicy = Object.freeze({
  initialFuel: 10_000,
  topUpFuel: 10_000,
  topUpIntervalMilliseconds: 60 * 60 * 1_000,
})

function validatePolicy(policy: FuelPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
  }
  if (policy.topUpIntervalMilliseconds == 0) {
    throw new TypeError("topUpIntervalMilliseconds must be greater than zero")
  }
}

/** Register an authenticated account on first use and lazily replenish its fuel. */
export function touchAccount(
  database: Database,
  pubkey: string,
  policy: FuelPolicy = DEFAULT_FUEL_POLICY,
  now = Date.now(),
): number {
  validatePolicy(policy)
  return database.transaction(() => {
    const account = database.query<{ fuel: number; last_top_up_at: number }>(
      "SELECT fuel, last_top_up_at FROM accounts WHERE pubkey = ?",
    ).get(pubkey)
    if (!account) {
      database.query(
        "INSERT INTO accounts (pubkey, fuel, last_top_up_at) VALUES (?, ?, ?)",
      ).run(pubkey, policy.initialFuel, now)
      return policy.initialFuel
    }

    if (now - account.last_top_up_at < policy.topUpIntervalMilliseconds) return account.fuel
    const fuel = Math.max(account.fuel, policy.topUpFuel)
    database.query(
      "UPDATE accounts SET fuel = ?, last_top_up_at = ? WHERE pubkey = ?",
    ).run(fuel, now, pubkey)
    return fuel
  })()
}
