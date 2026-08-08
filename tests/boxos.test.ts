import { expect, test } from "bun:test";
import { COUNTER_REDUCER_CODE, COUNTER_REDUCER_HASH } from "../src/counter.ts";
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
import { INITIAL_USER_FUEL, Storage } from "../src/storage.ts";
import {
  STATUS_PROCEDURE_CODE,
  STATUS_PROCEDURE_HASH,
  STATUS_REDUCER_CODE,
  STATUS_REDUCER_HASH,
} from "../src/status.ts";
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

test("status functions have stable content addresses", () => {
  expect(STATUS_REDUCER_HASH).toBe(procHash(STATUS_REDUCER_CODE));
  expect(STATUS_PROCEDURE_HASH).toBe(procHash(STATUS_PROCEDURE_CODE));
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
