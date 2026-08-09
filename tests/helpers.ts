import { rm } from "fs/promises";
import { IDENTITY_PROCEDURE_HASH } from "../src/userspace/identity.ts";

type Authorization = { grant: Record<string, unknown>; message: string; signature: string; publicKey: string };

export type TestServer = {
  origin: string;
  headers: Record<string, string>;
  invoke(hash: string, input: unknown, authorization?: Authorization, origin?: string): Promise<Response>;
  stop(): Promise<void>;
};

function base64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function startServer(): Promise<TestServer> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const origin = `http://127.0.0.1:${port}`;
  const path = `/tmp/boxos-test-${crypto.randomUUID()}.sqlite`;
  const systemKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const recovery = `boxos1.${base64Url(await crypto.subtle.exportKey("pkcs8", systemKeys.privateKey))}.${base64Url(await crypto.subtle.exportKey("raw", systemKeys.publicKey))}`;
  const child = Bun.spawn({
    cmd: [Bun.which("bun")!, "src/server.ts"],
    cwd: ".",
    env: { HOST: "127.0.0.1", PORT: String(port), BOXOS_DB_PATH: path, BOXOS_SYSTEM_RECOVERY_KEY: recovery },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
    await Bun.sleep(20);
  }
  if (!await fetch(`${origin}/health`).then(response => response.ok).catch(() => false)) {
    child.kill();
    throw new Error("Test server did not start");
  }
  const headers = {
    authorization: `Bearer ${"A".repeat(43)}`,
    "content-type": "application/json",
    origin,
  };
  return {
    origin,
    headers,
    invoke(hash, input, authorization, requestOrigin = origin) {
      return fetch(`${origin}/invoke/${hash}`, {
        method: "POST",
        headers: { ...headers, origin: requestOrigin },
        body: JSON.stringify({ input, authorization, fuel: 1000 }),
      });
    },
    async stop() {
      child.kill();
      await child.exited;
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    },
  };
}

export async function createSignedAccount(server: TestServer) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = base64Url(await crypto.subtle.exportKey("raw", keys.publicKey));
  const registered = await server.invoke(IDENTITY_PROCEDURE_HASH, { action: "register", publicKey })
    .then(response => response.json()) as { ok: string };
  return {
    id: registered.ok,
    async authorization(resource: string, capabilities: string[], purpose: string): Promise<Authorization> {
      const grant = {
        version: 2,
        domain: "boxos-capability",
        account: registered.ok,
        audience: server.origin,
        resource,
        capabilities: [...new Set(capabilities)].sort(),
        purpose,
        grantId: crypto.randomUUID(),
      };
      const message = canonical(grant);
      const signature = base64Url(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message)));
      return { grant, message, signature, publicKey };
    },
  };
}
