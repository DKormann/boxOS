import { base32, contentIdentifier, domainBytes, hex, sha256Domain, utf8 } from "../src/encoding.ts";

function referenceInput(domain: string, body: Uint8Array): Uint8Array {
  const prefix = utf8(`BOXOS:${domain}:0.3.0\0`);
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix);
  result.set(body, prefix.length);
  return result;
}

test("constructs versioned domain-separated bytes", () => {
  const body = utf8("hello");
  expect(domainBytes("BLOB", body)).toEqual(referenceInput("BLOB", body));
});

test("derives stable content identifiers", async () => {
  const body = utf8("hello");
  const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", referenceInput("BLOB", body)));
  expect(await contentIdentifier("blob", body)).toBe(`blob_${hex(expectedHash)}`);
  expect(await sha256Domain("BLOB", body)).toEqual(expectedHash);
  expect(await contentIdentifier("box", body)).not.toBe(`box_${hex(expectedHash)}`);
});

test("encodes page hash prefixes as lowercase unpadded base32", () => {
  expect(base32(new Uint8Array(20))).toBe("a".repeat(32));
  expect(base32(Uint8Array.from([255]))).toBe("74");
});
