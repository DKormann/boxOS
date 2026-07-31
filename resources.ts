export const MAX_WORKERS = 4;
export const WORKER_BASE_FUEL = 5;
export const MAX_STORAGE_BYTES = 32 * 1024 * 1024;
export const MAX_STORAGE_OPERATIONS = 1_000;

const encoder = new TextEncoder();

export function entryBytes(key: string, value: string): number {
  return encoder.encode(key).byteLength + encoder.encode(value).byteLength;
}

export function totalStorageBytes(storage: Map<string, string>): number {
  let total = 0;
  for (const [key, value] of storage) total += entryBytes(key, value);
  return total;
}

export function storagePressureMultiplier(usedBytes: number): number {
  return Math.min(4, 1 + Math.floor((usedBytes * 4) / MAX_STORAGE_BYTES));
}

export function storageFuelCost(key: string, value: string, usedBytes: number): number {
  return storagePressureMultiplier(usedBytes) * Math.max(1, Math.ceil(entryBytes(key, value) / 1024));
}
