import { expect, test } from "bun:test";
import { rm } from "fs/promises";
import { procHash } from "../src/hash.ts";
import { INITIAL_USER_FUEL, Storage } from "../src/storage.ts";

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
