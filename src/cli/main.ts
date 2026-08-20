#!/usr/bin/env node

import { Buffer } from "node:buffer"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"
import process from "node:process"
import { validateBoxDefinition, type BoxDefinition } from "../core/box-definition.ts"
import { stringifyBoxValue, type BoxValue } from "../core/values.ts"

/** BoxOS dependency-free command-line client. Requires Node.js 20+ or Bun. */
const crypto = globalThis.crypto

const VERSION = "0.2.0";
const encoder = new TextEncoder();

type Identity = { account: string; privateKey: CryptoKey }
type Deployment = { path: string; id: string }
type ErrorWithCode = Error & { code?: string }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function help(): string {
  return `BoxOS CLI ${VERSION}

Usage:
  boxos [--url URL] [--key FILE] <command>

Accounts:
  account create [--force]             Create and save an Ed25519 account
  account show                         Print the current account ID

Publish and invoke:
  box publish <definition.json>        Link and publish a box dependency graph
  box instantiate <definition-id> [JSON|@file|-]
                                        Create a box with independent storage
  blob publish <file> [--content-type TYPE]
  page publish <html-file>             Link boxes and publish an HTML page
  invoke <box-id> <method> [JSON|@file|-]
  transfer <receiver-account> <amount>
  message <client-id> <JSON|@file|->

Read:
  startup
  health
  box get <box-id>
  storage get <box-id> <key>
  blob get <blob-id>
  page get <page-id>

Configuration:
  --url URL       BoxOS server (default: BOXOS_URL or https://boxos.org)
  --key FILE      Account file (default: BOXOS_KEY or ~/.boxos/account.json)
  --help           Show this help
  --version        Show the CLI version

Box and page publication resolves {{BOXOS_BOX:./relative.box.json}} links and
validates the complete graph locally before publishing. All successful commands
emit one JSON value on stdout. Errors go to stderr and exit non-zero.

Examples:
  boxos account create
  boxos box publish ./counter.box.json
  boxos invoke <box-id> increment '{"amount":1}'
  boxos page publish ./index.html
`;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function canonical(value: BoxValue): BoxValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key]!) ]));
  }
  return value;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value");
  return Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16));
}

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

function bytesFromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function configuredUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("BoxOS URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("BoxOS URL cannot contain credentials");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function defaultKeyPath() {
  return process.env.BOXOS_KEY || resolve(homedir(), ".boxos", "account.json");
}

async function createIdentity(path: string, force: boolean): Promise<{ account: string; keyFile: string }> {
  if (!force) {
    try {
      await readFile(path, "utf8");
      throw new Error(`Account already exists at ${path}; pass --force to replace it`);
    } catch (error) {
      if ((error as ErrorWithCode)?.code !== "ENOENT") throw error;
    }
  }
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const account = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const privateKey = base64(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const document = `${JSON.stringify({ version: 1, account, privateKey }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, document, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return { account, keyFile: path };
}

async function loadIdentity(path: string): Promise<Identity> {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as ErrorWithCode)?.code === "ENOENT") throw new Error(`No account at ${path}; run 'boxos account create'`);
    throw new Error(`Cannot read account ${path}: ${message(error)}`);
  }
  if (parsed?.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.account) || typeof parsed.privateKey !== "string") {
    throw new Error(`Invalid BoxOS account file ${path}`);
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    bytesFromBase64(parsed.privateKey) as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(parsed.account) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const proof = encoder.encode("boxos-cli-key-check");
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, proof);
  if (!await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, proof)) {
    throw new Error(`Private key does not match account in ${path}`);
  }
  return { account: parsed.account, privateKey };
}

async function signed(identity: Identity, purpose: string, request: BoxValue) {
  const message = `${purpose}\n${JSON.stringify(canonical(request))}`;
  const signature = hex(await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.privateKey,
    encoder.encode(message),
  ));
  return { account: identity.account, signature, request };
}

async function responseValue(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (contentType.includes("json")) {
    try { return JSON.parse(text); } catch { /* report the raw response below */ }
  }
  return text;
}

async function request(baseUrl: URL, path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), options);
  const value = await responseValue(response);
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value ? value.error : value;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${response.status}: ${JSON.stringify(detail)}`);
  }
  return value;
}

async function postSigned(
  baseUrl: URL,
  identity: Identity,
  path: string,
  purpose: string,
  body: BoxValue,
): Promise<Record<string, BoxValue>> {
  return await request(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await signed(identity, purpose, body)),
  }) as Record<string, BoxValue>;
}

async function operation(baseUrl: URL, identity: Identity, value: BoxValue): Promise<Record<string, BoxValue>> {
  return postSigned(baseUrl, identity, "/v1/operations", "boxos.operation.v1", {
    nonce: crypto.randomUUID(),
    operation: value,
  });
}

async function stdin(): Promise<string> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function jsonArgument(value: string | undefined, fallback: BoxValue = null): Promise<BoxValue> {
  if (value === undefined) return fallback;
  const source = value === "-"
    ? await stdin()
    : value.startsWith("@")
      ? await readFile(resolve(value.slice(1)), "utf8")
      : value;
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Invalid JSON input: ${message(error)}`); }
}

function contentType(path: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
  })[extname(path).toLowerCase()] || "text/plain; charset=utf-8";
}

function pageUrl(pageId: string): string {
  return `https://${pageId}.boxos.org/`;
}

function boxLinker(baseUrl: URL, identity: Identity) {
  type Prepared = Deployment & { absolute: string; definition: BoxDefinition }
  const prepared = new Map<string, Prepared>()
  const boxes: Deployment[] = []

  async function hash(text: string): Promise<string> {
    return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
  }

  async function link(source: string, directory: string, stack: string[]): Promise<string> {
    let linked = ""
    let offset = 0
    const markers = [...source.matchAll(/\{\{BOXOS_BOX:([^{}\r\n]+)\}\}/g)]
    for (const match of markers) {
      const reference = match[1]!.trim()
      if (!reference || isAbsolute(reference)) {
        throw new Error(`Box links must use relative paths: ${JSON.stringify(reference)}`)
      }
      const dependency = await prepare(resolve(directory, reference), stack)
      linked += source.slice(offset, match.index) + dependency.id
      offset = match.index! + match[0].length
    }
    linked += source.slice(offset)
    if (linked.includes("{{BOXOS_BOX:")) throw new Error("Invalid BOXOS_BOX link")
    return linked
  }

  async function prepare(path: string, stack: string[] = []): Promise<Prepared> {
    const absolute = resolve(path)
    const existing = prepared.get(absolute)
    if (existing) return existing
    if (stack.includes(absolute)) {
      const cycle = [...stack.slice(stack.indexOf(absolute)), absolute]
        .map(item => relative(process.cwd(), item) || ".")
        .join(" -> ")
      throw new Error(`Circular box dependency: ${cycle}`)
    }

    let source: string
    try { source = await readFile(absolute, "utf8") }
    catch (error) { throw new Error(`Cannot read box definition ${absolute}: ${message(error)}`) }
    const linked = await link(source, dirname(absolute), [...stack, absolute])
    let parsed: unknown
    try { parsed = JSON.parse(linked) }
    catch (error) { throw new Error(`Invalid box definition ${absolute}: ${message(error)}`) }

    let definition: BoxDefinition
    try { definition = validateBoxDefinition(parsed) }
    catch (error) {
      throw new Error(`Invalid box definition ${relative(process.cwd(), absolute) || "."}: ${message(error)}`)
    }
    const result: Prepared = {
      absolute,
      path: relative(process.cwd(), absolute) || ".",
      definition,
      id: await hash(stringifyBoxValue(definition)),
    }
    prepared.set(absolute, result)
    return result
  }

  async function publishAll(): Promise<void> {
    for (const box of prepared.values()) {
      let result: Record<string, BoxValue>
      try {
        result = await postSigned(baseUrl, identity, "/v1/boxes", "boxos.publish-box.v1", {
          nonce: crypto.randomUUID(),
          definition: box.definition,
        })
      } catch (error) {
        throw new Error(`Cannot publish box ${box.path}: ${message(error)}`)
      }
      if (result["id"] !== box.id) throw new Error(`Server returned the wrong ID for ${box.path}`)
      boxes.push({ path: box.path, id: box.id })
    }
  }

  return {
    boxes,
    prepare,
    publishAll,
    linkPage(source: string, path: string) { return link(source, dirname(resolve(path)), []) },
  }
}

async function publishBox(baseUrl: URL, identity: Identity, file: string | undefined) {
  if (!file) throw new Error("box publish requires a definition file")
  const linker = boxLinker(baseUrl, identity)
  const box = await linker.prepare(file)
  await linker.publishAll()
  return { kind: "box", id: box.id, boxes: linker.boxes }
}

async function publishBlob(
  baseUrl: URL,
  identity: Identity,
  file: string | undefined,
  explicitType: string | undefined,
) {
  if (!file) throw new Error("blob publish requires a file");
  const path = resolve(file);
  const text = await readFile(path, "utf8");
  const result = await operation(baseUrl, identity, {
    type: "publishBlob",
    text,
    contentType: explicitType || contentType(path),
  });
  return { kind: "blob", id: result.id, contentType: explicitType || contentType(path) };
}

async function publishPage(baseUrl: URL, identity: Identity, file: string | undefined) {
  if (!file) throw new Error("page publish requires an HTML file")
  const path = resolve(file)
  const linker = boxLinker(baseUrl, identity)
  const text = await linker.linkPage(await readFile(path, "utf8"), path)
  await linker.publishAll()
  const blob = await operation(baseUrl, identity, {
    type: "publishBlob",
    text,
    contentType: "text/html; charset=utf-8",
  });
  const blobId = blob["id"]
  if (typeof blobId != "string") throw new Error("Blob publication returned no ID")
  const page = await operation(baseUrl, identity, { type: "publishPage", blobId })
  const pageId = page["id"]
  if (typeof pageId != "string") throw new Error("Page publication returned no ID")
  return { kind: "page", id: pageId, blobId, url: pageUrl(pageId), boxes: linker.boxes }
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    process.stdout.write(help());
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const baseUrl = configuredUrl(takeOption(args, "--url") || process.env.BOXOS_URL || "https://boxos.org/");
  const keyPath = resolve(takeOption(args, "--key") || defaultKeyPath());
  const contentTypeOption = takeOption(args, "--content-type");
  const force = takeFlag(args, "--force");
  const [first, second, ...rest] = args;
  if (!first) {
    process.stdout.write(help());
    return;
  }

  if (first === "account" && second === "create") {
    console.log(JSON.stringify(await createIdentity(keyPath, force)));
    return;
  }
  if (first === "account" && second === "show") {
    const identity = await loadIdentity(keyPath);
    console.log(JSON.stringify({ account: identity.account, keyFile: keyPath }));
    return;
  }
  if (force) throw new Error("--force is only valid with account create");
  if (contentTypeOption && !(first === "blob" && second === "publish")) {
    throw new Error("--content-type is only valid with blob publish");
  }

  if (first === "health") {
    console.log(JSON.stringify(await request(baseUrl, "/health")));
    return;
  }
  if (first === "startup") {
    console.log(JSON.stringify(await request(baseUrl, "/v1/startup")));
    return;
  }
  if (first === "box" && second === "get") {
    if (!rest[0]) throw new Error("box get requires a box ID");
    console.log(JSON.stringify(await request(baseUrl, `/v1/boxes/${encodeURIComponent(rest[0])}`)));
    return;
  }
  if (first === "storage" && second === "get") {
    if (!rest[0] || rest[1] === undefined) throw new Error("storage get requires a box ID and key");
    console.log(JSON.stringify(await request(baseUrl, `/v1/boxes/${encodeURIComponent(rest[0])}/storage/public?key=${encodeURIComponent(rest[1])}`)));
    return;
  }
  if (first === "blob" && second === "get") {
    if (!rest[0]) throw new Error("blob get requires a blob ID");
    const response = await fetch(new URL(`/v1/blobs/${encodeURIComponent(rest[0])}`, baseUrl));
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    console.log(JSON.stringify({ id: rest[0], contentType: response.headers.get("content-type"), text }));
    return;
  }
  if (first === "page" && second === "get") {
    if (!rest[0]) throw new Error("page get requires a page ID");
    const response = await fetch(new URL(`/v1/pages/${encodeURIComponent(rest[0])}`, baseUrl));
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    console.log(JSON.stringify({ id: rest[0], contentType: response.headers.get("content-type"), text }));
    return;
  }

  const identity = await loadIdentity(keyPath);
  if (first === "box" && second === "publish") {
    console.log(JSON.stringify(await publishBox(baseUrl, identity, rest[0])));
    return;
  }
  if (first === "box" && second === "instantiate") {
    const definitionId = rest[0]
    if (!definitionId) throw new Error("box instantiate requires a definition ID")
    const options = await jsonArgument(rest[1], {})
    if (options === null || Array.isArray(options) || typeof options != "object") {
      throw new Error("box instance options must be a JSON object")
    }
    console.log(JSON.stringify(await operation(baseUrl, identity, {
      ...options,
      type: "instantiateBox",
      definitionId,
      nonce: typeof options["nonce"] == "string" ? options["nonce"] : crypto.randomUUID(),
      initialPublic: options["initialPublic"] ?? {},
      initialPrivate: options["initialPrivate"] ?? {},
    })))
    return;
  }
  if (first === "blob" && second === "publish") {
    console.log(JSON.stringify(await publishBlob(baseUrl, identity, rest[0], contentTypeOption)));
    return;
  }
  if (first === "page" && second === "publish") {
    console.log(JSON.stringify(await publishPage(baseUrl, identity, rest[0])));
    return;
  }
  if (first === "invoke") {
    if (!second || !rest[0]) throw new Error("invoke requires a box ID and method");
    const input = await jsonArgument(rest[1], null);
    const invocation = { nonce: crypto.randomUUID(), boxId: second, method: rest[0], input, clientId: null };
    const result = await postSigned(baseUrl, identity, "/v1/invoke", "boxos.invoke.v1", invocation);
    console.log(JSON.stringify(result));
    return;
  }
  if (first === "transfer") {
    if (!second || !rest[0]) throw new Error("transfer requires a receiver account and amount");
    const amount = Number(rest[0]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Transfer amount must be a positive integer");
    console.log(JSON.stringify(await operation(baseUrl, identity, { type: "transfer", receiver: second, amount })));
    return;
  }
  if (first === "message") {
    if (!second || rest[0] === undefined) throw new Error("message requires a client ID and JSON value");
    console.log(JSON.stringify(await operation(baseUrl, identity, {
      type: "message",
      clientId: second,
      message: await jsonArgument(rest[0]),
    })));
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}\nRun with --help for usage.`);
}

main().catch(error => {
  console.error(`boxos: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
