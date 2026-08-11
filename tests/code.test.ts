import { expect, test } from "bun:test";
import { APP_INSTALLS_REDUCER_CODE, APP_INSTALLS_REDUCER_HASH } from "../src/userspace/app-installs.ts";
import { APP_PUBLISHER_REDUCER_CODE, APP_PUBLISHER_REDUCER_HASH } from "../src/userspace/app-publisher.ts";
import { COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH } from "../src/userspace/counter.ts";
import { FRIENDS_REDUCER_CODE, FRIENDS_REDUCER_HASH } from "../src/userspace/friends.ts";
import { procHash } from "../src/hash.ts";
import { IDENTITY_PROCEDURE_CODE, IDENTITY_PROCEDURE_HASH, IDENTITY_REDUCER_CODE, IDENTITY_REDUCER_HASH } from "../src/userspace/identity.ts";
import { PAGE_REDUCER_CODE, PAGE_REDUCER_HASH } from "../src/page.ts";
import { analyzeProcCode, isValidProcCode, sourceRuntimeVersion, validateProcCode } from "../src/parser.ts";
import { PROFILE_REDUCER_CODE, PROFILE_REDUCER_HASH } from "../src/userspace/profile.ts";
import { PUBLISH_PROCEDURE_CODE, PUBLISH_PROCEDURE_HASH, VALIDATE_PROCEDURE_CODE, VALIDATE_PROCEDURE_HASH } from "../src/userspace/procedures.ts";
import { STARTUP_REDUCER_CODE, STARTUP_REDUCER_HASH } from "../src/userspace/startup.ts";
import { TODO_REDUCER_CODE, TODO_REDUCER_HASH } from "../src/userspace/todo.ts";

const reducerNames = ["ctx", "input", "JSON", "Math", "String"];
const reducers = [
  [APP_INSTALLS_REDUCER_CODE, APP_INSTALLS_REDUCER_HASH],
  [APP_PUBLISHER_REDUCER_CODE, APP_PUBLISHER_REDUCER_HASH],
  [COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH],
  [FRIENDS_REDUCER_CODE, FRIENDS_REDUCER_HASH],
  [IDENTITY_REDUCER_CODE, IDENTITY_REDUCER_HASH],
  [PAGE_REDUCER_CODE, PAGE_REDUCER_HASH],
  [PROFILE_REDUCER_CODE, PROFILE_REDUCER_HASH],
  [STARTUP_REDUCER_CODE, STARTUP_REDUCER_HASH],
  [TODO_REDUCER_CODE, TODO_REDUCER_HASH],
] as const;
const procedures = [
  [IDENTITY_PROCEDURE_CODE, IDENTITY_PROCEDURE_HASH],
  [PUBLISH_PROCEDURE_CODE, PUBLISH_PROCEDURE_HASH],
  [VALIDATE_PROCEDURE_CODE, VALIDATE_PROCEDURE_HASH],
] as const;

test("stored functions have stable valid content addresses", () => {
  for (const [code, hash] of reducers) {
    expect(hash).toBe(procHash(code));
    validateProcCode(code, reducerNames, true);
  }
  for (const [code, hash] of procedures) {
    expect(hash).toBe(procHash(code));
    validateProcCode(code, reducerNames, true);
  }
});

test("example pages expose their userspace dependencies", async () => {
  const expected: Record<string, string[]> = {
    "about.html": [STARTUP_REDUCER_HASH, PROFILE_REDUCER_HASH],
    "accounts.html": [IDENTITY_PROCEDURE_HASH, PROFILE_REDUCER_HASH],
    "app-explorer.html": [APP_INSTALLS_REDUCER_HASH, APP_PUBLISHER_REDUCER_HASH, PROFILE_REDUCER_HASH],
    "friends.html": [FRIENDS_REDUCER_HASH, PROFILE_REDUCER_HASH],
    "persistent-counter.html": [COUNTER_REDUCER_HASH],
    "profile.html": [FRIENDS_REDUCER_HASH, PROFILE_REDUCER_HASH],
    "studio.html": [VALIDATE_PROCEDURE_HASH],
    "todo.html": [TODO_REDUCER_HASH, PROFILE_REDUCER_HASH],
  };
  for (const [file, hashes] of Object.entries(expected)) {
    const source = await Bun.file(`examples/${file}`).text();
    for (const hash of hashes) expect(source).toContain(hash);
  }
});

test("runtime semantics are explicitly versioned in source", () => {
  expect(sourceRuntimeVersion("return input;")).toBe(1);
  expect(sourceRuntimeVersion("// boxos-runtime: 1\nreturn input;")).toBe(1);
  let error: unknown;
  try { validateProcCode("// boxos-runtime: 2\nreturn input;", ["input"], true); } catch (caught) { error = caught; }
  expect(String(error)).toContain("Unsupported BOXOS runtime: 2");
});

test("the parser finds literal code references and rejects ambient globals", () => {
  const hash = procHash("return input;");
  const analysis = analyzeProcCode(`// ${"a".repeat(64)}\nreturn ctx.invoke("${hash}", input);`, ["ctx", "input"]);
  expect(analysis.references).toHaveLength(1);
  expect(analysis.references[0]).toBe(hash);
  expect(isValidProcCode("return globalThis.process;")).toBe(false);
});
