import { test, describe } from "node:test";
import assert from "node:assert";
import crypto from "crypto";
import {
  encrypt,
  decrypt,
  getEncryptionKey,
  validateEncryptionKey,
} from "./crypto.server.ts";

describe("crypto.server", () => {
  const originalEnvKey = process.env.ENCRYPTION_KEY;
  // Generate a valid 32-byte key in base64
  const validTestKey = crypto.randomBytes(32).toString("base64");

  test("validates and retrieves 32-byte base64 key correctly", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const key = getEncryptionKey();
    assert.strictEqual(key.length, 32);
    assert.doesNotThrow(() => validateEncryptionKey());
  });

  test("throws error if ENCRYPTION_KEY is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    assert.throws(
      () => validateEncryptionKey(),
      /ENCRYPTION_KEY environment variable is missing/
    );
  });

  test("throws error if ENCRYPTION_KEY has wrong byte length", () => {
    // 16 bytes (128-bit) instead of 32 bytes (256-bit)
    process.env.ENCRYPTION_KEY = crypto.randomBytes(16).toString("base64");
    assert.throws(
      () => validateEncryptionKey(),
      /Expected 32 bytes/
    );
  });

  test("round trip encryption and decryption succeeds", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const testCases = [
      "sk-proj-openai-test-api-key-1234567890",
      "Hello World! 🚀 Secure Encryption with AES-256-GCM.",
      "",
      "A".repeat(1000),
      JSON.stringify({ adAccountId: "act_123", token: "secret" }),
    ];

    for (const originalText of testCases) {
      const cipherText = encrypt(originalText);
      assert.notStrictEqual(cipherText, originalText);

      // Verify format: iv:authTag:ciphertext
      const parts = cipherText.split(":");
      assert.strictEqual(parts.length, 3);

      const decrypted = decrypt(cipherText);
      assert.strictEqual(decrypted, originalText);
    }
  });

  test("each encryption uses a unique random IV", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const plainText = "same-plaintext-value";
    const cipher1 = encrypt(plainText);
    const cipher2 = encrypt(plainText);

    assert.notStrictEqual(cipher1, cipher2);
    assert.strictEqual(decrypt(cipher1), plainText);
    assert.strictEqual(decrypt(cipher2), plainText);
  });

  test("tampered ciphertext fails decryption", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const plainText = "sensitive-api-token";
    const cipherText = encrypt(plainText);
    const [iv, tag, data] = cipherText.split(":");

    // Tamper with data payload
    const tamperedData = Buffer.from(data, "base64");
    tamperedData[0] ^= 0xff; // flip bits
    const tamperedCipher = `${iv}:${tag}:${tamperedData.toString("base64")}`;

    assert.throws(
      () => decrypt(tamperedCipher),
      /Decryption failed/
    );
  });

  test("tampered auth tag fails decryption", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const cipherText = encrypt("secret");
    const [iv, tag, data] = cipherText.split(":");

    const tamperedTag = Buffer.from(tag, "base64");
    tamperedTag[0] ^= 0x01;
    const tamperedCipher = `${iv}:${tamperedTag.toString("base64")}:${data}`;

    assert.throws(
      () => decrypt(tamperedCipher),
      /Decryption failed/
    );
  });

  test("tampered IV fails decryption", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    const cipherText = encrypt("secret");
    const [iv, tag, data] = cipherText.split(":");

    const tamperedIv = Buffer.from(iv, "base64");
    tamperedIv[0] ^= 0x01;
    const tamperedCipher = `${tamperedIv.toString("base64")}:${tag}:${data}`;

    assert.throws(
      () => decrypt(tamperedCipher),
      /Decryption failed/
    );
  });

  test("malformed ciphertext format throws error", () => {
    process.env.ENCRYPTION_KEY = validTestKey;
    assert.throws(
      () => decrypt("invalid-string-without-colons"),
      /Invalid ciphertext format/
    );
    assert.throws(
      () => decrypt("only:two:parts:here"),
      /Invalid ciphertext format/
    );
  });

  test("decryption with wrong key fails", () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);

    const cipherText = encrypt("secret-data", key1);

    assert.throws(
      () => decrypt(cipherText, key2),
      /Decryption failed/
    );
  });

  // Restore original environment
  test("teardown", () => {
    if (originalEnvKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });
});
