import { rm } from "node:fs/promises";

test("serves the BOXOS homepage and rejects unknown paths", async () => {
  const port = String(41000 + Math.floor(Math.random() * 1000));
  const databasePath = `/tmp/boxos-${crypto.randomUUID()}.sqlite`;
  const cliConfigPath = `/tmp/boxos-cli-${crypto.randomUUID()}`;
  const slowServer = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(600);
      return new Response("slow response");
    },
  });
  const slowUrl = `http://localhost:${slowServer.port}/`;
  const process = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...Bun.env, PORT: port, BOXOS_DB_URL: `sqlite://${databasePath}` },
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    let homepage: Response | undefined;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        homepage = await fetch(`http://localhost:${port}/`);
        break;
      } catch {
        await Bun.sleep(25);
      }
    }

    expect(homepage).toBeDefined();
    expect(homepage?.status).toBe(200);
    expect(homepage?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(homepage?.headers.get("content-security-policy")).toContain("default-src 'none'");

    const html = await homepage?.text();
    expect(html).toContain("BOXOS");
    expect(html).toContain("Developer reference");
    expect(html).toContain("Baseline status");
    expect(html).toContain("BOXOS AGENTS: start here");
    expect(html).toContain("href=\"/AGENTS.md\"");

    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const accountResponse = await fetch(`http://localhost:${port}/0.3.0/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: publicJwk.x }),
    });
    expect(accountResponse.status).toBe(201);
    const account = await accountResponse.json();
    expect(account.publicKey).toBe(publicJwk.x);
    expect(account.fuel).toBe(1_000_000_000);
    expect(account.nonce).toBe(0);

    const repeatedAccount = await fetch(`http://localhost:${port}/0.3.0/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: publicJwk.x }),
    });
    expect(repeatedAccount.status).toBe(200);
    expect((await repeatedAccount.json()).created).toBe(false);

    const blob = await fetch(`http://localhost:${port}/0.3.0/blobs`, {
      method: "POST",
      body: "return input;",
    });
    expect(blob.status).toBe(201);
    const createdBlob = await blob.json();
    expect(createdBlob.id).toMatch(/^blob_[0-9a-f]{64}$/);

    const storedBlob = await fetch(`http://localhost:${port}/0.3.0/blobs/${createdBlob.id}`);
    expect(await storedBlob.text()).toBe("return input;");

    const htmlBlobResponse = await fetch(`http://localhost:${port}/0.3.0/blobs`, {
      method: "POST",
      body: "<!doctype html><title>Hosted</title><h1>Immutable page</h1>",
    });
    const htmlBlob = await htmlBlobResponse.json();
    const pageResponse = await fetch(`http://localhost:${port}/0.3.0/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: htmlBlob.id }),
    });
    expect(pageResponse.status).toBe(201);
    const page = await pageResponse.json();
    expect(page.id).toMatch(/^[a-z2-7]{32}$/);
    expect(page.origin).toBe(`https://${page.id}.boxos.org`);
    expect(page.created).toBe(true);
    expect(page.fuel).toBeGreaterThan(100_000);

    const repeatedPage = await fetch(`http://localhost:${port}/0.3.0/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: htmlBlob.id }),
    });
    expect(repeatedPage.status).toBe(200);
    expect((await repeatedPage.json()).created).toBe(false);

    const hostedPage = await fetch(`http://localhost:${port}/`, {
      headers: { host: `${page.id}.boxos.org` },
    });
    expect(hostedPage.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await hostedPage.text()).toContain("Immutable page");

    const hostedSubpath = await fetch(`http://localhost:${port}/other`, {
      headers: { host: `${page.id}.boxos.org` },
    });
    expect(hostedSubpath.status).toBe(404);

    const definition = {
      runtime: "boxos-js/0.3.0",
      instance: "test",
      methods: { echo: { blob: createdBlob.id } },
    };
    const box = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
    expect(box.status).toBe(201);
    const createdBox = await box.json();
    expect(createdBox.id).toMatch(/^box_[0-9a-f]{64}$/);
    expect(createdBox.definitionBlob).toMatch(/^blob_[0-9a-f]{64}$/);

    const definitionBlob = await fetch(`http://localhost:${port}/0.3.0/blobs/${createdBox.definitionBlob}`);
    expect(await definitionBlob.text()).toBe(JSON.stringify(definition));

    const storedBox = await fetch(`http://localhost:${port}/0.3.0/boxes/${createdBox.id}`);
    const inspectedBox = await storedBox.json();
    expect(inspectedBox.definitionBlob).toBe(createdBox.definitionBlob);
    expect(inspectedBox.definition).toEqual(definition);

    const repeatedBox = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
    expect(repeatedBox.status).toBe(200);
    expect((await repeatedBox.json()).id).toBe(createdBox.id);

    async function putSource(source: string) {
      const response = await fetch(`http://localhost:${port}/0.3.0/blobs`, { method: "POST", body: source });
      return await response.json();
    }
    const atomicBlob = await putSource("return ctx.atomic(function update(tx) { let value = tx.state.public.get(\"count\") || 0; tx.state.public.set(\"count\", value + 1); return value + 1; });");
    const commitThenFailBlob = await putSource("ctx.atomic(function update(tx) { tx.state.public.set(\"count\", 3); return null; }); throw \"failure after commit\";");
    const rollbackBlob = await putSource("try { ctx.atomic(function update(tx) { tx.state.public.set(\"temporary\", true); throw \"rollback\"; }); } catch (error) {} return ctx.atomic(function read(tx) { return tx.state.public.has(\"temporary\"); });");
    const nestedBlob = await putSource("return ctx.atomic(function outer(tx) { return ctx.atomic(function inner(other) { return null; }); });");
    const atomicBox = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "boxos-js/0.3.0",
        instance: "valid-atomic",
        methods: {
          increment: { blob: atomicBlob.id },
          commit_then_fail: { blob: commitThenFailBlob.id },
          rollback: { blob: rollbackBlob.id },
          nested: { blob: nestedBlob.id },
        },
      }),
    });
    expect(atomicBox.status).toBe(201);
    const createdAtomicBox = await atomicBox.json();

    async function invoke(method: string, nonce: number, box = createdAtomicBox.id, input: unknown = null) {
      const command = {
        publicKey: publicJwk.x,
        nonce,
        box,
        method,
        maxFuel: 1_000_000,
        input,
      };
      const domain = new TextEncoder().encode("BOXOS:INVOKE:0.3.0\0");
      const body = new TextEncoder().encode(JSON.stringify(command));
      const message = new Uint8Array(domain.length + body.length);
      message.set(domain);
      message.set(body, domain.length);
      const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, message.buffer as ArrayBuffer));
      let binary = "";
      for (const byte of signatureBytes) binary += String.fromCharCode(byte);
      const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return fetch(`http://localhost:${port}/0.3.0/invocations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, signature }),
      });
    }

    const firstInvocation = await invoke("increment", 0);
    expect(firstInvocation.status).toBe(200);
    const firstResult = await firstInvocation.json();
    expect(firstResult.result).toBe(1);
    expect(firstResult.receipt.nonce).toBe(1);

    const secondInvocation = await invoke("increment", 1);
    expect(secondInvocation.status).toBe(200);
    expect((await secondInvocation.json()).result).toBe(2);

    const publicCount = await fetch(`http://localhost:${port}/0.3.0/boxes/${createdAtomicBox.id}/state/public/count`);
    expect(publicCount.headers.get("cache-control")).toBe("no-store");
    expect(await publicCount.json()).toEqual({ found: true, value: 2 });
    const missingPublicState = await fetch(`http://localhost:${port}/0.3.0/boxes/${createdAtomicBox.id}/state/public/missing`);
    expect(await missingPublicState.json()).toEqual({ found: false });

    const replay = await invoke("increment", 1);
    expect(replay.status).toBe(409);

    // Atomic blocks commit independently, while a throwing block itself rolls back.
    const committedFailure = await invoke("commit_then_fail", 2);
    expect(committedFailure.status).toBe(422);
    expect((await committedFailure.json()).error.code).toBe("method_failed");
    expect(await (await fetch(`http://localhost:${port}/0.3.0/boxes/${createdAtomicBox.id}/state/public/count`)).json()).toEqual({ found: true, value: 3 });

    const rollback = await invoke("rollback", 3);
    expect(rollback.status).toBe(200);
    expect((await rollback.json()).result).toBe(false);
    expect(await (await fetch(`http://localhost:${port}/0.3.0/boxes/${createdAtomicBox.id}/state/public/temporary`)).json()).toEqual({ found: false });

    const nested = await invoke("nested", 4);
    expect(nested.status).toBe(422);
    expect((await nested.json()).error.message).toContain("Nested atomic blocks");

    const inspectBlob = await putSource("return { input: input, root: ctx.rootCaller, immediate: ctx.immediateCaller };");
    const childIncrementBlob = await putSource("return ctx.atomic(function update(tx) { let value = tx.state.public.get(\"effects\") || 0; tx.state.public.set(\"effects\", value + 1); return value + 1; });");
    const delayedCommitBlob = await putSource("await ctx.request(input.url); return ctx.atomic(function update(tx) { tx.state.public.set(\"late\", true); return true; });");
    const childBoxResponse = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "boxos-js/0.3.0", instance: "effect-child", methods: {
        inspect: { blob: inspectBlob.id }, increment: { blob: childIncrementBlob.id }, delayed_commit: { blob: delayedCommitBlob.id },
      } }),
    });
    expect(childBoxResponse.status).toBe(201);
    const childBox = await childBoxResponse.json();
    const callBlob = await putSource("return await ctx.call(input.box, input.method, input.value);");
    const detachedCallBlob = await putSource("ctx.call(input.box, \"increment\", null); return \"body complete\";");
    const atomicEffectBlob = await putSource("return ctx.atomic(function update(tx) { return ctx.call(input.box, \"inspect\", null); });");
    const hostPageBlob = await putSource("return await ctx.hostPage(input);");
    const requestBlob = await putSource("let response = await ctx.request(input); return { status: response.status, ok: response.ok };");
    const echoBlob = await putSource("return input;");
    const selfCallBlob = await putSource("return await ctx.call(ctx.box, \"echo\", input);");
    const taskThenBlob = await putSource("return ctx.call(ctx.box, \"echo\", input).then(function pass(value) { return value; });");
    const atomicTaskBlob = await putSource("let task = ctx.call(input.box, \"inspect\", null); return ctx.atomic(function update(tx) { task.then(function pass(value) { return value; }); return null; });");
    const cancelChildBlob = await putSource("await ctx.request(input.url); return await ctx.call(input.box, \"delayed_commit\", input);");
    const awaitRejectedBlob = await putSource("try { await ctx.call(ctx.box, \"missing\", null); } catch (error) { return error.message; }");
    const parentBoxResponse = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "boxos-js/0.3.0", instance: "effect-parent", methods: {
        call: { blob: callBlob.id }, detached_call: { blob: detachedCallBlob.id },
        atomic_effect: { blob: atomicEffectBlob.id }, host_page: { blob: hostPageBlob.id }, request: { blob: requestBlob.id },
        echo: { blob: echoBlob.id }, self_call: { blob: selfCallBlob.id }, task_then: { blob: taskThenBlob.id },
        atomic_task: { blob: atomicTaskBlob.id }, cancel_child: { blob: cancelChildBlob.id },
        await_rejected: { blob: awaitRejectedBlob.id },
      } }),
    });
    expect(parentBoxResponse.status).toBe(201);
    const parentBox = await parentBoxResponse.json();

    const childCall = await invoke("call", 5, parentBox.id, { box: childBox.id, method: "inspect", value: 42 });
    expect(childCall.status).toBe(200);
    expect((await childCall.json()).result).toEqual({
      input: 42, root: publicJwk.x, immediate: { box: parentBox.id, method: "call" },
    });

    const detachedCall = await invoke("detached_call", 6, parentBox.id, { box: childBox.id });
    expect(detachedCall.status).toBe(200);
    expect((await detachedCall.json()).result).toBe("body complete");
    expect(await (await fetch(`http://localhost:${port}/0.3.0/boxes/${childBox.id}/state/public/effects`)).json()).toEqual({ found: true, value: 1 });

    const atomicEffect = await invoke("atomic_effect", 7, parentBox.id, { box: childBox.id });
    expect(atomicEffect.status).toBe(422);
    expect((await atomicEffect.json()).error.message).toContain("Effects are not allowed");

    const hostedByMethod = await invoke("host_page", 8, parentBox.id, htmlBlob.id);
    expect(hostedByMethod.status).toBe(200);
    expect((await hostedByMethod.json()).result.id).toBe(page.id);

    const requested = await invoke("request", 9, parentBox.id, `http://localhost:${port}/0.3.0/accounts/${publicJwk.x}`);
    expect(requested.status).toBe(200);
    expect((await requested.json()).result).toEqual({ status: 200, ok: true });

    // A call may re-enter the same box because invocations no longer hold its atomic lock.
    const selfCall = await invoke("self_call", 10, parentBox.id, "same box");
    expect(selfCall.status).toBe(200);
    expect((await selfCall.json()).result).toBe("same box");

    const taskThen = await invoke("task_then", 11, parentBox.id, "then result");
    expect(taskThen.status).toBe(200);
    expect((await taskThen.json()).result).toBe("then result");

    const atomicTask = await invoke("atomic_task", 12, parentBox.id, { box: childBox.id });
    expect(atomicTask.status).toBe(422);
    expect((await atomicTask.json()).error.message).toContain("Tasks cannot be derived inside ctx.atomic");

    const awaitRejected = await invoke("await_rejected", 13, parentBox.id);
    expect(awaitRejected.status).toBe(200);
    expect((await awaitRejected.json()).result).toContain("Target box method not found");

    const cancelledChild = await invoke("cancel_child", 14, parentBox.id, { box: childBox.id, url: slowUrl });
    expect(cancelledChild.status).toBe(408);
    await Bun.sleep(700);
    expect(await (await fetch(`http://localhost:${port}/0.3.0/boxes/${childBox.id}/state/public/late`)).json()).toEqual({ found: false });

    const unsafeBlobResponse = await fetch(`http://localhost:${port}/0.3.0/blobs`, {
      method: "POST",
      body: "return globalThis.process.env;",
    });
    const unsafeBlob = await unsafeBlobResponse.json();
    const unsafeBox = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "boxos-js/0.3.0",
        instance: "unsafe",
        methods: { escape: { blob: unsafeBlob.id } },
      }),
    });
    expect(unsafeBox.status).toBe(400);
    expect((await unsafeBox.json()).error.code).toBe("invalid_method_source");

    const constructorBlobResponse = await fetch(`http://localhost:${port}/0.3.0/blobs`, {
      method: "POST",
      body: "return input.constructor.constructor(\"return process\")();",
    });
    const constructorBlob = await constructorBlobResponse.json();
    const constructorBox = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "boxos-js/0.3.0",
        instance: "constructor-escape",
        methods: { escape: { blob: constructorBlob.id } },
      }),
    });
    expect(constructorBox.status).toBe(400);

    const cliDownload = await fetch(`http://localhost:${port}/boxos-cli.js`);
    expect(cliDownload.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(cliDownload.headers.get("content-disposition")).toBeNull();
    expect(await cliDownload.text()).toStartWith("#!/usr/bin/env bun");

    const agentGuide = await fetch(`http://localhost:${port}/AGENTS.md`);
    expect(agentGuide.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await agentGuide.text()).toContain("# BOXOS agent guide");

    const client = await fetch(`http://localhost:${port}/client.js`);
    expect(client.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await client.text()).toContain("class BoxOSClient");
    async function cli(...command: string[]) {
      const child = Bun.spawn(["bin/boxos", "--url", `http://localhost:${port}`, ...command], {
        env: { ...Bun.env, BOXOS_CONFIG_DIR: cliConfigPath }, stdout: "pipe", stderr: "pipe",
      });
      const value = await new Response(child.stdout).json();
      expect(await child.exited).toBe(0);
      return value;
    }
    const cliAccount = await cli("account", "create", "--name", "agent");
    expect(cliAccount.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cliPage = await cli("deploy", "page", "examples/about.html");
    expect(cliPage.page).toMatch(/^[a-z2-7]{32}$/);
    expect(cliPage.blob).toMatch(/^blob_[0-9a-f]{64}$/);

    const stylesheet = await fetch(`http://localhost:${port}/boxos.css`);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const css = await stylesheet.text();
    expect(css).toContain("color-scheme: dark light");
    expect(css).toContain("prefers-color-scheme: light");

    const examplesResponse = await fetch(`http://localhost:${port}/0.3.0/examples`);
    const examples = await examplesResponse.json();
    expect(examples.examples).toHaveLength(9);
    expect(examples.examples.map((example: { name: string }) => example.name)).toEqual(["about", "app-explorer", "counter", "profile", "social", "social-graph", "social-messages", "social-groups", "wallet"]);
    const aboutExample = examples.examples.find((example: { name: string }) => example.name === "about");
    const appExplorerExample = examples.examples.find((example: { name: string }) => example.name === "app-explorer");
    const tryBoxos = await fetch(`http://localhost:${port}/examples/app-explorer`, { redirect: "manual" });
    expect(tryBoxos.status).toBe(302);
    expect(tryBoxos.headers.get("location")).toBe(appExplorerExample.localUrl);
    const counterExample = examples.examples.find((example: { name: string }) => example.name === "counter");
    const profileExample = examples.examples.find((example: { name: string }) => example.name === "profile");
    const socialExample = examples.examples.find((example: { name: string }) => example.name === "social");
    const walletExample = examples.examples.find((example: { name: string }) => example.name === "wallet");
    expect(aboutExample.url).toMatch(/^https:\/\/[a-z2-7]{32}\.boxos\.org$/);
    expect(aboutExample.currentUrl).toBe(aboutExample.localUrl);
    expect(aboutExample.localUrl).toMatch(new RegExp(`^http://[a-z2-7]{32}\\.localhost:${port}$`));
    expect(aboutExample.box).toBeNull();
    expect(appExplorerExample.box).toMatch(/^box_[0-9a-f]{64}$/);
    expect(counterExample.box).toMatch(/^box_[0-9a-f]{64}$/);
    expect(profileExample.box).toMatch(/^box_[0-9a-f]{64}$/);
    expect(socialExample.box).toBeNull();
    expect(walletExample.box).toBeNull();

    const deployedExamplesResponse = await fetch(`http://localhost:${port}/0.3.0/examples`, {
      headers: { host: "demo.example.test", "x-forwarded-proto": "https" },
    });
    const deployedExamples = (await deployedExamplesResponse.json()).examples;
    const deployedProfile = deployedExamples.find((example: { name: string }) => example.name === "profile");
    const deployedWallet = deployedExamples.find((example: { name: string }) => example.name === "wallet");
    expect(deployedProfile.currentUrl).toMatch(/^https:\/\/[a-z2-7]{32}\.demo\.example\.test$/);
    expect(deployedWallet.currentUrl).toMatch(/^https:\/\/[a-z2-7]{32}\.demo\.example\.test$/);
    expect(deployedWallet.localUrl).toBeNull();
    expect(deployedWallet.url).toMatch(/^https:\/\/[a-z2-7]{32}\.boxos\.org$/);
    const deployedWalletRedirect = await fetch(`http://localhost:${port}/examples/wallet`, {
      headers: { host: "demo.example.test", "x-forwarded-proto": "https" }, redirect: "manual",
    });
    expect(deployedWalletRedirect.headers.get("location")).toBe(deployedWallet.currentUrl);
    const deployedProfileHost = new URL(deployedProfile.currentUrl).hostname;
    const deployedProfilePage = await fetch(`http://localhost:${port}/`, { headers: { host: deployedProfileHost } });
    expect(await deployedProfilePage.text()).toContain("wallet.currentUrl");

    const walletKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const walletPublic = await crypto.subtle.exportKey("jwk", walletKeys.publicKey);
    const grant = {
      domain: "boxos-grant/0.3.0", account: walletPublic.x, subject: publicJwk.x,
      permission: "public-profile",
    };
    const grantPrefix = new TextEncoder().encode("BOXOS:MESSAGE:0.3.0\0");
    const grantBody = new TextEncoder().encode(JSON.stringify(grant));
    const grantBytes = new Uint8Array(grantPrefix.length + grantBody.length);
    grantBytes.set(grantPrefix); grantBytes.set(grantBody, grantPrefix.length);
    const grantSignatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", walletKeys.privateKey, grantBytes));
    let grantBinary = "";
    for (const byte of grantSignatureBytes) grantBinary += String.fromCharCode(byte);
    const grantSignature = btoa(grantBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const profileSet = await invoke("set", 15, profileExample.box, {
      username: "alice", account: walletPublic.x, grant, signature: grantSignature,
    });
    expect(profileSet.status).toBe(200);
    expect((await profileSet.json()).result).toEqual({ username: "alice", publicKey: walletPublic.x });
    expect(await (await fetch(`http://localhost:${port}/0.3.0/boxes/${profileExample.box}/state/public/${walletPublic.x}`)).json())
      .toEqual({ found: true, value: { username: "alice", publicKey: walletPublic.x } });

    const sharedCreateBlob = await putSource("return ctx.atomic(function create(tx) { tx.state.shared.create(input.key, input.authority, input.value); return input.value; });");
    const sharedUpdateBlob = await putSource("return ctx.atomic(function update(tx) { tx.state.shared.set(input.key, input.value); return input.value; });");
    const sharedDeleteBlob = await putSource("return ctx.atomic(function remove(tx) { return tx.state.shared.delete(input.key); });");
    const sharedBoxResponse = await fetch(`http://localhost:${port}/0.3.0/boxes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "boxos-js/0.3.0", instance: "shared-state-test", methods: {
        create: { blob: sharedCreateBlob.id }, update: { blob: sharedUpdateBlob.id }, remove: { blob: sharedDeleteBlob.id },
      } }),
    });
    expect(sharedBoxResponse.status).toBe(201);
    const sharedBox = await sharedBoxResponse.json();
    expect((await invoke("create", 16, sharedBox.id, { key: "inbox", authority: walletPublic.x, value: { unread: 1 } })).status).toBe(200);
    const sharedMetadata = await (await fetch(`http://localhost:${port}/0.3.0/boxes/${sharedBox.id}/state/shared/inbox`)).json();
    expect(sharedMetadata).toEqual({ found: true, entry: expect.stringMatching(/^shared_/), authority: walletPublic.x });

    const sharedGrant = { box: sharedBox.id, key: "inbox", entry: sharedMetadata.entry, reader: publicJwk.x };
    const sharedGrantPrefix = new TextEncoder().encode("BOXOS:SHARED-READ:0.3.0\0");
    const sharedGrantBody = new TextEncoder().encode(JSON.stringify(sharedGrant));
    const sharedGrantMessage = new Uint8Array(sharedGrantPrefix.length + sharedGrantBody.length);
    sharedGrantMessage.set(sharedGrantPrefix); sharedGrantMessage.set(sharedGrantBody, sharedGrantPrefix.length);
    const sharedGrantRaw = new Uint8Array(await crypto.subtle.sign("Ed25519", walletKeys.privateKey, sharedGrantMessage));
    let sharedGrantBinary = "";
    for (const byte of sharedGrantRaw) sharedGrantBinary += String.fromCharCode(byte);
    const sharedGrantSignature = btoa(sharedGrantBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    async function readShared(nonce: number) {
      const command = { publicKey: publicJwk.x, nonce, box: sharedBox.id, key: "inbox", authority: walletPublic.x, grant: sharedGrant, grantSignature: sharedGrantSignature };
      const prefix = new TextEncoder().encode("BOXOS:SHARED-READ-COMMAND:0.3.0\0");
      const body = new TextEncoder().encode(JSON.stringify(command));
      const bytes = new Uint8Array(prefix.length + body.length); bytes.set(prefix); bytes.set(body, prefix.length);
      const raw = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes)); let binary = "";
      for (const byte of raw) binary += String.fromCharCode(byte);
      const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return await fetch(`http://localhost:${port}/0.3.0/shared-state/read`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, signature }),
      });
    }
    const firstSharedRead = await readShared(17);
    expect(firstSharedRead.status).toBe(200);
    expect((await firstSharedRead.json()).value).toEqual({ unread: 1 });

    const subscriptionCommand = {
      publicKey: publicJwk.x, nonce: 18, box: sharedBox.id, visibility: "shared", key: "inbox", maxFuel: 10_000,
      authority: walletPublic.x, grant: sharedGrant, grantSignature: sharedGrantSignature,
    };
    const subscriptionPrefix = new TextEncoder().encode("BOXOS:STATE-SUBSCRIBE:0.3.0\0");
    const subscriptionBody = new TextEncoder().encode(JSON.stringify(subscriptionCommand));
    const subscriptionBytes = new Uint8Array(subscriptionPrefix.length + subscriptionBody.length);
    subscriptionBytes.set(subscriptionPrefix); subscriptionBytes.set(subscriptionBody, subscriptionPrefix.length);
    const subscriptionRaw = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, subscriptionBytes));
    let subscriptionBinary = "";
    for (const byte of subscriptionRaw) subscriptionBinary += String.fromCharCode(byte);
    const subscriptionSignature = btoa(subscriptionBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const subscriptionResponse = await fetch(`http://localhost:${port}/0.3.0/state-subscriptions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: subscriptionCommand, signature: subscriptionSignature }),
    });
    expect(subscriptionResponse.status).toBe(201);
    const subscription = await subscriptionResponse.json();
    expect(subscription.receipt).toMatchObject({ spent: 10_000, nonce: 19 });
    const eventResponse = await fetch(`http://localhost:${port}${subscription.url}`);
    expect(eventResponse.headers.get("content-type")).toBe("text/event-stream");
    const eventReader = eventResponse.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await eventReader.read()).value)).toContain("event: ready");

    expect((await invoke("update", 19, sharedBox.id, { key: "inbox", value: { unread: 2 } })).status).toBe(200);
    let changedEvent = "";
    while (!changedEvent.includes("event: changed")) changedEvent += decoder.decode((await eventReader.read()).value);
    expect(changedEvent).toContain("event: changed");
    await eventReader.cancel();
    expect((await (await readShared(20)).json()).value).toEqual({ unread: 2 });
    expect((await invoke("remove", 21, sharedBox.id, { key: "inbox" })).status).toBe(200);
    expect((await invoke("create", 22, sharedBox.id, { key: "inbox", authority: walletPublic.x, value: { unread: 0 } })).status).toBe(200);
    expect((await readShared(23)).status).toBe(403);

    const publicSubscriptionCommand = {
      publicKey: publicJwk.x, nonce: 23, box: profileExample.box, visibility: "public", key: walletPublic.x, maxFuel: 10_000,
    };
    const publicSubscriptionPrefix = new TextEncoder().encode("BOXOS:STATE-SUBSCRIBE:0.3.0\0");
    const publicSubscriptionBody = new TextEncoder().encode(JSON.stringify(publicSubscriptionCommand));
    const publicSubscriptionBytes = new Uint8Array(publicSubscriptionPrefix.length + publicSubscriptionBody.length);
    publicSubscriptionBytes.set(publicSubscriptionPrefix); publicSubscriptionBytes.set(publicSubscriptionBody, publicSubscriptionPrefix.length);
    const publicSubscriptionRaw = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, publicSubscriptionBytes));
    let publicSubscriptionBinary = "";
    for (const byte of publicSubscriptionRaw) publicSubscriptionBinary += String.fromCharCode(byte);
    const publicSubscriptionSignature = btoa(publicSubscriptionBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const publicSubscriptionResponse = await fetch(`http://localhost:${port}/0.3.0/state-subscriptions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: publicSubscriptionCommand, signature: publicSubscriptionSignature }),
    });
    expect(publicSubscriptionResponse.status).toBe(201);
    expect((await publicSubscriptionResponse.json()).receipt).toMatchObject({ spent: 10_000, nonce: 24 });

    const counterBox = await fetch(`http://localhost:${port}/0.3.0/boxes/${counterExample.box}`);
    expect(Object.keys((await counterBox.json()).definition.methods)).toEqual(["increment"]);

    const aboutHost = new URL(aboutExample.url).hostname;
    const publishedAbout = await fetch(`http://localhost:${port}/`, { headers: { host: aboutHost } });
    expect(await publishedAbout.text()).toContain("Small programs.");
    const pageClient = await fetch(`http://localhost:${port}/client.js`, { headers: { host: aboutHost } });
    expect(await pageClient.text()).toContain("class BoxOSClient");
    const pageStyles = await fetch(`http://localhost:${port}/boxos.css`, { headers: { host: aboutHost } });
    expect(await pageStyles.text()).toContain("--boxos-accent");
    const aboutRedirect = await fetch(`http://localhost:${port}/about`, {
      headers: { host: aboutHost, "x-forwarded-proto": "https" }, redirect: "manual",
    });
    expect(aboutRedirect.headers.get("location")).toBe("https://boxos.org/");

    const counterHost = new URL(counterExample.url).hostname;
    const counterPage = await fetch(`http://localhost:${port}/`, { headers: { host: counterHost } });
    const counterHtml = await counterPage.text();
    expect(counterHtml).toContain("Counter box");
    expect(counterHtml).toContain("class=\"app-brand\" href=\"/about\"");
    expect(counterHtml).toContain("client.getPublicState(box, \"count\")");
    expect(counterHtml).toContain("client.invoke(box, \"increment\"");

    const profilePage = await fetch(`${profileExample.localUrl}/`);
    expect(await profilePage.text()).toContain("public-profile");
    const socialPage = await fetch(`${socialExample.localUrl}/`);
    const socialHtml = await socialPage.text();
    expect(socialHtml).toContain("id=\"history\"");
    expect(socialHtml).toContain("id=\"account\"");
    expect(socialHtml).toContain("id=\"newChat\"");
    expect(socialHtml).toContain("public-profile");
    expect(socialHtml).toContain("direct:");
    expect(socialHtml).toContain("group:");
    expect(socialHtml).toContain("sentAt:Date.now()");
    expect(socialHtml).toContain('client.subscribeState(messagesBox.box,"shared"');
    expect(socialHtml).toContain("sharedReads");
    expect(socialHtml).toContain('params.get("to")||params.get("person")');
    expect(socialHtml).toContain("Copy ID");

    const walletPage = await fetch(`${walletExample.localUrl}/`);
    const walletHtml = await walletPage.text();
    expect(walletHtml).toContain("Create or restore an account");
    expect(walletHtml).toContain("Save your recovery key");
    expect(walletHtml).toContain("BOXOS:MESSAGE:0.3.0");
    expect(walletHtml).toContain('sign(record,grant,"SHARED-READ")');

    const counterBypass = await fetch(`http://localhost:${port}/0.3.0/examples/counter`, { method: "POST" });
    expect(counterBypass.status).toBe(404);

    const missing = await fetch(`http://localhost:${port}/missing`);
    expect(missing.status).toBe(404);
  } finally {
    process.kill();
    slowServer.stop(true);
    await process.exited;
    await Bun.file(databasePath).delete();
    await rm(cliConfigPath, { recursive: true, force: true });
  }
});
