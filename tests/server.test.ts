import { expect, test } from "bun:test";
import { APP_PUBLISHER_REDUCER_HASH } from "../src/userspace/app-publisher.ts";
import { pageHash, procHash } from "../src/hash.ts";
import { PAGE_REDUCER_HASH } from "../src/page.ts";
import { BOXOS_RUNTIME_VERSION, BOXOS_VERSION } from "../src/version.ts";
import { startServer } from "./helpers.ts";

test("the core API exposes infrastructure without an application registry", async () => {
  const server = await startServer();
  try {
    const version = await fetch(`${server.origin}/version`).then(response => response.json()) as { version: string; runtime: number };
    expect(version.version).toBe(BOXOS_VERSION);
    expect(version.runtime).toBe(BOXOS_RUNTIME_VERSION);

    const stats = await fetch(`${server.origin}/stats`).then(response => response.json()) as Record<string, unknown>;
    expect(JSON.stringify(Object.keys(stats).sort())).toBe(JSON.stringify(["boxos", "fuel", "pages", "storage"]));
    expect((stats.boxos as { version: string; runtime: number }).version).toBe(BOXOS_VERSION);
    expect((stats.boxos as { version: string; runtime: number }).runtime).toBe(BOXOS_RUNTIME_VERSION);
    expect((stats.pages as { reducer: string }).reducer).toBe(PAGE_REDUCER_HASH);

    const page = await fetch(`${server.origin}/page`).then(response => response.json()) as { rootUrl: string; urlTemplate: string };
    expect(page.rootUrl).toBe(server.origin);
    expect(page.urlTemplate).toContain("{id}");

    const homepage = await fetch(server.origin).then(response => response.text());
    const about = await fetch(`${server.origin}/about`).then(response => response.text());
    expect(homepage).toBe(about);
    expect(homepage).toContain("Try BOXOS");
    expect(homepage).toContain("https://boxos.org/agents");

    const agentGuide = await fetch(`${server.origin}/agents`);
    expect(agentGuide.headers.get("content-type")).toContain("text/markdown");
    expect(await agentGuide.text()).toContain("BOXOS agent guide");

    const documentation = await fetch(`${server.origin}/docs`).then(response => response.text());
    expect(documentation).toContain("Build a BOXOS app");
    expect(documentation).toContain("/docs/api");
    expect(documentation).toContain("<pre><code");

    const explorerId = pageHash(await Bun.file("examples/app-explorer.html").text());
    const tryBoxos = await fetch(`${server.origin}/start/try`, { redirect: "manual" });
    expect(tryBoxos.headers.get("location")).toContain(explorerId);

    const officialApps = await fetch(`${server.origin}/state/${APP_PUBLISHER_REDUCER_HASH}/publish:counter`)
      .then(response => response.json()) as { value: number };
    expect(officialApps.value > 0).toBe(true);

    const batch = await fetch(`${server.origin}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reads: [
        { hash: APP_PUBLISHER_REDUCER_HASH, key: "publish:counter" },
        { hash: APP_PUBLISHER_REDUCER_HASH, key: "missing" },
      ] }),
    }).then(response => response.json()) as { results: Array<{ found: boolean; value?: unknown }> };
    expect(batch.results[0]?.found).toBe(true);
    expect(batch.results[0]?.value).toBe(officialApps.value);
    expect(batch.results[1]?.found).toBe(false);
  } finally {
    await server.stop();
  }
}, 10_000);

test("an unawaited reducer failure still aborts its transaction", async () => {
  const server = await startServer();
  try {
    const reducerCode = `throw "reducer failed";`;
    const reducerHash = procHash(reducerCode);
    const procedureCode = `function work(tx) {
  tx.invoke("${reducerHash}", input);
  return "must not commit";
}
return await ctx.transaction(work);`;
    for (const [kind, code] of [["reducers", reducerCode], ["procedures", procedureCode]] as const) {
      const response = await fetch(`${server.origin}/${kind}`, {
        method: "POST",
        headers: server.headers,
        body: JSON.stringify({ code }),
      });
      expect(response.status).toBe(201);
    }

    const response = await server.invoke(procHash(procedureCode), null);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("reducer failed");
  } finally {
    await server.stop();
  }
}, 10_000);
