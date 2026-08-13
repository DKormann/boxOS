const development = Bun.argv.includes("--dev");

// Keep production startup plain while making `--dev` the single opt-in for Bun's
// process-level hot reload. The marker prevents the hot child from spawning again.
if (development && Bun.env.BOXOS_HOT_CHILD !== "1") {
  console.log("BOXOS development mode: hot reload enabled");
  const child = Bun.spawn(["bun", "--hot", Bun.main, "--dev"], {
    env: { ...Bun.env, BOXOS_HOT_CHILD: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  Bun.exit(await child.exited);
}


const api = "/0.3.0";
const runtime = "boxos-js/0.3.0";
const database = new Bun.SQL(Bun.env.BOXOS_DB_URL ?? "sqlite://boxos.sqlite", {
  max: 1,
});

await database`
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS boxes (
    id TEXT PRIMARY KEY,
    definition TEXT NOT NULL UNIQUE
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id)
  )
`;
await database`
  CREATE TABLE IF NOT EXISTS examples (
    name TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages(id)
  )
`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function digest(kind: "blob" | "box" | "page", bytes: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(`BOXOS:${kind.toUpperCase()}:0.3.0\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

async function identifier(kind: "blob" | "box", bytes: Uint8Array): Promise<string> {
  const hash = await digest(kind, bytes);
  return `${kind}_${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function storeBlob(bytes: Uint8Array): Promise<string> {
  const id = await identifier("blob", bytes);
  await database`INSERT OR IGNORE INTO blobs (id, bytes) VALUES (${id}, ${bytes})`;
  const stored = (await database`SELECT bytes FROM blobs WHERE id = ${id}`)[0]?.bytes;
  if (!(stored instanceof Uint8Array) || stored.length !== bytes.length || stored.some((byte, index) => byte !== bytes[index])) {
    throw new Error("Blob identifier collision");
  }
  return id;
}

async function createBlob(request: Request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const id = await storeBlob(bytes);
  return json({ id, bytes: bytes.length }, 201);
}

async function getBlob(id: string, head: boolean): Promise<Response> {
  const rows = await database`SELECT bytes FROM blobs WHERE id = ${id}`;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "blob_not_found", "Blob not found");
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(head ? null : body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function createBox(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }

  if (!isRecord(value) || Object.keys(value).some(key => !["runtime", "instance", "methods"].includes(key))) {
    return problem(400, "invalid_box", "A box may contain only runtime, instance, and methods");
  }
  if (value.runtime !== runtime) {
    return problem(400, "unsupported_runtime", `Runtime must be ${runtime}`);
  }
  if (typeof value.instance !== "string" || value.instance.length < 1 || value.instance.length > 128) {
    return problem(400, "invalid_instance", "Instance must be a non-empty string of at most 128 characters");
  }
  if (!isRecord(value.methods) || Object.keys(value.methods).length < 1 || Object.keys(value.methods).length > 128) {
    return problem(400, "invalid_methods", "Methods must contain between 1 and 128 entries");
  }

  for (const [name, method] of Object.entries(value.methods)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !isRecord(method) || Object.keys(method).length !== 1 || typeof method.blob !== "string") {
      return problem(400, "invalid_method", `Invalid method: ${name}`);
    }
    const rows = await database`SELECT 1 AS found FROM blobs WHERE id = ${method.blob}`;
    if (!rows[0]) return problem(400, "blob_not_found", `Method ${name} references a missing blob`);
  }

  // Property order is intentionally significant: BOXOS 0.3.0 uses plain JSON.stringify.
  const definition = JSON.stringify(value);
  const id = await identifier("box", new TextEncoder().encode(definition));
  await database`INSERT OR IGNORE INTO boxes (id, definition) VALUES (${id}, ${definition})`;
  const stored = (await database`SELECT definition FROM boxes WHERE id = ${id}`)[0]?.definition;
  if (stored !== definition) return problem(409, "hash_collision", "Box identifier collision");
  return json({ id, definition: value }, 201);
}

async function getBox(id: string): Promise<Response> {
  const rows = await database`SELECT definition FROM boxes WHERE id = ${id}`;
  if (typeof rows[0]?.definition !== "string") return problem(404, "box_not_found", "Box not found");
  return json({ id, definition: JSON.parse(rows[0].definition) });
}

async function hostPage(blobId: string): Promise<{ id: string; blob: string; origin: string; fuel: number; created: boolean } | Response> {
  const rows = await database`SELECT bytes FROM blobs WHERE id = ${blobId}`;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "blob_not_found", "Blob not found");
  if (bytes.length === 0) return problem(400, "invalid_page", "A hosted page cannot be empty");

  // The first 20 digest bytes encode to exactly 32 lowercase base32 characters.
  const id = base32((await digest("page", bytes)).slice(0, 20));
  const insertion = await database`
    INSERT INTO pages (id, blob_id) VALUES (${id}, ${blobId})
    ON CONFLICT DO NOTHING RETURNING id
  `;
  const stored = (await database`SELECT blob_id FROM pages WHERE id = ${id}`)[0]?.blob_id;
  if (stored !== blobId) {
    return problem(409, "page_id_collision", "The shortened page identifier is already in use");
  }

  const created = insertion.length === 1;
  return {
    id,
    blob: blobId,
    origin: `https://${id}.boxos.org`,
    fuel: created ? 100_000 + bytes.length * 100 : 1_000,
    created,
  };
}

async function createPage(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.blob !== "string") {
    return problem(400, "invalid_page", "A page request must contain one blob field");
  }
  const result = await hostPage(value.blob);
  return result instanceof Response ? result : json(result, result.created ? 201 : 200);
}

async function servePage(id: string, head: boolean): Promise<Response> {
  const rows = await database`
    SELECT blobs.bytes AS bytes
    FROM pages JOIN blobs ON blobs.id = pages.blob_id
    WHERE pages.id = ${id}
  `;
  const bytes = rows[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) return problem(404, "page_not_found", "Hosted page not found");
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(head ? null : body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

function hostedPageId(request: Request): string | undefined {
  const host = (request.headers.get("host") ?? new URL(request.url).hostname).toLowerCase().split(":")[0];
  const match = /^([a-z2-7]{32})\.(?:boxos\.org|localhost)$/.exec(host);
  return match?.[1];
}

async function publishExamples(): Promise<Record<string, string>> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob("*.html").scan("examples")) paths.push(path);
  paths.sort();

  // The example index mirrors the folder; immutable blobs and pages remain retained.
  await database`DELETE FROM examples`;
  const published: Record<string, string> = {};
  for (const path of paths) {
    const name = path.slice(0, -".html".length);
    const file = Bun.file(`examples/${path}`);
    const blob = await storeBlob(new Uint8Array(await file.arrayBuffer()));
    const page = await hostPage(blob);
    if (page instanceof Response) throw new Error(`Could not publish example page: ${name}`);
    await database`
      INSERT INTO examples (name, page_id) VALUES (${name}, ${page.id})
      ON CONFLICT (name) DO UPDATE SET page_id = excluded.page_id
    `;
    published[name] = page.origin;
  }

  return published;
}

async function listExamples(request: Request): Promise<Response> {
  const rows = await database`SELECT name, page_id FROM examples ORDER BY name`;
  const requestUrl = new URL(request.url);
  const port = requestUrl.port ? `:${requestUrl.port}` : "";
  return json({
    examples: rows.map(row => ({
      name: row.name,
      url: `https://${row.page_id}.boxos.org`,
      localUrl: `${requestUrl.protocol}//${row.page_id}.localhost${port}`,
    })),
  });
}

const examplePages = await publishExamples();

function staticFile(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development,
  maxRequestBodySize: 10 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const pageId = hostedPageId(request);

    if (pageId && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return await servePage(pageId, request.method === "HEAD");
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      const aboutId = new URL(examplePages.about).hostname.split(".")[0];
      const response = await servePage(aboutId, request.method === "HEAD");
      response.headers.set("cache-control", "no-cache");
      response.headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.headers.set("referrer-policy", "no-referrer");
      return response;
    }
    if (request.method === "GET" && url.pathname === "/client.js") {
      return staticFile("public/client.js", "text/javascript; charset=utf-8");
    }
    try {
      if (request.method === "POST" && url.pathname === `${api}/blobs`) return await createBlob(request);
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith(`${api}/blobs/`)) {
        return await getBlob(url.pathname.slice(`${api}/blobs/`.length), request.method === "HEAD");
      }
      if (request.method === "POST" && url.pathname === `${api}/boxes`) return await createBox(request);
      if (request.method === "GET" && url.pathname.startsWith(`${api}/boxes/`)) {
        return await getBox(url.pathname.slice(`${api}/boxes/`.length));
      }
      if (request.method === "POST" && url.pathname === `${api}/pages`) return await createPage(request);
      if (request.method === "GET" && url.pathname === `${api}/examples`) return await listExamples(request);
    } catch (error) {
      console.error(error);
      return problem(500, "internal_error", "The server could not complete the request");
    }

    return problem(404, "not_found", "Route not found");
  },
});

console.log(`BOXOS 0.3.0 listening on ${server.url}${development ? " (development)" : ""}`);
for (const [name, url] of Object.entries(examplePages)) {
  const id = new URL(url).hostname.split(".")[0];
  console.log(`Example ${name}: ${url}`);
  console.log(`Example ${name} (local): http://${id}.localhost:${server.url.port}`);
}
