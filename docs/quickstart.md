# Build a BOXOS app

BOXOS applications are immutable HTML pages backed by immutable reducers and procedures. You can start with one file, publish it, and receive a permanent URL—there is no project configuration or deployment service.

> **Coding agent?** Read the compact, machine-friendly guide at [`/agents`](/agents). It contains the complete publication workflow and platform constraints.

## The smallest useful app

Save this as `hello.html`:

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello from BOXOS</title>
<style>
  body { max-width: 42rem; margin: 10vh auto; padding: 0 1rem; font: 18px/1.5 system-ui; }
  button { padding: .7rem 1rem; }
</style>
<h1>Hello from BOXOS</h1>
<p>This page is immutable and has its own browser origin.</p>
<button>Count locally</button> <output>0</output>
<script>
  let count = 0;
  document.querySelector("button").onclick = () => {
    document.querySelector("output").value = String(++count);
  };
</script>
```

This is an ordinary web page. It can use browser JavaScript, CSS, web components, canvas, and third-party APIs. BOXOS only restricts code that runs on the backend.

## Publish it

The following Bun script creates a fuel identity, discovers the page reducer, and publishes your HTML. Save it as `publish.ts` beside `hello.html`:

```ts
const base = "https://boxos.org";
const bytes = crypto.getRandomValues(new Uint8Array(32));
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);
const identity = btoa(binary)
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const page = await fetch(`${base}/page`).then(response => response.json());
const html = await Bun.file("hello.html").text();
const response = await fetch(`${base}/invoke/${page.reducer}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${identity}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ input: html, fuel: 1000 }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
console.log(page.urlTemplate.replace("{id}", result.ok));
```

Run it with:

```sh
bun publish.ts
```

The resulting URL is permanent. Changing even one byte of the page creates a new URL.

## Add persistent state

Backend code is a restricted JavaScript function body. A reducer can read and update only its own private and public state:

```js
let count = await ctx.state.public.get("count") || 0;
if (input.action == "increment") {
  count += 1;
  ctx.state.public.set("count", count);
}
return count;
```

Register that exact source with `POST /reducers`. The response contains its immutable 64-character hash. Put the hash in your HTML, import the client, and invoke it:

```html
<script type="module">
  import { BoxOSClient } from "/client.js";
  const boxos = new BoxOSClient();
  const counter = "<your-reducer-hash>";

  const result = await boxos.invoke(counter, { action: "increment" });
  console.log(result.ok, result.fuel);
</script>
```

Each page origin automatically receives a separate bearer fuel identity in `localStorage`. Public reducer state can also be read without invoking code or spending runtime fuel.

## When to use each primitive

- **Page:** UI and browser-side behavior. Start here.
- **Reducer:** durable transactional state, permissions, ownership, and public data.
- **Procedure:** network requests, code publication, or one transaction spanning multiple reducers.
- **Signed capability:** user-owned data that should survive across applications without trusting an account ID supplied as ordinary input.

## Important constraints

- Published code and pages cannot be changed in place.
- Reducer and procedure source is a deliberately small JavaScript subset—not arbitrary JavaScript.
- Inputs, results, and state must be JSON serializable.
- Reducers cannot fetch or invoke other reducers directly.
- Procedures may fetch and can compose reducers through `ctx.transaction`.
- Runtime and permanent storage consume fuel; successful calls refund unused runtime fuel.
- Keep deployment bearer identities secret. Browser application identities are generated independently per page origin.

## Continue reading

- [API and runtime reference](/docs/api)
- [Signed accounts and capabilities](/docs/accounts)
- [Architecture and trust model](/proposal)
- [Examples](/examples)
- [Studio](/examples/studio)
