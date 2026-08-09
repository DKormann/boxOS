import { expect, test } from "bun:test";
import { APP_INSTALLS_REDUCER_HASH } from "../src/userspace/app-installs.ts";
import { APP_PUBLISHER_REDUCER_HASH } from "../src/userspace/app-publisher.ts";
import { FRIENDS_REDUCER_HASH } from "../src/userspace/friends.ts";
import { PROFILE_REDUCER_HASH } from "../src/userspace/profile.ts";
import { STARTUP_REDUCER_HASH } from "../src/userspace/startup.ts";
import { TODO_REDUCER_HASH } from "../src/userspace/todo.ts";
import { createSignedAccount, startServer } from "./helpers.ts";

test("userspace reducers derive ownership from signed capabilities", async () => {
  const server = await startServer();
  try {
    const account = await createSignedAccount(server);

    const todoAuthorization = await account.authorization(TODO_REDUCER_HASH, ["todo:manage"], "Test todos");
    const forged = await server.invoke(TODO_REDUCER_HASH, { action: "add", id: "1", text: "forged", account: account.id });
    expect(forged.status).toBe(422);
    const added = await server.invoke(TODO_REDUCER_HASH, { action: "add", id: "1", text: "real" }, todoAuthorization);
    expect(added.status).toBe(200);
    const wrongAudience = await server.invoke(TODO_REDUCER_HASH, { action: "list" }, todoAuthorization, "https://evil.example");
    expect(wrongAudience.status).toBe(422);

    const profileAuthorization = await account.authorization(PROFILE_REDUCER_HASH, ["profile:write"], "Edit profile");
    const profile = await server.invoke(PROFILE_REDUCER_HASH, {
      action: "set", account: "0".repeat(64), name: "Alice", bio: "Hello",
    }, profileAuthorization).then(response => response.json()) as { ok: { account: string; name: string } };
    expect(profile.ok.account).toBe(account.id);
    expect(profile.ok.name).toBe("Alice");

    const startupAuthorization = await account.authorization(STARTUP_REDUCER_HASH, ["startup:manage"], "Manage startup");
    const empty = await server.invoke(STARTUP_REDUCER_HASH, { action: "get" }, startupAuthorization)
      .then(response => response.json()) as { ok: null };
    expect(empty.ok).toBe(null);
    const pageId = "abcdefghijklmnop";
    await server.invoke(STARTUP_REDUCER_HASH, { action: "set", pageId, account: "0".repeat(64) }, startupAuthorization);
    const startup = await server.invoke(STARTUP_REDUCER_HASH, { action: "get" }, startupAuthorization)
      .then(response => response.json()) as { ok: string };
    expect(startup.ok).toBe(pageId);

    const friendsAuthorization = await account.authorization(FRIENDS_REDUCER_HASH, ["friends:manage"], "Manage friends");
    const friend = "f".repeat(64);
    await server.invoke(FRIENDS_REDUCER_HASH, {
      action: "change", relation: "follow", target: friend, enabled: true, account: "0".repeat(64),
    }, friendsAuthorization);
    const following = await fetch(`${server.origin}/state/${FRIENDS_REDUCER_HASH}/following:${account.id}`)
      .then(response => response.json()) as { value: string[] };
    expect(following.value[0]).toBe(friend);
  } finally {
    await server.stop();
  }
}, 10_000);

test("publishing and installations remain independent", async () => {
  const server = await startServer();
  try {
    const account = await createSignedAccount(server);
    const appId = "abcdefghijklmnop";
    const nextPageId = "qrstuvwxyz234567";
    const publishAuthorization = await account.authorization(APP_PUBLISHER_REDUCER_HASH, ["apps:publish"], "Publish app");
    const app = await server.invoke(APP_PUBLISHER_REDUCER_HASH, {
      action: "publish", appId, pageId: appId, name: "Example", authorId: "0".repeat(64),
    }, publishAuthorization).then(response => response.json()) as { ok: { authorId: string } };
    expect(app.ok.authorId).toBe(account.id);

    const release = await server.invoke(APP_PUBLISHER_REDUCER_HASH, {
      action: "release", appId, pageId: nextPageId,
    }, publishAuthorization).then(response => response.json()) as { ok: { release: number; pageId: string } };
    expect(release.ok.release).toBe(2);
    expect(release.ok.pageId).toBe(nextPageId);

    await server.invoke(APP_PUBLISHER_REDUCER_HASH, { action: "unpublish", appId }, publishAuthorization);
    const tombstone = await fetch(`${server.origin}/state/${APP_PUBLISHER_REDUCER_HASH}/unpublished:${appId}`)
      .then(response => response.json()) as { value: boolean };
    expect(tombstone.value).toBe(true);
    await server.invoke(APP_PUBLISHER_REDUCER_HASH, { action: "republish", appId }, publishAuthorization);

    const installAuthorization = await account.authorization(APP_INSTALLS_REDUCER_HASH, ["apps:install"], "Install apps");
    for (let attempt = 0; attempt < 2; attempt++) {
      const installed = await server.invoke(APP_INSTALLS_REDUCER_HASH, { action: "install", appId }, installAuthorization);
      expect(installed.status).toBe(200);
    }
    const count = await fetch(`${server.origin}/state/${APP_INSTALLS_REDUCER_HASH}/installs:${appId}`)
      .then(response => response.json()) as { value: number };
    expect(count.value).toBe(1);
    const uninstalled = await server.invoke(APP_INSTALLS_REDUCER_HASH, { action: "uninstall", appId }, installAuthorization)
      .then(response => response.json()) as { ok: { installs: number; installed: string[] } };
    expect(uninstalled.ok.installs).toBe(0);
    expect(uninstalled.ok.installed).toHaveLength(0);
  } finally {
    await server.stop();
  }
}, 10_000);
