export type ProcOperation =
  | { register: string }
  | { invoke: string; shard: string; arg: string }
  | { inspect: string };

export type RequestOptions = { fuel?: number };
export type RunOptions = RequestOptions & { registrationFuel?: number };

type ApiResult<T> = { ok?: T; error?: string };
type Challenge = { challenge: string; baseDifficultyBits: number; maxFuel: number };
type Stats = {
  fuel: { maximum: number };
  storage: { fuelPerStartedKiB: number };
};

export class BoxOSError extends Error {
  constructor(message: string, readonly response?: unknown) {
    super(message);
    this.name = "BoxOSError";
  }
}

export class BoxOSClient {
  readonly baseUrl: string;

  constructor(baseUrl = globalThis.location?.origin) {
    if (!baseUrl) throw new TypeError("A boxOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  proc(source: string): BoxOSProcedure {
    return new BoxOSProcedure(this, source);
  }

  async hash(source: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async stats(): Promise<Stats> {
    const response = await fetch(`${this.baseUrl}/stats`);
    if (!response.ok) throw new BoxOSError(`Stats request failed with HTTP ${response.status}`);
    return await response.json() as Stats;
  }

  async register(source: string, options: RequestOptions = {}): Promise<string> {
    const fuel = options.fuel ?? await this.registrationFuel(source);
    return this.unwrap<string>(await this.request({ register: source }, fuel));
  }

  async invokeHash(hash: string, shard: string, arg: string, options: RequestOptions = {}): Promise<unknown> {
    return this.unwrap(await this.request({ invoke: hash, shard, arg }, options.fuel ?? 100));
  }

  async run(source: string, shard: string, arg: string, options: RunOptions = {}): Promise<unknown> {
    const hash = await this.hash(source);
    const fuel = options.fuel ?? 100;
    let result = await this.request({ invoke: hash, shard, arg }, fuel);

    if (result.error?.startsWith("Unknown procedure:")) {
      await this.register(source, { fuel: options.registrationFuel });
      result = await this.request({ invoke: hash, shard, arg }, fuel);
    }
    return this.unwrap(result);
  }

  async inspect(hash: string, options: RequestOptions = {}): Promise<string | undefined> {
    return this.unwrap<string | undefined>(await this.request({ inspect: hash }, options.fuel ?? 1));
  }

  private async registrationFuel(source: string): Promise<number> {
    const stats = await this.stats();
    const bytes = new TextEncoder().encode(source).byteLength + 64;
    const cost = stats.storage.fuelPerStartedKiB * Math.max(1, Math.ceil(bytes / 1024));
    return Math.min(stats.fuel.maximum, cost);
  }

  private async request<T>(operation: ProcOperation, fuel: number): Promise<ApiResult<T>> {
    if (!Number.isInteger(fuel) || fuel < 1) throw new TypeError("Fuel must be a positive integer");
    const challengeResponse = await fetch(`${this.baseUrl}/challenge`, { method: "POST" });
    if (!challengeResponse.ok) {
      throw new BoxOSError(`Challenge request failed with HTTP ${challengeResponse.status}`);
    }
    const challenge = await challengeResponse.json() as Challenge;
    if (fuel > challenge.maxFuel) throw new TypeError(`Fuel cannot exceed ${challenge.maxFuel}`);

    const commitment = this.commitment(operation);
    const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(fuel));
    const nonce = await this.mine(challenge.challenge, fuel, commitment, difficulty);
    const response = await fetch(`${this.baseUrl}/proc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...operation, fuel, challenge: challenge.challenge, nonce }),
    });
    const result = await response.json() as ApiResult<T>;
    if (!response.ok) throw new BoxOSError(result.error ?? `Request failed with HTTP ${response.status}`, result);
    return result;
  }

  private commitment(operation: ProcOperation): string {
    if ("register" in operation) return `register\n${operation.register}`;
    if ("invoke" in operation) return `invoke\n${operation.shard}\n${operation.invoke}\n${operation.arg}`;
    return `inspect\n${operation.inspect}`;
  }

  private async mine(challenge: string, fuel: number, commitment: string, difficulty: number): Promise<number> {
    const encoder = new TextEncoder();
    for (let nonce = 0; Number.isSafeInteger(nonce); nonce++) {
      const input = JSON.stringify([challenge, fuel, commitment, nonce]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
      if (leadingZeroBits(digest) >= difficulty) return nonce;
      if (nonce > 0 && nonce % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new BoxOSError("Could not find a proof-of-work nonce");
  }

  private unwrap<T>(result: ApiResult<T>): T {
    if (typeof result.error === "string") throw new BoxOSError(result.error, result);
    return result.ok as T;
  }
}

export class BoxOSProcedure {
  constructor(readonly client: BoxOSClient, readonly source: string) {}

  hash(): Promise<string> {
    return this.client.hash(this.source);
  }

  invoke(shard: string, arg: string, options: RunOptions = {}): Promise<unknown> {
    return this.client.run(this.source, shard, arg, options);
  }
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0 && (byte & (1 << bit)) === 0; bit--) count++;
    break;
  }
  return count;
}
