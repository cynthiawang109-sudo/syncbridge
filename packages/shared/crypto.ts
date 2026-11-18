import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyProvider {
  currentVersion: string;
  key(version: string): Buffer;
}
export class LocalKeyProvider implements KeyProvider {
  readonly currentVersion = process.env.ENVELOPE_KEY_VERSION ?? "local-v1";
  key(version: string) {
    const previous = JSON.parse(
      process.env.PREVIOUS_ENVELOPE_KEYS ?? "{}",
    ) as Record<string, string>;
    const encoded =
      version === this.currentVersion
        ? process.env.ENVELOPE_KEY
        : Object.hasOwn(previous, version)
          ? previous[version]
          : undefined;
    const key = Buffer.from(encoded ?? "", "base64");
    if (key.length !== 32) throw new Error("Missing or invalid envelope key");
    return key;
  }
}
function seal(key: Buffer, plaintext: Buffer, context: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function open(key: Buffer, ciphertext: string, context: string) {
  const data = Buffer.from(ciphertext, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
}
export class Envelope {
  constructor(private readonly keys: KeyProvider = new LocalKeyProvider()) {}
  encrypt(value: unknown, context: string) {
    const keyVersion = this.keys.currentVersion;
    const dek = randomBytes(32);
    return {
      keyVersion,
      encryptedTokens: JSON.stringify({
        wrappedKey: seal(this.keys.key(keyVersion), dek, context + ":key"),
        data: seal(dek, Buffer.from(JSON.stringify(value)), context + ":data"),
      }),
    };
  }
  decrypt<T>(encrypted: string, keyVersion: string, context: string): T {
    const { wrappedKey, data } = JSON.parse(encrypted) as {
      wrappedKey: string;
      data: string;
    };
    const dek = open(this.keys.key(keyVersion), wrappedKey, context + ":key");
    return JSON.parse(open(dek, data, context + ":data").toString()) as T;
  }
}
