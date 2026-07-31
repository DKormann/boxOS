// client.ts
class BoxOSError extends Error {
  response;
  constructor(message, response) {
    super(message);
    this.response = response;
    this.name = "BoxOSError";
  }
}

class BoxOSClient {
  baseUrl;
  constructor(baseUrl = globalThis.location?.origin) {
    if (!baseUrl)
      throw new TypeError("A boxOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
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
  async register(source, options = {}) {
    const fuel = options.fuel ?? await this.registrationFuel(source);
    return this.unwrap(await this.request({ register: source }, fuel));
  }
  async invokeHash(hash, shard, arg, options = {}) {
    return this.unwrap(await this.request({ invoke: hash, shard, arg }, options.fuel ?? 100));
  }
  async run(source, shard, arg, options = {}) {
    const hash = await this.hash(source);
    const fuel = options.fuel ?? 100;
    let result = await this.request({ invoke: hash, shard, arg }, fuel);
    if (result.error?.startsWith("Unknown procedure:")) {
      await this.register(source, { fuel: options.registrationFuel });
      result = await this.request({ invoke: hash, shard, arg }, fuel);
    }
    return this.unwrap(result);
  }
  async inspect(hash, options = {}) {
    return this.unwrap(await this.request({ inspect: hash }, options.fuel ?? 1));
  }
  async registrationFuel(source) {
    const stats = await this.stats();
    const bytes = new TextEncoder().encode(source).byteLength + 64;
    const cost = stats.storage.fuelPerStartedKiB * Math.max(1, Math.ceil(bytes / 1024));
    return Math.min(stats.fuel.maximum, cost);
  }
  async request(operation, fuel) {
    if (!Number.isInteger(fuel) || fuel < 1)
      throw new TypeError("Fuel must be a positive integer");
    const challengeResponse = await fetch(`${this.baseUrl}/challenge`, { method: "POST" });
    if (!challengeResponse.ok) {
      throw new BoxOSError(`Challenge request failed with HTTP ${challengeResponse.status}`);
    }
    const challenge = await challengeResponse.json();
    if (fuel > challenge.maxFuel)
      throw new TypeError(`Fuel cannot exceed ${challenge.maxFuel}`);
    const commitment = this.commitment(operation);
    const difficulty = challenge.baseDifficultyBits + Math.ceil(Math.log2(fuel));
    const nonce = await this.mine(challenge.challenge, fuel, commitment, difficulty);
    const response = await fetch(`${this.baseUrl}/proc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...operation, fuel, challenge: challenge.challenge, nonce })
    });
    const result = await response.json();
    if (!response.ok)
      throw new BoxOSError(result.error ?? `Request failed with HTTP ${response.status}`, result);
    return result;
  }
  commitment(operation) {
    if ("register" in operation)
      return `register
${operation.register}`;
    if ("invoke" in operation)
      return `invoke
${operation.shard}
${operation.invoke}
${operation.arg}`;
    return `inspect
${operation.inspect}`;
  }
  async mine(challenge, fuel, commitment, difficulty) {
    const encoder = new TextEncoder;
    for (let nonce = 0;Number.isSafeInteger(nonce); nonce++) {
      const input = JSON.stringify([challenge, fuel, commitment, nonce]);
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
  invoke(shard, arg, options = {}) {
    return this.client.run(this.source, shard, arg, options);
  }
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
