// BOXOS 0.3.0 reference browser client. No dependencies or build step.
class BoxOSClient {
  constructor(baseUrl = globalThis.location?.origin) {
    if (!baseUrl) throw new TypeError("A BOXOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.ready = this.ensureAccount();
    this.invocations = Promise.resolve();
  }

  async ensureAccount() {
    const storageKey = "boxos:account:0.3.0";
    let privateKey;
    let publicKey;
    const stored = globalThis.localStorage?.getItem(storageKey);

    try {
      if (stored) {
        const jwk = JSON.parse(stored);
        privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
        publicKey = jwk.x;
      }
    } catch {
      globalThis.localStorage?.removeItem(storageKey);
    }

    if (!privateKey || !publicKey) {
      const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
      const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
      privateKey = keys.privateKey;
      publicKey = publicJwk.x;
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(privateJwk));
    }

    const account = await this.request("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });
    return { ...account, privateKey };
  }

  account() {
    return this.ready;
  }

  getAccount(publicKey) {
    return this.request(`/accounts/${encodeURIComponent(publicKey)}`);
  }

  putBlob(bytes) {
    if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
      throw new TypeError("Blob content must be a string, ArrayBuffer, or typed array");
    }
    return this.request("/blobs", { method: "POST", body: bytes });
  }

  async getBlob(id) {
    const response = await fetch(`${this.baseUrl}/0.3.0/blobs/${encodeURIComponent(id)}`);
    if (!response.ok) throw await BoxOSError.from(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  createBox(definition) {
    return this.request("/boxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
  }

  getBox(id) {
    return this.request(`/boxes/${encodeURIComponent(id)}`);
  }

  getPublicState(box, key) {
    return this.request(`/boxes/${encodeURIComponent(box)}/state/public/${encodeURIComponent(key)}`);
  }

  invoke(box, method, input = null, maxFuel = 1_000_000) {
    const invocation = this.invocations.then(async () => {
      const account = await this.ready;
      const command = {
        publicKey: account.publicKey,
        nonce: account.nonce,
        box,
        method,
        maxFuel,
        input,
      };
      const domain = new TextEncoder().encode("BOXOS:INVOKE:0.3.0\0");
      const body = new TextEncoder().encode(JSON.stringify(command));
      const message = new Uint8Array(domain.length + body.length);
      message.set(domain);
      message.set(body, domain.length);
      const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", account.privateKey, message));
      let binary = "";
      for (const byte of signatureBytes) binary += String.fromCharCode(byte);
      const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      try {
        const response = await this.request("/invocations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command, signature }),
        });
        account.nonce = response.receipt.nonce;
        account.fuel -= response.receipt.spent;
        return response;
      } catch (error) {
        if (error.receipt) {
          account.nonce = error.receipt.nonce;
          account.fuel -= error.receipt.spent;
        }
        throw error;
      }
    });
    this.invocations = invocation.catch(() => {});
    return invocation;
  }

  readShared(box, key, authority, grant, grantSignature) {
    const read = this.invocations.then(async () => {
      const account = await this.ready;
      const command = {
        publicKey: account.publicKey,
        nonce: account.nonce,
        box,
        key,
        authority,
        grant,
        grantSignature,
      };
      const domain = new TextEncoder().encode("BOXOS:SHARED-READ-COMMAND:0.3.0\0");
      const body = new TextEncoder().encode(JSON.stringify(command));
      const message = new Uint8Array(domain.length + body.length);
      message.set(domain);
      message.set(body, domain.length);
      const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", account.privateKey, message));
      let binary = "";
      for (const byte of signatureBytes) binary += String.fromCharCode(byte);
      const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const response = await this.request("/shared-state/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, signature }),
      });
      account.nonce = response.nonce;
      return response;
    });
    this.invocations = read.catch(() => {});
    return read;
  }

  subscribeState(box, visibility, key, options = {}) {
    const subscription = this.invocations.then(async () => {
      if (visibility !== "public" && visibility !== "shared") {
        throw new TypeError("State subscriptions require public or shared visibility");
      }
      const account = await this.ready;
      const command = {
        publicKey: account.publicKey,
        nonce: account.nonce,
        box,
        visibility,
        key,
        maxFuel: options.maxFuel ?? 10_000,
      };
      if (visibility === "shared") {
        command.authority = options.authority;
        command.grant = options.grant;
        command.grantSignature = options.grantSignature;
      }
      const domain = new TextEncoder().encode("BOXOS:STATE-SUBSCRIBE:0.3.0\0");
      const body = new TextEncoder().encode(JSON.stringify(command));
      const message = new Uint8Array(domain.length + body.length);
      message.set(domain);
      message.set(body, domain.length);
      const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", account.privateKey, message));
      let binary = "";
      for (const byte of signatureBytes) binary += String.fromCharCode(byte);
      const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const response = await this.request("/state-subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, signature }),
      });
      account.nonce = response.receipt.nonce;
      account.fuel -= response.receipt.spent;
      const events = new EventSource(new URL(response.url, this.baseUrl));
      const expiryTimer = setTimeout(() => events.close(), Math.max(0, response.expires - Date.now()));
      if (options.onReady) events.addEventListener("ready", event => options.onReady(JSON.parse(event.data)));
      if (options.onChange) events.addEventListener("changed", () => options.onChange());
      events.addEventListener("reset", event => {
        clearTimeout(expiryTimer);
        events.close();
        if (options.onReset) options.onReset(JSON.parse(event.data));
      });
      if (options.onError) events.onerror = options.onError;
      return { ...response, events, close() { clearTimeout(expiryTimer); events.close(); } };
    });
    this.invocations = subscription.then(() => {}, () => {});
    return subscription;
  }

  hostPage(blob) {
    return this.request("/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob }),
    });
  }

  async request(path, init = {}) {
    const response = await fetch(`${this.baseUrl}/0.3.0${path}`, init);
    const value = await response.json();
    if (!response.ok) throw new BoxOSError(value.error?.message || `HTTP ${response.status}`, response.status, value.error?.code, value.receipt);
    return value;
  }
}

class BoxOSError extends Error {
  constructor(message, status, code, receipt) {
    super(message);
    this.name = "BoxOSError";
    this.status = status;
    this.code = code;
    this.receipt = receipt;
  }

  static async from(response) {
    let value;
    try { value = await response.json(); } catch { value = {}; }
    return new BoxOSError(value.error?.message || `HTTP ${response.status}`, response.status, value.error?.code);
  }
}

globalThis.BoxOSClient = BoxOSClient;
globalThis.BoxOSError = BoxOSError;
