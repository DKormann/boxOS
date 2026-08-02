export const MAX_WORKERS = 4;
export const WORKER_BASE_FUEL = 5;
export const MAX_STORAGE_BYTES = 32 * 1024 * 1024;
export const MAX_STORAGE_OPERATIONS = 1_000;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function entryBytes(key: string, value: string): number {
  return utf8Bytes(key) + utf8Bytes(value);
}

export function procedureStorageBytes(hash: string, code: string): number {
  return entryBytes(hash, code);
}

export function stateStorageBytes(procedureHash: string, key: string, value: string): number {
  return entryBytes(procedureHash, key) + utf8Bytes(value) + 8;
}

export function pageStorageBytes(hash: string, html: string): number {
  return entryBytes(`page:${hash}`, html) + 8;
}

export function storagePressureMultiplier(usedBytes: number): number {
  return Math.min(4, 1 + Math.floor((usedBytes * 4) / MAX_STORAGE_BYTES));
}

export function storageFuelCost(key: string, value: string, usedBytes: number): number {
  return storagePressureMultiplier(usedBytes) * Math.max(1, Math.ceil(entryBytes(key, value) / 1024));
}
