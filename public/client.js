// Minimal browser client for BOXOS. No build step or dependencies required.
export class BoxOSClient {
  constructor(baseUrl = globalThis.location?.origin, options = {}) {
    if (!baseUrl) throw new TypeError("A BOXOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.identity = options.identity || loadIdentity(options.storageKey || "boxos.identity");
  }

  async account() {
    return this.request("/account");
  }

  async balance() {
    return (await this.account()).balance;
  }

  stats() {
    return this.request("/stats", {}, false);
  }

  async authorize(capabilities, text = "", resource = "") {
    if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== "string")) {
      throw new TypeError("Capabilities must be an array of strings");
    }
    const expectedCapabilities = [...new Set(capabilities)].sort();
    const popup = globalThis.open(`${this.baseUrl}/examples/accounts`, "boxos-accounts", "popup,width=560,height=720");
    if (!popup) throw new BoxOSError("The account popup was blocked");
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const request = { boxos: "authorize", requestId, nonce, capabilities, text, resource };
    return await new Promise((resolve, reject) => {
      const send = setInterval(() => { if (!popup.closed) popup.postMessage(request, "*"); }, 300);
      const timeout = setTimeout(() => finish(new BoxOSError("Authorization timed out")), 5 * 60 * 1000);
      const receive = event => {
        if (event.source !== popup || event.data?.requestId !== requestId) return;
        if (event.data.boxos === "authorization-denied") return finish(new BoxOSError("Authorization denied"));
        if (event.data.boxos !== "authorization") return;
        const authorization = event.data;
        if (authorization.grant?.audience !== globalThis.location.origin || authorization.grant?.nonce !== nonce
          || authorization.grant?.text !== text || authorization.grant?.resource !== resource
          || JSON.stringify(authorization.grant?.capabilities) !== JSON.stringify(expectedCapabilities)) {
          return finish(new BoxOSError("Invalid authorization response"));
        }
        if (authorization.message !== canonicalJson(authorization.grant)) {
          return finish(new BoxOSError("Authorization message is not canonical"));
        }
        finish(undefined, authorization);
      };
      const finish = (error, value) => {
        clearInterval(send); clearTimeout(timeout); removeEventListener("message", receive); popup.close();
        if (error) reject(error); else resolve(value);
      };
      addEventListener("message", receive);
      popup.postMessage(request, "*");
    });
  }

  async verifyAuthorization(authorization, options = {}) {
    if (!authorization || authorization.message !== canonicalJson(authorization.grant)) {
      throw new TypeError("Invalid authorization");
    }
    const stats = await this.stats();
    return this.invoke(stats.identities.procedure, {
      action: "verify",
      account: authorization.grant.account,
      message: authorization.message,
      signature: authorization.signature,
    }, options);
  }

  async validateCode(kind, code, options = {}) {
    const stats = await this.stats();
    return this.invoke(stats.procedures.validate, { kind, code }, options);
  }

  async publishCode(kind, code, options = {}) {
    const stats = await this.stats();
    return this.invoke(stats.procedures.publish, { kind, code }, options);
  }

  registerReducer(code) {
    return this.register("reducers", code);
  }

  registerProcedure(code) {
    return this.register("procedures", code);
  }

  async register(kind, code) {
    if (typeof code !== "string") throw new TypeError("Code must be a string");
    return this.request(`/${kind}`, { method: "POST", body: JSON.stringify({ code }) });
  }

  inspect(hash) {
    return this.request(`/code/${encodeURIComponent(hash)}`, {}, false);
  }

  publicState(hash, key) {
    return this.request(`/state/${encodeURIComponent(hash)}/${encodeURIComponent(key)}`, {}, false);
  }

  pageInfo() {
    return this.request("/page", {}, false);
  }

  async publishPage(html, options = {}) {
    if (typeof html !== "string") throw new TypeError("Page must be a string");
    const info = await this.pageInfo();
    if (new TextEncoder().encode(html).byteLength > info.maximumBytes) throw new TypeError("Page is too large");
    const invocation = await this.invoke(info.reducer, html, options);
    return { hash: invocation.ok, url: info.urlTemplate.replace("{id}", invocation.ok), fuel: invocation.fuel };
  }

  invoke(hash, input = null, options = {}) {
    return this.request(`/invoke/${encodeURIComponent(hash)}`, {
      method: "POST",
      body: JSON.stringify({ input, fuel: options.fuel || 1000 }),
    });
  }

  async runReducer(code, input = null, options = {}) {
    const registered = await this.registerReducer(code);
    return this.invoke(registered.hash, input, options);
  }

  async runProcedure(code, input = null, options = {}) {
    const registered = await this.registerProcedure(code);
    return this.invoke(registered.hash, input, options);
  }

  async request(path, init = {}, authenticated = true) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (authenticated) headers.set("authorization", `Bearer ${this.identity}`);
    const response = await fetch(this.baseUrl + path, { ...init, headers });
    const result = await response.json();
    if (!response.ok) throw new BoxOSError(result.error || `HTTP ${response.status}`, response.status, result);
    return result;
  }
}

export class BoxOSError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = "BoxOSError";
    this.status = status;
    this.response = response;
  }
}

function loadIdentity(storageKey) {
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function randomIdentity() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
