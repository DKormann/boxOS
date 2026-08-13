// BOXOS 0.3.0 reference browser client. No dependencies or build step.
class BoxOSClient {
  constructor(baseUrl = globalThis.location?.origin) {
    if (!baseUrl) throw new TypeError("A BOXOS base URL is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
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
    if (!response.ok) throw new BoxOSError(value.error?.message || `HTTP ${response.status}`, response.status, value.error?.code);
    return value;
  }
}

class BoxOSError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "BoxOSError";
    this.status = status;
    this.code = code;
  }

  static async from(response) {
    let value;
    try { value = await response.json(); } catch { value = {}; }
    return new BoxOSError(value.error?.message || `HTTP ${response.status}`, response.status, value.error?.code);
  }
}

globalThis.BoxOSClient = BoxOSClient;
globalThis.BoxOSError = BoxOSError;
