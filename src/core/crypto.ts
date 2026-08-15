const encoder = new TextEncoder()

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export function hexToBytes(hex: string, expectedBytes?: number): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 != 0) throw new TypeError("Invalid lowercase hexadecimal data")
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  if (expectedBytes != null && bytes.length != expectedBytes) {
    throw new TypeError(`Expected ${expectedBytes} bytes, received ${bytes.length}`)
  }
  return bytes
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
}

export async function verifyEd25519(
  publicKeyHex: string,
  signatureHex: string,
  message: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKeyHex, 32),
    { name: "Ed25519" },
    false,
    ["verify"],
  )
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    hexToBytes(signatureHex, 64),
    encoder.encode(message),
  )
}
