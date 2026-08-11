import { expect, test } from "bun:test";
import { rm } from "fs/promises";
import { procHash } from "../src/hash.ts";
import { Storage, TransactionConflictError } from "../src/storage.ts";
import { TransactionCoordinator, type TransactionLimits } from "../src/transaction-coordinator.ts";

const limits: TransactionLimits = {
  maximumReducers: 2,
  maximumReads: 2,
  maximumReadBytes: 1024,
  maximumMutations: 2,
  maximumWriteBytes: 1024,
  maximumValueBytes: 256,
};

test("the coordinator lazily validates only observed keys", async () => {
  const path = `/tmp/boxos-coordinator-${crypto.randomUUID()}.sqlite`;
  const storage = new Storage(path);
  const code = "return input;";
  const hash = procHash(code);
  storage.putSystemCode(hash, "reducer", code);
  const coordinator = new TransactionCoordinator(storage, "alice", limits);

  coordinator.begin(1);
  coordinator.loadReducer(1, hash);
  expect(coordinator.read(1, hash, "private", "observed").found).toBe(false);

  storage.commitTransaction("bob", [], [
    { hash, visibility: "private", key: "unrelated", operation: "set", value: 1 },
  ]);
  coordinator.commit(1, [
    { hash, visibility: "private", key: "result", operation: "set", value: 2 },
  ]);
  expect(storage.readState(hash, "private", "result").value).toBe(2);

  coordinator.begin(2);
  coordinator.loadReducer(2, hash);
  coordinator.read(2, hash, "private", "observed");
  storage.commitTransaction("bob", [], [
    { hash, visibility: "private", key: "observed", operation: "set", value: 3 },
  ]);
  let conflict: unknown;
  try { coordinator.commit(2, []); } catch (error) { conflict = error; }
  expect(conflict instanceof TransactionConflictError).toBe(true);

  storage.close();
  await rm(path, { force: true });
});
