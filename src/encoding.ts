export const BOXOS_VERSION = "0.3.0";

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function domainBytes(domain: string, body: Uint8Array): Uint8Array {
  return concatBytes(utf8(`BOXOS:${domain}:${BOXOS_VERSION}\0`), body);
}

export async function sha256Domain(domain: string, body: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(domainBytes(domain, body))));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function contentIdentifier(kind: "blob" | "box", bytes: Uint8Array): Promise<string> {
  return `${kind}_${hex(await sha256Domain(kind.toUpperCase(), bytes))}`;
}

export function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
