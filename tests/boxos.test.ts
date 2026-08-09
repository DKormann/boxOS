import { expect, test } from "bun:test";
import { APP_INSTALLS_REDUCER_CODE, APP_INSTALLS_REDUCER_HASH } from "../src/app-installs.ts";
import { APP_PUBLISHER_REDUCER_CODE, APP_PUBLISHER_REDUCER_HASH } from "../src/app-publisher.ts";
import { COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH } from "../src/counter.ts";
import { FRIENDS_REDUCER_CODE, FRIENDS_REDUCER_HASH } from "../src/friends.ts";
import { rm } from "fs/promises";
import { procHash } from "../src/hash.ts";
import {
  IDENTITY_PROCEDURE_CODE,
  IDENTITY_PROCEDURE_HASH,
  IDENTITY_REDUCER_CODE,
  IDENTITY_REDUCER_HASH,
} from "../src/identity.ts";
import { PAGE_REDUCER_CODE, PAGE_REDUCER_HASH } from "../src/page.ts";
import { analyzeProcCode, isValidProcCode, validateProcCode } from "../src/parser.ts";
import { PROFILE_REDUCER_CODE, PROFILE_REDUCER_HASH } from "../src/profile.ts";
import { INITIAL_USER_FUEL, Storage } from "../src/storage.ts";
import { STARTUP_REDUCER_CODE, STARTUP_REDUCER_HASH } from "../src/startup.ts";
import { TODO_REDUCER_CODE, TODO_REDUCER_HASH } from "../src/todo.ts";
import {
  PUBLISH_PROCEDURE_CODE,
  PUBLISH_PROCEDURE_HASH,
  VALIDATE_PROCEDURE_CODE,
  VALIDATE_PROCEDURE_HASH,
} from "../src/system-procedures.ts";

test("code addresses are SHA-256 digests", () => {
  expect(procHash("return input;")).toBe("4d3a5625145171d40ee827df41e201e99e24e3cf7a30adea9e36d84038dd310b");
});

test("the demo counter has a stable content address", () => {
  expect(COUNTER_REDUCER_HASH).toBe(procHash(COUNTER_REDUCER_CODE));
});

test("identity functions have stable content addresses", () => {
  expect(IDENTITY_REDUCER_HASH).toBe(procHash(IDENTITY_REDUCER_CODE));
  expect(IDENTITY_PROCEDURE_HASH).toBe(procHash(IDENTITY_PROCEDURE_CODE));
  const analysis = analyzeProcCode(IDENTITY_PROCEDURE_CODE, ["ctx", "input"], true);
  expect(analysis.references[0]).toBe(IDENTITY_REDUCER_HASH);
});

test("signed-account applications have stable content addresses", () => {
  expect(APP_INSTALLS_REDUCER_HASH).toBe(procHash(APP_INSTALLS_REDUCER_CODE));
  expect(APP_PUBLISHER_REDUCER_HASH).toBe(procHash(APP_PUBLISHER_REDUCER_CODE));
  expect(FRIENDS_REDUCER_HASH).toBe(procHash(FRIENDS_REDUCER_CODE));
  expect(PROFILE_REDUCER_HASH).toBe(procHash(PROFILE_REDUCER_CODE));
  expect(STARTUP_REDUCER_HASH).toBe(procHash(STARTUP_REDUCER_CODE));
  expect(TODO_REDUCER_HASH).toBe(procHash(TODO_REDUCER_CODE));
  validateProcCode(APP_INSTALLS_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
  validateProcCode(APP_PUBLISHER_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
  validateProcCode(FRIENDS_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
  validateProcCode(PROFILE_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
  validateProcCode(STARTUP_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
  validateProcCode(TODO_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
});

test("system procedures have stable content addresses", () => {
  expect(VALIDATE_PROCEDURE_HASH).toBe(procHash(VALIDATE_PROCEDURE_CODE));
  expect(PUBLISH_PROCEDURE_HASH).toBe(procHash(PUBLISH_PROCEDURE_CODE));
});

test("the page reducer has a stable content address", () => {
  expect(PAGE_REDUCER_HASH).toBe(procHash(PAGE_REDUCER_CODE));
  validateProcCode(PAGE_REDUCER_CODE, ["ctx", "input", "JSON", "Math", "String"]);
});

test("fuel is charged, refunded, and repaid to the deleting caller", async () => {
  const path = `/tmp/boxos-fuel-${crypto.randomUUID()}.sqlite`;
  const storage = new Storage(path);
  const code = "return input;";
  const registered = storage.registerCode("alice", procHash(code), "reducer", code);
  expect(registered.cost).toBe(new TextEncoder().encode(code).byteLength * 8);
  storage.reserveFuel("alice", 100);
  storage.creditFuel("alice", 90);
  const written = storage.commitState("alice", {
    reducer: { private: {}, public: { greeting: "hello" } },
  });
  expect(written.charged).toBe((8 + 7) * 8);
  const deleted = storage.commitState("bob", {});
  expect(deleted.repaid).toBe(written.charged);
  expect(deleted.balance).toBe(INITIAL_USER_FUEL + written.charged);
  storage.close();
  await rm(path, { force: true });
});

test("the parser finds literal code-hash references", () => {
  const hash = "4d3a5625145171d40ee827df41e201e99e24e3cf7a30adea9e36d84038dd310b";
  const analysis = analyzeProcCode(`// ${"a".repeat(64)}\nreturn ctx.invoke("${hash}", input);`, ["ctx", "input"]);
  expect(analysis.references[0]).toBe(hash);
  expect(analysis.references.length).toBe(1);
});

test("the restricted language separates reducer and procedure capabilities", () => {
  validateProcCode('ctx.state.private.set("value", input); return ctx.state.public.get("value");', ["ctx", "input"], false);
  validateProcCode("return await ctx.fetch(input);", ["ctx", "input"], true);
  expect(isValidProcCode("return globalThis.process;")).toBe(false);
});

test("signed capabilities cannot be forged as reducer input", async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const origin = `http://127.0.0.1:${port}`;
  const path = `/tmp/boxos-capability-${crypto.randomUUID()}.sqlite`;
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const base64Url = (value: ArrayBuffer): string => {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  const publicKey = base64Url(await crypto.subtle.exportKey("raw", keys.publicKey));
  const recovery = `boxos1.${base64Url(await crypto.subtle.exportKey("pkcs8", keys.privateKey))}.${publicKey}`;
  const child = Bun.spawn({
    cmd: [Bun.which("bun")!, "src/server.ts"],
    cwd: ".",
    env: { HOST: "127.0.0.1", PORT: String(port), BOXOS_DB_PATH: path, BOXOS_SYSTEM_RECOVERY_KEY: recovery },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
      await Bun.sleep(20);
    }
    const profileRedirect = await fetch(`${origin}/examples/profile?account=${"f".repeat(64)}`, { redirect: "manual" });
    expect(profileRedirect.headers.get("location")).toContain(`?account=${"f".repeat(64)}`);
    const stats = await fetch(`${origin}/stats`).then(response => response.json()) as {
      identities: { procedure: string };
      profiles: { reducer: string };
      startup: { reducer: string; root: string; tryPage: string };
      applications: {
        explorer: { installs: string; publisher: string };
        friends: { reducer: string };
        todo: { reducer: string };
      };
    };
    const homepage = await fetch(origin).then(response => response.text());
    const about = await fetch(`${origin}/about`).then(response => response.text());
    expect(homepage).toBe(about);
    expect(homepage).toContain("Try BOXOS");
    const tryBoxos = await fetch(`${origin}/start/try`, { redirect: "manual" });
    expect(tryBoxos.headers.get("location")).toContain(stats.startup.tryPage);
    const officialApps = await fetch(`${origin}/state/${stats.applications.explorer.publisher}/publish:counter`)
      .then(response => response.json()) as { value: number };
    expect(officialApps.value > 0).toBe(true);
    const headers = {
      authorization: `Bearer ${"A".repeat(43)}`,
      "content-type": "application/json",
      origin,
    };
    const registered = await fetch(`${origin}/invoke/${stats.identities.procedure}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "register", publicKey }, fuel: 1000 }),
    }).then(response => response.json()) as { ok: string };
    const grant = {
      version: 2, domain: "boxos-capability", account: registered.ok,
      audience: origin, resource: stats.applications.todo.reducer, capabilities: ["todo:manage"],
      purpose: "Test todos", grantId: crypto.randomUUID(),
    };
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    const signed = async (resource: string, capabilities: string[], purpose: string) => {
      const nextGrant = { ...grant, resource, capabilities, purpose, grantId: crypto.randomUUID() };
      const nextMessage = canonical(nextGrant);
      return {
        grant: nextGrant,
        message: nextMessage,
        signature: base64Url(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(nextMessage))),
        publicKey,
      };
    };
    const message = canonical(grant);
    const signature = base64Url(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message)));
    const authorization = { grant, message, signature, publicKey };
    const invoke = (body: unknown) => fetch(`${origin}/invoke/${stats.applications.todo.reducer}`, {
      method: "POST", headers, body: JSON.stringify({ fuel: 1000, ...body as object }),
    });

    const forged = await invoke({ input: { action: "add", id: "1", text: "forged", account: registered.ok } });
    expect(forged.status).toBe(422);
    const accepted = await invoke({ input: { action: "add", id: "1", text: "real" }, authorization });
    expect(accepted.status).toBe(200);
    const result = await accepted.json() as { ok: { text: string }[] };
    expect(result.ok[0]?.text).toBe("real");
    const wrongAudience = await fetch(`${origin}/invoke/${stats.applications.todo.reducer}`, {
      method: "POST", headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ input: { action: "list" }, authorization, fuel: 1000 }),
    });
    expect(wrongAudience.status).toBe(422);

    const profileGrant = {
      ...grant,
      resource: stats.profiles.reducer,
      capabilities: ["profile:write"],
      purpose: "Edit profile",
      grantId: crypto.randomUUID(),
    };
    const profileMessage = canonical(profileGrant);
    const profileAuthorization = {
      grant: profileGrant,
      message: profileMessage,
      signature: base64Url(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(profileMessage))),
      publicKey,
    };
    const profileResponse = await fetch(`${origin}/invoke/${stats.profiles.reducer}`, {
      method: "POST", headers,
      body: JSON.stringify({
        input: { action: "set", account: "0".repeat(64), name: "Alice", bio: "Hello" },
        authorization: profileAuthorization,
        fuel: 1000,
      }),
    });
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json() as { ok: { account: string; name: string } };
    expect(profile.ok.account).toBe(registered.ok);
    expect(profile.ok.name).toBe("Alice");

    const startupAuthorization = await signed(stats.startup.reducer, ["startup:manage"], "Manage startup");
    const emptyStartup = await fetch(`${origin}/invoke/${stats.startup.reducer}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "get" }, authorization: startupAuthorization, fuel: 1000 }),
    }).then(response => response.json()) as { ok: null };
    expect(emptyStartup.ok).toBe(null);
    const startupSet = await fetch(`${origin}/invoke/${stats.startup.reducer}`, {
      method: "POST", headers,
      body: JSON.stringify({
        input: { action: "set", pageId: stats.startup.tryPage, account: "0".repeat(64) },
        authorization: startupAuthorization,
        fuel: 1000,
      }),
    });
    expect(startupSet.status).toBe(200);
    const startupGet = await fetch(`${origin}/invoke/${stats.startup.reducer}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "get" }, authorization: startupAuthorization, fuel: 1000 }),
    }).then(response => response.json()) as { ok: string };
    expect(startupGet.ok).toBe(stats.startup.tryPage);

    const friendTarget = "f".repeat(64);
    const friendsGrant = {
      ...grant,
      resource: stats.applications.friends.reducer,
      capabilities: ["friends:manage"],
      purpose: "Manage friends",
      grantId: crypto.randomUUID(),
    };
    const friendsMessage = canonical(friendsGrant);
    const friendsAuthorization = {
      grant: friendsGrant,
      message: friendsMessage,
      signature: base64Url(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(friendsMessage))),
      publicKey,
    };
    const friendsResponse = await fetch(`${origin}/invoke/${stats.applications.friends.reducer}`, {
      method: "POST", headers,
      body: JSON.stringify({
        input: { action: "change", relation: "follow", target: friendTarget, enabled: true, account: "0".repeat(64) },
        authorization: friendsAuthorization,
        fuel: 1000,
      }),
    });
    expect(friendsResponse.status).toBe(200);
    const following = await fetch(`${origin}/state/${stats.applications.friends.reducer}/following:${registered.ok}`)
      .then(response => response.json()) as { value: string[] };
    expect(following.value[0]).toBe(friendTarget);

    const appId = "abcdefghijklmnop";
    const publishAuthorization = await signed(stats.applications.explorer.publisher, ["apps:publish"], "Publish app");
    const published = await fetch(`${origin}/invoke/${stats.applications.explorer.publisher}`, {
      method: "POST", headers,
      body: JSON.stringify({
        input: { action: "publish", appId, pageId: appId, name: "Example", authorId: "0".repeat(64) },
        authorization: publishAuthorization,
        fuel: 1000,
      }),
    });
    expect(published.status).toBe(200);
    const app = await published.json() as { ok: { authorId: string } };
    expect(app.ok.authorId).toBe(registered.ok);
    const nextPageId = "qrstuvwxyz234567";
    const released = await fetch(`${origin}/invoke/${stats.applications.explorer.publisher}`, {
      method: "POST", headers,
      body: JSON.stringify({
        input: { action: "release", appId, pageId: nextPageId, authorId: "0".repeat(64) },
        authorization: publishAuthorization,
        fuel: 1000,
      }),
    });
    const release = await released.json() as { ok: { pageId: string; release: number } };
    expect(release.ok.pageId).toBe(nextPageId);
    expect(release.ok.release).toBe(2);
    const unpublished = await fetch(`${origin}/invoke/${stats.applications.explorer.publisher}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "unpublish", appId }, authorization: publishAuthorization, fuel: 1000 }),
    });
    expect(unpublished.status).toBe(200);
    const tombstone = await fetch(`${origin}/state/${stats.applications.explorer.publisher}/unpublished:${appId}`)
      .then(response => response.json()) as { value: boolean };
    expect(tombstone.value).toBe(true);
    const republished = await fetch(`${origin}/invoke/${stats.applications.explorer.publisher}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "republish", appId }, authorization: publishAuthorization, fuel: 1000 }),
    });
    expect(republished.status).toBe(200);

    const installAuthorization = await signed(stats.applications.explorer.installs, ["apps:install"], "Install apps");
    for (let attempt = 0; attempt < 2; attempt++) {
      const installed = await fetch(`${origin}/invoke/${stats.applications.explorer.installs}`, {
        method: "POST", headers,
        body: JSON.stringify({ input: { action: "install", appId }, authorization: installAuthorization, fuel: 1000 }),
      });
      expect(installed.status).toBe(200);
    }
    const installs = await fetch(`${origin}/state/${stats.applications.explorer.installs}/installs:${appId}`)
      .then(response => response.json()) as { value: number };
    expect(installs.value).toBe(1);
    const uninstalled = await fetch(`${origin}/invoke/${stats.applications.explorer.installs}`, {
      method: "POST", headers,
      body: JSON.stringify({ input: { action: "uninstall", appId }, authorization: installAuthorization, fuel: 1000 }),
    });
    const uninstallResult = await uninstalled.json() as { ok: { installs: number; installed: string[] } };
    expect(uninstallResult.ok.installs).toBe(0);
    expect(uninstallResult.ok.installed).toHaveLength(0);
  } finally {
    child.kill();
    await child.exited;
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
}, 10_000);
