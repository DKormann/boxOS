export type RequestOptions = { fuel?: number };
export type RunOptions = RequestOptions;
export type PublishedPage = { hash: string; url: string; expiresAt: number };
export type ClientOptions = { identity?: string; storageKey?: string };

type ApiResult<T> = {
  ok?: T;
  error?: string;
  code?: string;
  retryable?: boolean;
  balance?: number;
  required?: number;
};
type Challenge = { challenge: string; baseDifficultyBits: number; maxFundAmount: number };
type Stats = {
  fuel: { maximumInvocation: number; maximumFunding: number };
  storage: { pressureMultiplier: number };
  pages: { maximumBytes: number; publicationCost: number };
};

export class BoxOSError extends Error {
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, readonly response?: ApiResult<unknown>) {
    super(message);
    this.name = "BoxOSError";
    this.code = response?.code;
    this.retryable = response?.retryable === true;
  }
}

export class BoxOSClient {
  readonly baseUrl: string;
  readonly identity: string;

  constructor(baseUrl = globalThis.location?.origin, options: ClientOptions = {}) {
    if (!baseUrl) throw new TypeError("A boxOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.identity = options.identity ?? this.loadOrCreateIdentity(options.storageKey ?? "boxos.identity");
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.identity)) throw new TypeError("Identity must be a 256-bit Base64URL bearer key");
  }

  proc<TResult = unknown>(source: string): BoxOSProcedure<TResult> {
    return new BoxOSProcedure<TResult>(this, source);
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

  async balance(): Promise<number> {
    const result = await this.api<{ user: string; balance: number }>("/balance", { method: "GET" });
    return this.unwrap(result).balance;
  }

  async fund(amount: number): Promise<number> {
    if (!Number.isInteger(amount) || amount < 1) throw new TypeError("Funding amount must be a positive integer");
    const challengeResponse = await fetch(`${this.baseUrl}/challenge`, { method: "POST" });
    if (!challengeResponse.ok) throw new BoxOSError(`Challenge request failed with HTTP ${challengeResponse.status}`);
    const challenge = await challengeResponse.json() as Challenge;
    if (amount > challenge.maxFundAmount) throw new TypeError(`Funding amount cannot exceed ${challenge.maxFundAmount}`);
    const user = await this.hash(this.identity);
    const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(amount));
    const nonce = await this.mine(challenge.challenge, amount, `fuel\n${user}\n${amount}`, difficulty);
    const result = await this.api<{ credited: number; balance: number }>("/fuel", {
      method: "POST",
      body: JSON.stringify({ amount, challenge: challenge.challenge, nonce }),
    });
    return this.unwrap(result).balance;
  }

  async ensureFuel(required: number): Promise<number> {
    let balance = await this.balance();
    while (balance < required) {
      const stats = await this.stats();
      balance = await this.fund(Math.min(stats.fuel.maximumFunding, required - balance));
    }
    return balance;
  }

  async register(source: string): Promise<string> {
    let result = await this.procRequest<string>({ register: source });
    if (result.code === "insufficient_balance") {
      await this.ensureFuel(result.required ?? 1);
      result = await this.procRequest<string>({ register: source });
    }
    return this.unwrap(result);
  }

  async invokeHash<TResult = unknown>(hash: string, arg: string, options: RequestOptions = {}): Promise<TResult> {
    const fuel = options.fuel ?? 100;
    await this.ensureFuel(fuel);
    return this.unwrap<TResult>(await this.procRequest({ invoke: hash, arg, fuel }));
  }

  async run<TResult = unknown>(source: string, arg: string, options: RunOptions = {}): Promise<TResult> {
    const hash = await this.hash(source);
    const fuel = options.fuel ?? 100;
    await this.ensureFuel(fuel);
    let result = await this.procRequest<TResult>({ invoke: hash, arg, fuel });
    if (result.code === "unknown_procedure") {
      await this.register(source);
      await this.ensureFuel(fuel);
      result = await this.procRequest<TResult>({ invoke: hash, arg, fuel });
    }
    return this.unwrap(result);
  }

  async inspect(hash: string): Promise<string | undefined> {
    return this.unwrap<string | undefined>(await this.procRequest({ inspect: hash }));
  }

  async publish(html: string): Promise<PublishedPage> {
    const stats = await this.stats();
    const bytes = new TextEncoder().encode(html).byteLength;
    if (bytes < 1 || bytes > stats.pages.maximumBytes) {
      throw new TypeError(`Page HTML must contain 1 to ${stats.pages.maximumBytes} UTF-8 bytes`);
    }
    await this.ensureFuel(stats.pages.publicationCost);
    let result = await this.api<PublishedPage>("/page", { method: "POST", body: JSON.stringify({ html }) });
    if (result.code === "insufficient_balance") {
      await this.ensureFuel(result.required ?? stats.pages.publicationCost);
      result = await this.api<PublishedPage>("/page", { method: "POST", body: JSON.stringify({ html }) });
    }
    return this.unwrap(result);
  }

  private async procRequest<T>(body: Record<string, unknown>): Promise<ApiResult<T>> {
    return this.api<T>("/proc", { method: "POST", body: JSON.stringify(body) });
  }

  private async api<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        "authorization": `Bearer ${this.identity}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    const result = await response.json() as ApiResult<T>;
    if (!response.ok && result.code !== "insufficient_balance") {
      throw new BoxOSError(result.error ?? `Request failed with HTTP ${response.status}`, result as ApiResult<unknown>);
    }
    return result;
  }

  private async mine(challenge: string, amount: number, commitment: string, difficulty: number): Promise<number> {
    const encoder = new TextEncoder();
    for (let nonce = 0; Number.isSafeInteger(nonce); nonce++) {
      const input = JSON.stringify([challenge, amount, commitment, nonce]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
      if (leadingZeroBits(digest) >= difficulty) return nonce;
      if (nonce > 0 && nonce % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new BoxOSError("Could not find a proof-of-work nonce");
  }

  private unwrap<T>(result: ApiResult<T>): T {
    if (typeof result.error === "string") throw new BoxOSError(result.error, result as ApiResult<unknown>);
    return result.ok as T;
  }

  private loadOrCreateIdentity(storageKey: string): string {
    try {
      const existing = globalThis.localStorage?.getItem(storageKey);
      if (existing) return existing;
      const identity = randomIdentity();
      globalThis.localStorage?.setItem(storageKey, identity);
      return identity;
    } catch {
      return randomIdentity();
    }
  }
}

export class BoxOSProcedure<TResult = unknown> {
  constructor(readonly client: BoxOSClient, readonly source: string) {}
  hash(): Promise<string> { return this.client.hash(this.source); }
  invoke(arg: string, options: RunOptions = {}): Promise<TResult> {
    return this.client.run<TResult>(this.source, arg, options);
  }
}

function randomIdentity(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) { count += 8; continue; }
    for (let bit = 7; bit >= 0 && (byte & (1 << bit)) === 0; bit--) count++;
    break;
  }
  return count;
}
