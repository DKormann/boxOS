import { expect, test } from "bun:test";
import { APP_PUBLISHER_REDUCER_HASH } from "../src/userspace/app-publisher.ts";
import { pageHash } from "../src/hash.ts";
import { PAGE_REDUCER_HASH } from "../src/page.ts";
import { startServer } from "./helpers.ts";

test("the core API exposes infrastructure without an application registry", async () => {
  const server = await startServer();
  try {
    const stats = await fetch(`${server.origin}/stats`).then(response => response.json()) as Record<string, unknown>;
    expect(JSON.stringify(Object.keys(stats).sort())).toBe(JSON.stringify(["fuel", "pages", "storage"]));
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
