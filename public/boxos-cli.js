#!/usr/bin/env node

/** BoxOS dependency-free command-line client. Requires Node.js 20+ or Bun. */
const { chmod, mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, extname, resolve } = require("node:path");
const crypto = globalThis.crypto || require("node:crypto").webcrypto;

const VERSION = "0.1.0";
const encoder = new TextEncoder();

function help() {
  return `BoxOS CLI ${VERSION}

Usage:
  boxos [--url URL] [--key FILE] <command>

Accounts:
  account create [--force]             Create and save an Ed25519 account
  account show                         Print the current account ID

Publish and invoke:
  box publish <definition.json>        Publish a box definition
  blob publish <file> [--content-type TYPE]
  page publish <html-file>             Publish an HTML blob and page
  deploy page <html-file>              Alias for page publish
  deploy box <definition.json>         Alias for box publish
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

All successful commands emit one JSON value on stdout. Errors go to stderr and
exit non-zero, making the CLI suitable for scripts and coding agents.

Examples:
  boxos account create
  boxos box publish ./counter.box.json
  boxos invoke <box-id> increment '{"amount":1}'
  boxos deploy page ./index.html
`;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value) {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value");
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function bytesFromBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function configuredUrl(value) {
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

async function createIdentity(path, force) {
  if (!force) {
    try {
      await readFile(path, "utf8");
      throw new Error(`Account already exists at ${path}; pass --force to replace it`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
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

async function loadIdentity(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No account at ${path}; run 'boxos account create'`);
    throw new Error(`Cannot read account ${path}: ${error.message}`);
  }
  if (parsed?.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.account) || typeof parsed.privateKey !== "string") {
    throw new Error(`Invalid BoxOS account file ${path}`);
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    bytesFromBase64(parsed.privateKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(parsed.account),
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

async function signed(identity, purpose, request) {
  const message = `${purpose}\n${JSON.stringify(canonical(request))}`;
  const signature = hex(await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.privateKey,
    encoder.encode(message),
  ));
  return { account: identity.account, signature, request };
}

async function responseValue(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (contentType.includes("json")) {
    try { return JSON.parse(text); } catch { /* report the raw response below */ }
  }
  return text;
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), options);
  const value = await responseValue(response);
  if (!response.ok) {
    const detail = value && typeof value === "object" && "error" in value ? value.error : value;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${response.status}: ${JSON.stringify(detail)}`);
  }
  return value;
}

async function postSigned(baseUrl, identity, path, purpose, body) {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await signed(identity, purpose, body)),
  });
}

async function operation(baseUrl, identity, value) {
  return postSigned(baseUrl, identity, "/v1/operations", "boxos.operation.v1", {
    nonce: crypto.randomUUID(),
    operation: value,
  });
}

async function stdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function jsonArgument(value, fallback = null) {
  if (value === undefined) return fallback;
  const source = value === "-"
    ? await stdin()
    : value.startsWith("@")
      ? await readFile(resolve(value.slice(1)), "utf8")
      : value;
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Invalid JSON input: ${error.message}`); }
}

function contentType(path) {
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

function pageUrl(baseUrl, pageId) {
  const url = new URL(baseUrl);
  const labels = url.hostname.split(".");
  url.hostname = url.hostname === "127.0.0.1" || url.hostname === "localhost"
    ? `${pageId}.localhost`
    : [pageId, ...labels.slice(labels.length > 2 ? 1 : 0)].join(".");
  return url.href;
}

async function publishBox(baseUrl, identity, file) {
  if (!file) throw new Error("box publish requires a definition file");
  let definition;
  try { definition = JSON.parse(await readFile(resolve(file), "utf8")); }
  catch (error) { throw new Error(`Cannot read box definition: ${error.message}`); }
  const result = await postSigned(baseUrl, identity, "/v1/boxes", "boxos.publish-box.v1", {
    nonce: crypto.randomUUID(),
    definition,
  });
  return { kind: "box", id: result.id };
}

async function publishBlob(baseUrl, identity, file, explicitType) {
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

async function publishPage(baseUrl, identity, file) {
  if (!file) throw new Error("page publish requires an HTML file");
  const path = resolve(file);
  const text = await readFile(path, "utf8");
  const blob = await operation(baseUrl, identity, {
    type: "publishBlob",
    text,
    contentType: "text/html; charset=utf-8",
  });
  const page = await operation(baseUrl, identity, { type: "publishPage", blobId: blob.id });
  return { kind: "page", id: page.id, blobId: blob.id, url: pageUrl(baseUrl, page.id) };
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
  if ((first === "box" && second === "publish") || (first === "deploy" && second === "box")) {
    console.log(JSON.stringify(await publishBox(baseUrl, identity, rest[0])));
    return;
  }
  if (first === "blob" && second === "publish") {
    console.log(JSON.stringify(await publishBlob(baseUrl, identity, rest[0], contentTypeOption)));
    return;
  }
  if ((first === "page" && second === "publish") || (first === "deploy" && second === "page")) {
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
