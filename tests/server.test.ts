test("serves the BOXOS homepage and rejects unknown paths", async () => {
  const port = String(41000 + Math.floor(Math.random() * 1000));
  const databasePath = `/tmp/boxos-${crypto.randomUUID()}.sqlite`;
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

    const storedBox = await fetch(`http://localhost:${port}/0.3.0/boxes/${createdBox.id}`);
    expect((await storedBox.json()).definition).toEqual(definition);

    const client = await fetch(`http://localhost:${port}/client.js`);
    expect(client.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await client.text()).toContain("class BoxOSClient");

    const examplesResponse = await fetch(`http://localhost:${port}/0.3.0/examples`);
    const examples = await examplesResponse.json();
    expect(examples.examples).toHaveLength(1);
    expect(examples.examples[0].name).toBe("about");
    expect(examples.examples[0].url).toMatch(/^https:\/\/[a-z2-7]{32}\.boxos\.org$/);
    expect(examples.examples[0].localUrl).toMatch(new RegExp(`^http://[a-z2-7]{32}\\.localhost:${port}$`));

    const aboutHost = new URL(examples.examples[0].url).hostname;
    const publishedAbout = await fetch(`http://localhost:${port}/`, { headers: { host: aboutHost } });
    expect(await publishedAbout.text()).toContain("Small programs.");
    const pageClient = await fetch(`http://localhost:${port}/client.js`, { headers: { host: aboutHost } });
    expect(await pageClient.text()).toContain("class BoxOSClient");

    const counterBypass = await fetch(`http://localhost:${port}/0.3.0/examples/counter`, { method: "POST" });
    expect(counterBypass.status).toBe(404);

    const missing = await fetch(`http://localhost:${port}/missing`);
    expect(missing.status).toBe(404);
  } finally {
    process.kill();
    await process.exited;
    await Bun.file(databasePath).delete();
  }
});
