import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

/**
 * Validates and retrieves the 32-byte encryption key from ENCRYPTION_KEY (base64 or 64-char hex).
 * Throws a descriptive error if missing or invalid length.
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY?.trim();
  if (!envKey) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is missing. It must be a 32-byte base64 or 64-char hex encoded string."
    );
  }

  // Support 64-character hexadecimal key (32 bytes)
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, "hex");
  }

  const keyBuffer = Buffer.from(envKey, "base64");
  if (keyBuffer.length === KEY_LENGTH_BYTES) {
    return keyBuffer;
  }

  throw new Error(
    `ENCRYPTION_KEY is invalid. Expected 32 bytes (base64 or hex-encoded), received ${keyBuffer.length} bytes.`
  );
}

/**
 * Validates the encryption key at startup.
 */
export function validateEncryptionKey(): void {
  getEncryptionKey();
}

/**
 * Encrypts plain text using AES-256-GCM with a random 12-byte IV.
 * Returns IV, Auth Tag, and Ciphertext joined with colons: `<iv>:<tag>:<ciphertext>` in base64.
 */
export function encrypt(plainText: string, customKey?: Buffer): string {
  const key = customKey ?? getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}

/**
 * Decrypts a colon-separated cipher text `<iv>:<tag>:<ciphertext>` using AES-256-GCM.
 * Throws an error if decryption or authentication fails.
 */
export function decrypt(cipherText: string, customKey?: Buffer): string {
  const key = customKey ?? getEncryptionKey();

  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Invalid ciphertext format. Expected <iv>:<authTag>:<encryptedData> in base64."
    );
  }

  const [ivBase64, tagBase64, encryptedBase64] = parts;
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(tagBase64, "base64");

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(
      `Invalid IV length. Expected ${IV_LENGTH_BYTES} bytes, got ${iv.length}.`
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    let decrypted = decipher.update(encryptedBase64, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    throw new Error(
      "Decryption failed: ciphertext is corrupt, tampered, or key is incorrect."
    );
  }
}
