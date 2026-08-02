// client.ts
class BoxOSError extends Error {
  response;
  code;
  retryable;
  constructor(message, response) {
    super(message);
    this.response = response;
    this.name = "BoxOSError";
    this.code = response?.code;
    this.retryable = response?.retryable === true;
  }
}

class BoxOSClient {
  baseUrl;
  identity;
  constructor(baseUrl = globalThis.location?.origin, options = {}) {
    if (!baseUrl)
      throw new TypeError("A boxOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.identity = options.identity ?? this.loadOrCreateIdentity(options.storageKey ?? "boxos.identity");
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.identity))
      throw new TypeError("Identity must be a 256-bit Base64URL bearer key");
  }
  proc(source) {
    return new BoxOSProcedure(this, source);
  }
  async hash(source) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async stats() {
    const response = await fetch(`${this.baseUrl}/stats`);
    if (!response.ok)
      throw new BoxOSError(`Stats request failed with HTTP ${response.status}`);
    return await response.json();
  }
  async balance() {
    const result = await this.api("/balance", { method: "GET" });
    return this.unwrap(result).balance;
  }
  async fund(amount) {
    if (!Number.isInteger(amount) || amount < 1)
      throw new TypeError("Funding amount must be a positive integer");
    const challengeResponse = await fetch(`${this.baseUrl}/challenge`, { method: "POST" });
    if (!challengeResponse.ok)
      throw new BoxOSError(`Challenge request failed with HTTP ${challengeResponse.status}`);
    const challenge = await challengeResponse.json();
    if (amount > challenge.maxFundAmount)
      throw new TypeError(`Funding amount cannot exceed ${challenge.maxFundAmount}`);
    const user = await this.hash(this.identity);
    const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(amount));
    const nonce = await this.mine(challenge.challenge, amount, `fuel
${user}
${amount}`, difficulty);
    const result = await this.api("/fuel", {
      method: "POST",
      body: JSON.stringify({ amount, challenge: challenge.challenge, nonce })
    });
    return this.unwrap(result).balance;
  }
  async ensureFuel(required) {
    let balance = await this.balance();
    while (balance < required) {
      const stats = await this.stats();
      balance = await this.fund(Math.min(stats.fuel.maximumFunding, required - balance));
    }
    return balance;
  }
  async register(source) {
    let result = await this.procRequest({ register: source });
    if (result.code === "insufficient_balance") {
      await this.ensureFuel(result.required ?? 1);
      result = await this.procRequest({ register: source });
    }
    return this.unwrap(result);
  }
  async invokeHash(hash, arg, options = {}) {
    const fuel = options.fuel ?? 100;
    await this.ensureFuel(fuel);
    return this.unwrap(await this.procRequest({ invoke: hash, arg, fuel }));
  }
  async run(source, arg, options = {}) {
    const hash = await this.hash(source);
    const fuel = options.fuel ?? 100;
    await this.ensureFuel(fuel);
    let result = await this.procRequest({ invoke: hash, arg, fuel });
    if (result.code === "unknown_procedure") {
      await this.register(source);
      await this.ensureFuel(fuel);
      result = await this.procRequest({ invoke: hash, arg, fuel });
    }
    return this.unwrap(result);
  }
  async inspect(hash) {
    return this.unwrap(await this.procRequest({ inspect: hash }));
  }
  async publish(html) {
    const stats = await this.stats();
    const bytes = new TextEncoder().encode(html).byteLength;
    if (bytes < 1 || bytes > stats.pages.maximumBytes) {
      throw new TypeError(`Page HTML must contain 1 to ${stats.pages.maximumBytes} UTF-8 bytes`);
    }
    await this.ensureFuel(stats.pages.publicationCost);
    let result = await this.api("/page", { method: "POST", body: JSON.stringify({ html }) });
    if (result.code === "insufficient_balance") {
      await this.ensureFuel(result.required ?? stats.pages.publicationCost);
      result = await this.api("/page", { method: "POST", body: JSON.stringify({ html }) });
    }
    return this.unwrap(result);
  }
  async procRequest(body) {
    return this.api("/proc", { method: "POST", body: JSON.stringify(body) });
  }
  async api(path, init) {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.identity}`,
        ...init.body === undefined ? {} : { "content-type": "application/json" },
        ...init.headers
      }
    });
    const result = await response.json();
    if (!response.ok && result.code !== "insufficient_balance") {
      throw new BoxOSError(result.error ?? `Request failed with HTTP ${response.status}`, result);
    }
    return result;
  }
  async mine(challenge, amount, commitment, difficulty) {
    const encoder = new TextEncoder;
    for (let nonce = 0;Number.isSafeInteger(nonce); nonce++) {
      const input = JSON.stringify([challenge, amount, commitment, nonce]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
      if (leadingZeroBits(digest) >= difficulty)
        return nonce;
      if (nonce > 0 && nonce % 2048 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new BoxOSError("Could not find a proof-of-work nonce");
  }
  unwrap(result) {
    if (typeof result.error === "string")
      throw new BoxOSError(result.error, result);
    return result.ok;
  }
  loadOrCreateIdentity(storageKey) {
    try {
      const existing = globalThis.localStorage?.getItem(storageKey);
      if (existing)
        return existing;
      const identity = randomIdentity();
      globalThis.localStorage?.setItem(storageKey, identity);
      return identity;
    } catch {
      return randomIdentity();
    }
  }
}

class BoxOSProcedure {
  client;
  source;
  constructor(client, source) {
    this.client = client;
    this.source = source;
  }
  hash() {
    return this.client.hash(this.source);
  }
  invoke(arg, options = {}) {
    return this.client.run(this.source, arg, options);
  }
}
function randomIdentity() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function leadingZeroBits(bytes) {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7;bit >= 0 && (byte & 1 << bit) === 0; bit--)
      count++;
    break;
  }
  return count;
}
export {
  BoxOSProcedure,
  BoxOSError,
  BoxOSClient
};
