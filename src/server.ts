import { chmod, readFile, readdir, writeFile } from "fs/promises";
import { APP_INSTALLS_REDUCER_CODE, APP_INSTALLS_REDUCER_HASH } from "./userspace/app-installs.ts";
import { APP_PUBLISHER_REDUCER_CODE, APP_PUBLISHER_REDUCER_HASH } from "./userspace/app-publisher.ts";
import { COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH } from "./userspace/counter.ts";
import { FRIENDS_REDUCER_CODE, FRIENDS_REDUCER_HASH } from "./userspace/friends.ts";
import { pageHash, procHash, sha256 } from "./hash.ts";
import {
  IDENTITY_PROCEDURE_CODE,
  IDENTITY_PROCEDURE_HASH,
  IDENTITY_REDUCER_CODE,
  IDENTITY_REDUCER_HASH,
} from "./userspace/identity.ts";
import { PAGE_MAX_BYTES, PAGE_REDUCER_CODE, PAGE_REDUCER_HASH } from "./page.ts";
import { ProcSyntaxError, validateProcCode } from "./parser.ts";
import { PROFILE_REDUCER_CODE, PROFILE_REDUCER_HASH } from "./userspace/profile.ts";
import {
  PUBLISH_PROCEDURE_CODE,
  PUBLISH_PROCEDURE_HASH,
  VALIDATE_PROCEDURE_CODE,
  VALIDATE_PROCEDURE_HASH,
} from "./userspace/procedures.ts";
import { STARTUP_REDUCER_CODE, STARTUP_REDUCER_HASH } from "./userspace/startup.ts";
import {
  INITIAL_USER_FUEL,
  InsufficientFuelError,
  STORAGE_FUEL_PER_BYTE,
  Storage,
  TransactionConflictError,
  type CodeKind,
  type StateMutation,
  type StateVisibility,
} from "./storage.ts";
import { TransactionCoordinator, type TransactionLimits } from "./transaction-coordinator.ts";
import { TODO_REDUCER_CODE, TODO_REDUCER_HASH } from "./userspace/todo.ts";
import { BOXOS_RUNTIME_VERSION, BOXOS_VERSION } from "./version.ts";
import { WorkerPool, WorkerPoolBusyError } from "./worker-pool.ts";

const HOST = Bun.env.HOST ?? "127.0.0.1";
const PORT = Number(Bun.env.PORT ?? 4000);
const DATABASE = Bun.env.BOXOS_DB_PATH ?? "boxos.sqlite";
const DEFAULT_FUEL = 1_000;
const MAX_FUEL = 10_000;
const MAX_CODE_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH_READS = 128;
const MAX_BATCH_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSACTION_READ_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_READS = 4_096;
const MAX_TRANSACTION_MUTATIONS = 4_096;
const MAX_TRANSACTION_REDUCERS = 128;
const MAX_STATE_VALUE_BYTES = 256 * 1024;
const TRANSACTION_LIMITS: TransactionLimits = {
  maximumReducers: MAX_TRANSACTION_REDUCERS,
  maximumReads: MAX_TRANSACTION_READS,
  maximumReadBytes: MAX_TRANSACTION_READ_BYTES,
  maximumMutations: MAX_TRANSACTION_MUTATIONS,
  maximumWriteBytes: MAX_TRANSACTION_WRITE_BYTES,
  maximumValueBytes: MAX_STATE_VALUE_BYTES,
};
const WORKER_POOL_SIZE = Number(Bun.env.BOXOS_WORKER_POOL_SIZE ?? 2);
const WORKER_QUEUE_LIMIT = Number(Bun.env.BOXOS_WORKER_QUEUE_LIMIT ?? 32);
const storage = new Storage(DATABASE);
const workerPool = new WorkerPool<Worker>(
  WORKER_POOL_SIZE,
  WORKER_QUEUE_LIMIT,
  () => new Worker(new URL("./worker.ts", import.meta.url), { smol: true }),
);

// Bundled userspace is installed for convenience, but is not exposed as core API metadata.
const reducerNames = ["ctx", "input", "JSON", "Math", "String"];
validateProcCode(PAGE_REDUCER_CODE, reducerNames, true);
validateProcCode(APP_INSTALLS_REDUCER_CODE, reducerNames, true);
validateProcCode(APP_PUBLISHER_REDUCER_CODE, reducerNames, true);
validateProcCode(COUNTER_REDUCER_CODE, reducerNames, true);
validateProcCode(FRIENDS_REDUCER_CODE, reducerNames, true);
validateProcCode(IDENTITY_REDUCER_CODE, reducerNames, true);
validateProcCode(IDENTITY_PROCEDURE_CODE, reducerNames, true);
validateProcCode(PROFILE_REDUCER_CODE, reducerNames, true);
validateProcCode(STARTUP_REDUCER_CODE, reducerNames, true);
validateProcCode(TODO_REDUCER_CODE, reducerNames, true);
validateProcCode(VALIDATE_PROCEDURE_CODE, reducerNames, true);
validateProcCode(PUBLISH_PROCEDURE_CODE, reducerNames, true);
storage.putSystemCode(PAGE_REDUCER_HASH, "reducer", PAGE_REDUCER_CODE);
storage.putSystemCode(APP_INSTALLS_REDUCER_HASH, "reducer", APP_INSTALLS_REDUCER_CODE);
storage.putSystemCode(APP_PUBLISHER_REDUCER_HASH, "reducer", APP_PUBLISHER_REDUCER_CODE);
storage.putSystemCode(COUNTER_REDUCER_HASH, "reducer", COUNTER_REDUCER_CODE);
storage.putSystemCode(FRIENDS_REDUCER_HASH, "reducer", FRIENDS_REDUCER_CODE);
storage.putSystemCode(IDENTITY_REDUCER_HASH, "reducer", IDENTITY_REDUCER_CODE);
storage.putSystemCode(IDENTITY_PROCEDURE_HASH, "procedure", IDENTITY_PROCEDURE_CODE);
storage.putSystemCode(PROFILE_REDUCER_HASH, "reducer", PROFILE_REDUCER_CODE);
storage.putSystemCode(STARTUP_REDUCER_HASH, "reducer", STARTUP_REDUCER_CODE);
storage.putSystemCode(TODO_REDUCER_HASH, "reducer", TODO_REDUCER_CODE);
storage.putSystemCode(VALIDATE_PROCEDURE_HASH, "procedure", VALIDATE_PROCEDURE_CODE);
storage.putSystemCode(PUBLISH_PROCEDURE_HASH, "procedure", PUBLISH_PROCEDURE_CODE);

const examplesDirectory = new URL("../examples/", import.meta.url);
const examples = await Promise.all((await readdir(examplesDirectory)).filter(name => !name.startsWith(".")).sort().map(async file => {
  if (!file.endsWith(".html")) throw new Error(`Example files must be HTML: ${file}`);
  const html = await Bun.file(new URL(file, examplesDirectory)).text();
  if (new TextEncoder().encode(html).byteLength > PAGE_MAX_BYTES) throw new Error(`Example is too large: ${file}`);
  const id = pageHash(html);
  const name = file.slice(0, -5);
  storage.putSystemPublicValue(PAGE_REDUCER_HASH, id, html);
  return { name, file, id, html };
}));

const aboutPage = examples.find(example => example.name === "about");
if (!aboutPage) throw new Error("examples/about.html is required");
const explorerPage = examples.find(example => example.name === "app-explorer");
if (!explorerPage) throw new Error("examples/app-explorer.html is required");

const proposalText = await Bun.file(new URL("../docs/proposal.md", import.meta.url)).text();
const quickstartText = await Bun.file(new URL("../docs/quickstart.md", import.meta.url)).text();
const apiText = await Bun.file(new URL("../docs/api.md", import.meta.url)).text();
const accountsText = await Bun.file(new URL("../docs/accounts.md", import.meta.url)).text();
const agentsText = await Bun.file(new URL("../docs/agents.md", import.meta.url)).text();
const clientJavaScript = await Bun.file(new URL("../public/client.js", import.meta.url)).text();
const pitchHtml = aboutPage.html;

const DOCS_STYLE = `
:root{font:17px/1.65 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#24252a;background:#f7f7f9}*{box-sizing:border-box}body{margin:0}a{color:#4f46d8;text-underline-offset:.16em}a:hover{color:#3730a3}.layout{width:min(76rem,calc(100% - 2rem));margin:0 auto;display:grid;grid-template-columns:14rem minmax(0,48rem);gap:4rem;align-items:start}.sidebar{position:sticky;top:0;padding:2rem 0}.brand{display:block;color:#24252a;font-size:1.15rem;font-weight:800;text-decoration:none;letter-spacing:.04em;margin-bottom:1.4rem}.sidebar nav{display:grid;gap:.25rem}.sidebar nav a{padding:.4rem .6rem;border-radius:.4rem;color:#5d5e68;text-decoration:none}.sidebar nav a:hover,.sidebar nav a.active{color:#3730a3;background:#ecebff}.sidebar .minor{margin-top:1.3rem;font-size:.88rem}article{min-width:0;padding:3.5rem 0 8rem}h1{font-size:clamp(2.2rem,6vw,3.5rem);line-height:1.08;letter-spacing:-.035em;margin:0 0 1.5rem}h2{font-size:1.65rem;line-height:1.25;margin:3rem 0 .8rem;padding-top:.4rem;border-top:1px solid #dddde3}h3{font-size:1.15rem;margin:2rem 0 .5rem}p,ul,ol{margin:.7rem 0 1.2rem}li{margin:.25rem 0}pre{overflow:auto;padding:1rem 1.15rem;border:1px solid #d9d9e0;border-radius:.65rem;background:#202129;color:#f3f3f5;font:14px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}code{padding:.12em .32em;border-radius:.3em;background:#e9e9ee;font: .88em ui-monospace,SFMono-Regular,Consolas,monospace}pre code{padding:0;background:transparent;font-size:inherit}blockquote{margin:1.3rem 0;padding:.7rem 1rem;border-left:4px solid #7068e8;background:#efefff;border-radius:0 .45rem .45rem 0}blockquote p{margin:0}.eyebrow{color:#6a6b75;font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.8rem}@media(max-width:760px){.layout{display:block}.sidebar{position:static;padding:1rem 0;border-bottom:1px solid #dddde3}.sidebar nav{display:flex;overflow:auto}.sidebar nav a{white-space:nowrap}.sidebar .minor{display:none}article{padding-top:2.5rem}}
`;

function inlineMarkdown(value: string): string {
  return value.split(/(`[^`]*`)/g).map(part => {
    if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
        const safe = /^(https?:\/\/|\/|#)/.test(href) ? href : "#";
        return `<a href="${escapeHtml(safe)}">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

function renderMarkdown(source: string): string {
  const lines = source.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index++]!);
      if (index < lines.length) index++;
      html.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      html.push(`<h${level} id="${id}">${inlineMarkdown(text)}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index]!)) {
        items.push(`<li>${inlineMarkdown(lines[index]!.replace(/^\s*-\s+/, ""))}</li>`);
        index++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index]!)) {
        items.push(`<li>${inlineMarkdown(lines[index]!.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        index++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("> ")) quote.push(lines[index++]!.slice(2));
      html.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,3})\s|^```|^\s*-\s+|^\s*\d+\.\s+|^>\s/.test(lines[index]!)) {
      paragraph.push(lines[index++]!.trim());
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}

function documentationPage(title: string, source: string, active: string): string {
  const links = [
    ["start", "/docs", "Quickstart"], ["api", "/docs/api", "API reference"],
    ["accounts", "/docs/accounts", "Accounts"], ["agents", "/docs/agents", "Agent guide"],
    ["proposal", "/proposal", "Architecture"],
  ];
  const navigation = links.map(([key, href, label]) =>
    `<a${key === active ? ` class="active"` : ""} href="${href}">${label}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)} · BOXOS</title><style>${DOCS_STYLE}</style></head><body><div class="layout"><aside class="sidebar"><a class="brand" href="/about">BOXOS</a><nav>${navigation}</nav><nav class="minor"><a href="/examples">Examples</a><a href="/examples/studio">Studio</a><a href="/client.js">Client module</a><a href="https://github.com/DKormann/boxOS">GitHub</a></nav></aside><article><div class="eyebrow">BOXOS documentation</div>${renderMarkdown(source)}</article></div></body></html>`;
}

const quickstartHtml = documentationPage("Quickstart", quickstartText, "start");
const apiHtml = documentationPage("API reference", apiText, "api");
const accountsHtml = documentationPage("Signed accounts", accountsText, "accounts");
const agentsHtml = documentationPage("Agent guide", agentsText, "agents");
const proposalHtml = documentationPage("Architecture", proposalText, "proposal");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: CORS });
}
function failure(error: unknown, status = 400): Response {
  if (error instanceof InsufficientFuelError) {
    return json({ error: error.message, code: "insufficient_fuel", balance: error.balance, required: error.required }, 402);
  }
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a JSON object");
  return value as Record<string, unknown>;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  return object(JSON.parse(text));
}
function codeKind(value: unknown): CodeKind {
  if (value !== "reducer" && value !== "procedure") throw new TypeError("kind must be 'reducer' or 'procedure'");
  return value;
}
function checkHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("Invalid SHA-256 hash");
}
function callerId(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new TypeError("A 256-bit bearer identity is required");
  return sha256(match[1]!);
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid Base64URL value");
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateSubmission(kind: CodeKind, code: string): string {
  if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) throw new Error("Code is too large");
  validateProcCode(code, ["ctx", "input", "JSON", "Math", "String"], true);
  return procHash(code);
}

async function register(request: Request, fixedKind?: CodeKind): Promise<Response> {
  try {
    const caller = callerId(request);
    const value = await body(request);
    const kind = fixedKind ?? codeKind(value.kind);
    if (typeof value.code !== "string") throw new TypeError("code must be a string");
    const hash = validateSubmission(kind, value.code);
    const registration = storage.registerCode(caller, hash, kind, value.code);
    return json({ hash, kind, ...registration }, registration.created ? 201 : 200);
  } catch (error) {
    const status = error instanceof ProcSyntaxError ? 422 : error instanceof TypeError && error.message.includes("bearer") ? 401 : 400;
    return failure(error, status);
  }
}

type WorkerRequest =
  | { type: "transaction-start"; id: number }
  | { type: "reducer-load"; id: number; requestId: number; hash: string }
  | { type: "state-read"; id: number; requestId: number; hash: string; visibility: StateVisibility; key: string }
  | { type: "transaction-commit"; id: number; mutations: unknown }
  | { type: "transaction-abort"; id: number }
  | { type: "publish"; id: number; kind: CodeKind; code: string }
  | { type: "result"; result: unknown }
  | { type: "error"; error: string; code?: string };

function pageIdFromHostname(hostname: string): string | undefined {
  const label = hostname.split(".")[0];
  return label && /^[a-z2-7]{16}$/.test(label) && hostname.includes(".") ? label : undefined;
}

function pageUrlTemplate(request: Request, url: URL, pageId?: string): string {
  const scheme = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const baseHost = Bun.env.PAGE_BASE_DOMAIN ?? (pageId ? url.host.slice(pageId.length + 1) : url.host);
  return `${scheme}://{id}.${baseHost}/`;
}

function rootUrl(request: Request, url: URL, pageId?: string): string {
  if (Bun.env.BOXOS_ROOT_URL) return Bun.env.BOXOS_ROOT_URL.replace(/\/$/, "");
  const scheme = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  let host = pageId ? url.host.slice(pageId.length + 1) : url.host;
  if (host.startsWith("pages.")) host = host.slice(6);
  return `${scheme}://${host}`;
}

function servePage(request: Request, url: URL, pageId: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (url.pathname !== "/") return new Response("Page Not Found", { status: 404 });
  const value = storage.publicValue(PAGE_REDUCER_HASH, pageId);
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > PAGE_MAX_BYTES) {
    return new Response("Page Not Found", { status: 404 });
  }
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "text/html; charset=utf-8",
    "etag": `"${pageId}"`,
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : value, { headers });
}

async function invoke(
  hash: string,
  input: unknown,
  fuel: number,
  caller: string,
  audience: string,
  authorization?: unknown,
): Promise<Response> {
  const code = storage.get(hash);
  if (!code) return failure(`Unknown code: ${hash}`, 404);
  try { storage.reserveFuel(caller, fuel); } catch (error) { return failure(error); }
  let workerLease;
  try {
    workerLease = await workerPool.acquire();
  } catch (error) {
    const balance = storage.creditFuel(caller, fuel);
    const status = error instanceof WorkerPoolBusyError ? 503 : 500;
    return json({
      error: error instanceof Error ? error.message : String(error),
      fuel: { reserved: fuel, used: 0, refunded: fuel },
      balance,
    }, status);
  }
  const worker = workerLease.worker;
  const started = performance.now();
  const transactions = new TransactionCoordinator(storage, caller, TRANSACTION_LIMITS, (mutation: StateMutation) => {
    if (mutation.operation === "set" && mutation.hash === PAGE_REDUCER_HASH && mutation.visibility === "public"
      && (typeof mutation.value !== "string" || new TextEncoder().encode(mutation.value).byteLength > PAGE_MAX_BYTES)) {
      throw new TypeError("Invalid or oversized page");
    }
  });
  let storageCharged = 0;
  let storageRepaid = 0;

  return await new Promise<Response>(resolve => {
    let done = false;
    const finish = (response: Response, reusable: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      transactions.clear();
      if (reusable) workerLease.release();
      else workerLease.discard();
      resolve(response);
    };
    const failedFuel = () => ({ reserved: fuel, used: fuel, refunded: 0 });
    const timer = setTimeout(() => finish(json({
      error: "Fuel exhausted", fuel: failedFuel(), balance: storage.balance(caller),
    }, 408), false), fuel);

    worker.onerror = event => finish(json({
      error: `Worker failed: ${event.message}`, fuel: failedFuel(), balance: storage.balance(caller),
    }, 500), false);
    worker.onmessage = event => {
      const message = event.data as WorkerRequest;
      if (message.type === "transaction-start") {
        try {
          transactions.begin(message.id);
          worker.postMessage({ type: "transaction-start-result", id: message.id, ok: true });
        } catch (error) {
          worker.postMessage({ type: "transaction-start-result", id: message.id, ok: false, error: String(error) });
        }
      } else if (message.type === "reducer-load") {
        try {
          const reducer = transactions.loadReducer(message.id, message.hash);
          worker.postMessage({ type: "reducer-result", requestId: message.requestId, ok: true, reducer });
        } catch (error) {
          worker.postMessage({ type: "reducer-result", requestId: message.requestId, ok: false, error: String(error) });
        }
      } else if (message.type === "state-read") {
        try {
          const read = transactions.read(message.id, message.hash, message.visibility, message.key);
          worker.postMessage({ type: "state-read-result", requestId: message.requestId, ok: true, ...read });
        } catch (error) {
          worker.postMessage({ type: "state-read-result", requestId: message.requestId, ok: false, error: String(error) });
        }
      } else if (message.type === "transaction-commit") {
        try {
          const settlement = transactions.commit(message.id, message.mutations);
          storageCharged += settlement.charged;
          storageRepaid += settlement.repaid;
          worker.postMessage({ type: "commit-result", id: message.id, ok: true });
        } catch (error) {
          worker.postMessage({
            type: "commit-result",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof TransactionConflictError ? "transaction_conflict" : undefined,
          });
        }
      } else if (message.type === "transaction-abort") {
        transactions.abort(message.id);
      } else if (message.type === "publish") {
        try {
          const hash = validateSubmission(message.kind, message.code);
          const registration = storage.registerCode(caller, hash, message.kind, message.code);
          worker.postMessage({
            type: "publish-result", id: message.id, ok: true,
            result: { hash, kind: message.kind, ...registration },
          });
        } catch (error) {
          worker.postMessage({ type: "publish-result", id: message.id, ok: false, error: String(error) });
        }
      } else if (message.type === "result") {
        const used = Math.min(fuel, Math.max(1, Math.ceil(performance.now() - started)));
        const refunded = fuel - used;
        const balance = storage.creditFuel(caller, refunded);
        finish(json({
          ok: message.result,
          fuel: { reserved: fuel, used, refunded, storageCharged, storageRepaid },
          balance,
        }), true);
      } else if (message.type === "error") {
        const status = message.code === "transaction_conflict" ? 409 : 422;
        finish(json({
          error: message.error,
          ...(message.code ? { code: message.code } : {}),
          fuel: failedFuel(),
          balance: storage.balance(caller),
        }, status), true);
      }
    };
    worker.postMessage({
      type: "start",
      hash,
      kind: code.kind,
      code: code.code,
      input,
      caller,
      audience,
      authorization,
    });
  });
}

async function systemRecoveryKey(): Promise<string> {
  if (Bun.env.BOXOS_SYSTEM_RECOVERY_KEY) return Bun.env.BOXOS_SYSTEM_RECOVERY_KEY;
  const path = Bun.env.BOXOS_SYSTEM_KEY_PATH ?? `${DATABASE}.system-key`;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privateKey = bytesBase64Url(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const publicKey = bytesBase64Url(await crypto.subtle.exportKey("raw", keys.publicKey));
  const recovery = `boxos1.${privateKey}.${publicKey}`;
  await writeFile(path, recovery, "utf8");
  await chmod(path, 0o600);
  return recovery;
}

async function installSystemExamples(): Promise<void> {
  const recovery = await systemRecoveryKey();
  const parts = recovery.split(".");
  if (parts.length !== 3 || parts[0] !== "boxos1") throw new Error("Invalid BOXOS_SYSTEM_RECOVERY_KEY");
  const publicKey = parts[2]!;
  const privateKey = await crypto.subtle.importKey("pkcs8", base64UrlBytes(parts[1]!), "Ed25519", false, ["sign"]);
  const verificationKey = await crypto.subtle.importKey("raw", base64UrlBytes(publicKey), "Ed25519", false, ["verify"]);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const challengeSignature = await crypto.subtle.sign("Ed25519", privateKey, challenge);
  if (!await crypto.subtle.verify("Ed25519", verificationKey, challengeSignature, challenge)) {
    throw new Error("BOXOS system recovery key does not match its public key");
  }
  const account = sha256(publicKey);
  const audience = "boxos:system";
  storage.putSystemPublicValue(IDENTITY_REDUCER_HASH, account, publicKey);

  const authorization = async (resource: string, capability: string, purpose: string) => {
    const grant = {
      version: 2,
      domain: "boxos-capability",
      account,
      audience,
      resource,
      capabilities: [capability],
      purpose,
      grantId: crypto.randomUUID(),
    };
    const message = canonicalJson(grant);
    const signature = bytesBase64Url(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message)));
    return { grant, message, signature, publicKey };
  };
  const call = async (hash: string, input: unknown, capability: string, purpose: string): Promise<unknown> => {
    const response = await invoke(hash, input, MAX_FUEL, account, audience, await authorization(hash, capability, purpose));
    const result = await response.json() as { ok?: unknown; error?: string };
    if (!response.ok) throw new Error(result.error ?? "BOXOS system invocation failed");
    return result.ok;
  };

  if (storage.publicValue(PROFILE_REDUCER_HASH, `profile:${account}`) === undefined) {
    await call(PROFILE_REDUCER_HASH, { action: "set", name: "BOXOS", bio: "Official BOXOS examples." }, "profile:write", "Create the BOXOS profile");
  }
  for (const example of examples) {
    const appId = pageHash(`boxos-example:${example.name}`);
    const record = storage.publicValue(APP_PUBLISHER_REDUCER_HASH, `app:${appId}`) as { authorId?: string } | undefined;
    if (!record) {
      await call(APP_PUBLISHER_REDUCER_HASH, {
        action: "publish", appId, pageId: example.id, name: example.name,
      }, "apps:publish", "Publish an official BOXOS example");
      continue;
    }
    if (record.authorId !== account) throw new Error(`BOXOS example app ID is already owned: ${example.name}`);
    const release = storage.publicValue(APP_PUBLISHER_REDUCER_HASH, `release-counter:${appId}`) as number | undefined ?? 1;
    const current = storage.publicValue(APP_PUBLISHER_REDUCER_HASH, `release:${appId}:${release}`);
    if (current !== example.id) {
      await call(APP_PUBLISHER_REDUCER_HASH, {
        action: "release", appId, pageId: example.id,
      }, "apps:publish", "Update an official BOXOS example");
    }
  }
}

await installSystemExamples();

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const pageId = pageIdFromHostname(url.hostname);
    if (pageId && url.pathname === "/") return servePage(request, url, pageId);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response("OK");
    if ((request.method === "GET" || request.method === "HEAD") && ["/", "/about", "/start"].includes(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : pitchHtml, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/start/try") {
      const target = pageUrlTemplate(request, url, pageId).replace("{id}", explorerPage.id);
      return Response.redirect(target, 302);
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/examples") {
      const template = pageUrlTemplate(request, url, pageId);
      const links = examples.map(example =>
        `<li><a href="${template.replace("{id}", example.id)}">${escapeHtml(example.name)}</a> <code>${example.id}</code></li>`,
      ).join("");
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BOXOS examples</title><h1>BOXOS examples</h1><ul>${links}</ul><p><a href="/docs">Documentation</a></p>`;
      return new Response(request.method === "HEAD" ? null : html, {
        headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/examples/")) {
      const name = decodeURIComponent(url.pathname.slice(10));
      const example = examples.find(item => item.name === name);
      if (!example) return failure("Example not found", 404);
      return Response.redirect(pageUrlTemplate(request, url, pageId).replace("{id}", example.id) + url.search, 302);
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/example") {
      const example = examples.find(item => item.name === "persistent-counter") ?? examples[0];
      if (!example) return failure("No examples installed", 404);
      return Response.redirect(pageUrlTemplate(request, url, pageId).replace("{id}", example.id), 302);
    }
    const documentation = url.pathname === "/docs" ? quickstartHtml
      : url.pathname === "/docs/api" ? apiHtml
      : url.pathname === "/docs/accounts" ? accountsHtml
      : url.pathname === "/docs/agents" ? agentsHtml
      : url.pathname === "/proposal" ? proposalHtml
      : undefined;
    if ((request.method === "GET" || request.method === "HEAD") && documentation) {
      return new Response(request.method === "HEAD" ? null : documentation, {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && ["/agents", "/llms.txt"].includes(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : agentsText, {
        headers: {
          ...CORS,
          "cache-control": "public, max-age=300",
          "content-type": "text/markdown; charset=utf-8",
          "link": "</docs/agents>; rel=alternate; type=text/html",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/client.js") {
      return new Response(request.method === "HEAD" ? null : clientJavaScript, {
        headers: {
          ...CORS,
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/version") {
      return json({ version: BOXOS_VERSION, runtime: BOXOS_RUNTIME_VERSION });
    }
    if (request.method === "GET" && url.pathname === "/account") {
      try {
        const user = callerId(request);
        return json({ user, balance: storage.account(user) });
      } catch (error) { return failure(error, 401); }
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return json({
        boxos: { version: BOXOS_VERSION, runtime: BOXOS_RUNTIME_VERSION },
        fuel: { initialUserFuel: INITIAL_USER_FUEL, runtimeFuelPerMillisecond: 1, maximumInvocation: MAX_FUEL },
        storage: {
          fuelPerByte: STORAGE_FUEL_PER_BYTE,
          maximumValueBytes: MAX_STATE_VALUE_BYTES,
          transaction: {
            maximumReducers: MAX_TRANSACTION_REDUCERS,
            maximumReads: MAX_TRANSACTION_READS,
            maximumReadBytes: MAX_TRANSACTION_READ_BYTES,
            maximumMutations: MAX_TRANSACTION_MUTATIONS,
            maximumWriteBytes: MAX_TRANSACTION_WRITE_BYTES,
          },
        },
        pages: { reducer: PAGE_REDUCER_HASH, maximumBytes: PAGE_MAX_BYTES },
      });
    }
    if (request.method === "GET" && url.pathname === "/page") {
      return json({
        reducer: PAGE_REDUCER_HASH,
        maximumBytes: PAGE_MAX_BYTES,
        rootUrl: rootUrl(request, url, pageId),
        urlTemplate: pageUrlTemplate(request, url, pageId),
      });
    }
    if (request.method === "POST" && url.pathname === "/code") return register(request);
    if (request.method === "POST" && url.pathname === "/reducers") return register(request, "reducer");
    if (request.method === "POST" && url.pathname === "/procedures") return register(request, "procedure");
    if (request.method === "GET" && url.pathname.startsWith("/code/")) {
      const hash = url.pathname.slice(6);
      try { checkHash(hash); } catch (error) { return failure(error); }
      const found = storage.get(hash);
      return found ? json(found) : failure(`Unknown code: ${hash}`, 404);
    }
    if (request.method === "POST" && url.pathname === "/state") {
      try {
        const value = await body(request);
        if (!Array.isArray(value.reads) || value.reads.length < 1 || value.reads.length > MAX_BATCH_READS) {
          throw new TypeError(`reads must contain one to ${MAX_BATCH_READS} items`);
        }
        const results = value.reads.map(item => {
          const read = object(item);
          if (typeof read.hash !== "string") throw new TypeError("State hash must be a string");
          if (typeof read.key !== "string" || read.key.length > 1024) throw new TypeError("State key must be a string of at most 1024 characters");
          checkHash(read.hash);
          const found = storage.publicValue(read.hash, read.key);
          return found === undefined ? { found: false } : { found: true, value: found };
        });
        const response = { results };
        if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_BATCH_RESPONSE_BYTES) {
          return failure("Batch response is too large", 413);
        }
        return json(response);
      } catch (error) { return failure(error); }
    }
    if (request.method === "GET" && url.pathname.startsWith("/state/")) {
      try {
        const path = url.pathname.slice(7);
        const separator = path.indexOf("/");
        if (separator < 0) throw new TypeError("Expected /state/:reducerHash/:key");
        const hash = path.slice(0, separator);
        const key = decodeURIComponent(path.slice(separator + 1));
        checkHash(hash);
        if (key.length > 1024) throw new TypeError("State key is too long");
        const value = storage.publicValue(hash, key);
        return value === undefined ? failure("Public state not found", 404) : json({ hash, key, value });
      } catch (error) { return failure(error); }
    }
    if (request.method === "POST" && (url.pathname === "/invoke" || url.pathname.startsWith("/invoke/"))) {
      try {
        const value = await body(request);
        const hash = url.pathname === "/invoke" ? value.hash : url.pathname.slice(8);
        if (typeof hash !== "string") throw new TypeError("hash must be a string");
        checkHash(hash);
        const fuel = value.fuel ?? DEFAULT_FUEL;
        if (!Number.isInteger(fuel) || (fuel as number) < 1 || (fuel as number) > MAX_FUEL) {
          throw new TypeError(`fuel must be an integer from 1 to ${MAX_FUEL}`);
        }
        let caller: string;
        try { caller = callerId(request); } catch (error) { return failure(error, 401); }
        const audience = request.headers.get("origin") ?? url.origin;
        return invoke(hash, value.input ?? null, fuel as number, caller, audience, value.authorization);
      } catch (error) { return failure(error); }
    }
    return failure("Not found", 404);
  },
});

console.log(`BOXOS listening on http://${HOST}:${PORT}`);
