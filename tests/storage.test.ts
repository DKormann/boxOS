import { expect, test } from "bun:test";
import { rm } from "fs/promises";
import { procHash } from "../src/hash.ts";
import { INITIAL_USER_FUEL, Storage, TransactionConflictError } from "../src/storage.ts";

test("fuel is charged, refunded, and repaid to the deleting caller", async () => {
  const path = `/tmp/boxos-fuel-${crypto.randomUUID()}.sqlite`;
  const storage = new Storage(path);
  const code = "return input;";
  const registered = storage.registerCode("alice", procHash(code), "reducer", code);
  expect(registered.cost).toBe(new TextEncoder().encode(code).byteLength * 8);
  storage.reserveFuel("alice", 100);
  storage.creditFuel("alice", 90);
  const initial = storage.readState("reducer", "public", "greeting");
  const written = storage.commitTransaction("alice", [
    { hash: "reducer", visibility: "public", key: "greeting", version: initial.version },
  ], [
    { hash: "reducer", visibility: "public", key: "greeting", operation: "set", value: "hello" },
  ]);
  expect(written.charged).toBe((8 + 7) * 8);
  const deleted = storage.commitTransaction("bob", [], [
    { hash: "reducer", visibility: "public", key: "greeting", operation: "delete" },
  ]);
  expect(deleted.repaid).toBe(written.charged);
  expect(deleted.balance).toBe(INITIAL_USER_FUEL + written.charged);
  storage.close();
  await rm(path, { force: true });
});

test("optimistic transactions conflict only on keys they read", async () => {
  const path = `/tmp/boxos-transactions-${crypto.randomUUID()}.sqlite`;
  const storage = new Storage(path);
  const first = storage.readState("reducer", "private", "first");
  const second = storage.readState("reducer", "private", "second");

  storage.commitTransaction("alice", [], [
    { hash: "reducer", visibility: "private", key: "first", operation: "set", value: 1 },
  ]);
  // An unrelated key can still commit from the same point in time.
  storage.commitTransaction("bob", [
    { hash: "reducer", visibility: "private", key: "second", version: second.version },
  ], [
    { hash: "reducer", visibility: "private", key: "second", operation: "set", value: 2 },
  ]);

  let conflict: unknown;
  try {
    storage.commitTransaction("bob", [
      { hash: "reducer", visibility: "private", key: "first", version: first.version },
    ], []);
  } catch (error) { conflict = error; }
  expect(conflict instanceof TransactionConflictError).toBe(true);
  storage.close();
  await rm(path, { force: true });
});
