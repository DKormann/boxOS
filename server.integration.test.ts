import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "fs/promises";
import { BoxOSError, BoxOSClient } from "./client.ts";
import { fullPageHash, pageHash, procHash } from "./hash.ts";
import { PersistentStorage, TransactionConflictError } from "./storage.ts";

const port = 41_000 + Math.floor(Math.random() * 10_000);
const origin = `http://localhost:${port}`;
const databasePath = `/tmp/boxos-${port}.sqlite`;
const bun = Bun.which("bun")!;
const environment = Object.fromEntries(
  Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
environment.PORT = String(port);
environment.BOXOS_DB_PATH = databasePath;
environment.PAGES_BASE_DOMAIN = "pages.test";
environment.PAGES_SCHEME = "http";
environment.POW_BASE_BITS = "0";

let server: ReturnType<typeof Bun.spawn>;
let persistentProcedure: { source: string; hash: string };
let persistentPage: { hash: string; html: string };

async function removeDatabase(path = databasePath): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

async function startServer(): Promise<void> {
  server = Bun.spawn({ cmd: [bun, "server.ts"], env: environment, stdout: "ignore", stderr: "inherit" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(20);
  }
  throw new Error("Test server did not start");
}

async function stopServer(): Promise<void> {
  server.kill();
  await server.exited;
}

async function rawProc(client: BoxOSClient, body: Record<string, unknown>): Promise<Record<string, any>> {
  return await fetch(`${origin}/proc`, {
    method: "POST",
    headers: { authorization: `Bearer ${client.identity}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(response => response.json()) as Record<string, any>;
}

beforeAll(async () => {
  await removeDatabase();
  await startServer();
});

afterAll(async () => {
  await stopServer();
  await removeDatabase();
});

describe("boxOS HTTP server", () => {
  test("serves the example as a short content-addressed page", async () => {
    const redirect = await fetch(`${origin}/example`, { redirect: "manual" });
    const location = redirect.headers.get("location")!;
    expect(location).toMatch(/^http:\/\/[a-z2-7]{16}\.pages\.test\/$/);
    const hostname = new URL(location).hostname;
    const response = await fetch(`${origin}/`, { headers: { host: hostname } });
    const body = await response.text();
    expect(body).toContain("<title>boxOS example</title>");
    expect(await fetch(`${origin}/`, { headers: { host: `${fullPageHash(body)}.pages.test` } }).then(value => value.text())).toBe(body);
  });

  test("serves docs and the compiled browser client", async () => {
    const docs = await fetch(`${origin}/docs`);
    expect(await docs.text()).toContain("boxOS client documentation");
    const client = await fetch(`${origin}/client.js`, { headers: { origin: "https://client.example" } });
    expect(client.headers.get("access-control-allow-origin")).toBe("*");
    expect(await client.text()).toContain("class BoxOSClient");
  });

  test("requires an anonymous bearer identity", async () => {
    const response = await fetch(`${origin}/balance`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("identity_required");
  });

  test("mints and persists a per-user fuel balance", async () => {
    const client = new BoxOSClient(origin);
    expect(await client.balance()).toBe(0);
    expect(await client.fund(250)).toBe(250);
    expect(await client.balance()).toBe(250);
  });

  test("automatically funds, registers, and invokes global procedure state", async () => {
    const first = new BoxOSClient(origin);
    const second = new BoxOSClient(origin);
    const source = `
      let count = +(ctx.load("count") || "0");
      count += 1;
      ctx.store("count", String(count));
      return count;
    `;
    expect(await first.proc<number>(source).invoke("", { fuel: 100 })).toBe(1);
    expect(await second.proc<number>(source).invoke("", { fuel: 100 })).toBe(2);
    expect(await first.inspect(await first.hash(source))).toBe(source);
    persistentProcedure = { source, hash: await first.hash(source) };
  }, 20_000);

  test("refunds unused fuel after a successful commit", async () => {
    const client = new BoxOSClient(origin);
    const source = "return arg;";
    await client.register(source);
    await client.ensureFuel(100);
    const before = await client.balance();
    const response = await rawProc(client, { invoke: procHash(source), arg: "ok", fuel: 100 });
    expect(response.ok).toBe("ok");
    expect(response.fuel.reserved).toBe(100);
    expect(response.fuel.refunded > 0).toBe(true);
    expect(response.fuel.spent + response.fuel.refunded).toBe(100);
    expect(await client.balance()).toBe(response.balance);
    expect(response.balance > before - 100).toBe(true);
  });

  test("does not refund failed transactions", async () => {
    const client = new BoxOSClient(origin);
    const source = 'ctx.store("dirty", "yes"); throw "failed";';
    await client.register(source);
    await client.ensureFuel(40);
    const before = await client.balance();
    const response = await rawProc(client, { invoke: procHash(source), arg: "", fuel: 40 });
    expect(response.error).toContain("failed");
    expect(await client.balance()).toBe(before - 40);
  });

  test("rewards deletion only after a successful commit", async () => {
    const client = new BoxOSClient(origin);
    const source = `
      if (arg == "delete") { ctx.delete("value"); return "deleted"; }
      ctx.store("value", "stored"); return "stored";
    `;
    await client.register(source);
    await client.ensureFuel(100);
    await rawProc(client, { invoke: procHash(source), arg: "store", fuel: 30 });
    await client.ensureFuel(30);
    const deleted = await rawProc(client, { invoke: procHash(source), arg: "delete", fuel: 30 });
    expect(deleted.ok).toBe("deleted");
    expect(deleted.fuel.deletionReward > 0).toBe(true);
  });

  test("detects optimistic conflicts using per-key versions", async () => {
    const path = `/tmp/boxos-occ-${port}.sqlite`;
    await removeDatabase(path);
    const database = new PersistentStorage(path);
    database.fund("a", 10);
    database.fund("b", 10);
    database.commitInvocation("a", [{ procedureHash: "p", key: "k", version: null }], [
      { type: "store", procedureHash: "p", key: "k", value: "first" },
    ], 0);
    let conflict = false;
    try {
      database.commitInvocation("b", [{ procedureHash: "p", key: "k", version: null }], [
        { type: "store", procedureHash: "p", key: "k", value: "second" },
      ], 10);
    } catch (error) {
      conflict = error instanceof TransactionConflictError;
    }
    expect(conflict).toBe(true);
    expect(database.balance("b")).toBe(10);
    await removeDatabase(path);
  });

  test("rolls back the complete nested call tree", async () => {
    const client = new BoxOSClient(origin);
    const callee = 'ctx.store("value", "dirty"); throw "nested failure";';
    await client.register(callee);
    const caller = `ctx.invoke("${procHash(callee)}", arg); return "ignored";`;
    await client.register(caller);
    await client.ensureFuel(100);
    const result = await rawProc(client, { invoke: procHash(caller), arg: "", fuel: 100 });
    expect(result.error).toContain("nested failure");
  });

  test("supports the common procedure language capabilities", async () => {
    const client = new BoxOSClient(origin);
    const source = `
      var value = JSON.parse(arg).value;
      try { if (value == 9) throw Math.floor(Math.sqrt(value)); }
      catch (error) { return String(error); }
      finally { value = 0; }
    `;
    expect(await client.proc<string>(source).invoke('{"value":"9"}', { fuel: 100 })).toBe("3");
  });

  test("publishes and renews a paid content-addressed page", async () => {
    const client = new BoxOSClient(origin);
    const html = '<!doctype html><title>Published</title><script>document.body.append(" works")</script>';
    const first = await client.publish(html);
    expect(first.hash).toBe(pageHash(html));
    expect(first.hash).toMatch(/^[a-z2-7]{16}$/);
    const response = await fetch(`${origin}/`, { headers: { host: `${first.hash}.pages.test` } });
    expect(await response.text()).toBe(html);
    const renewed = await client.publish(html);
    expect(renewed.hash).toBe(first.hash);
    expect(renewed.expiresAt > first.expiresAt).toBe(true);
    persistentPage = { hash: first.hash, html };
  }, 20_000);

  test("persists balances, global procedure state, and pages across restart", async () => {
    const client = new BoxOSClient(origin);
    await client.fund(50);
    const before = await client.balance();
    await stopServer();
    await startServer();
    expect(await client.balance()).toBe(before);
    expect(await client.inspect(persistentProcedure.hash)).toBe(persistentProcedure.source);
    const page = await fetch(`${origin}/`, { headers: { host: `${persistentPage.hash}.pages.test` } });
    expect(await page.text()).toBe(persistentPage.html);
  });
});
