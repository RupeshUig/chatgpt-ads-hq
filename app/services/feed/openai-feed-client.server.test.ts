import { test, describe } from "node:test";
import assert from "node:assert";
import {
  buildDeltaPayload,
  FEED_DISABLED_MESSAGE,
  type DeltaVariantInput,
} from "./openai-feed-client.server.ts";
import { encrypt, decrypt } from "../../lib/crypto.server.ts";

describe("openai-feed-client: Delta Payload Builder", () => {
  test("correctly groups multiple variants under parent products and formats prices in minor units", () => {
    const deltas: DeltaVariantInput[] = [
      {
        shopifyProductId: "gid://shopify/Product/100",
        shopifyVariantId: "gid://shopify/ProductVariant/100-1",
        priceMinor: 2999,
        currency: "USD",
        availability: "in_stock",
      },
      {
        shopifyProductId: "gid://shopify/Product/100",
        shopifyVariantId: "gid://shopify/ProductVariant/100-2",
        priceMinor: 3499,
        currency: "USD",
        availability: "out_of_stock",
      },
      {
        shopifyProductId: "gid://shopify/Product/200",
        shopifyVariantId: "gid://shopify/ProductVariant/200-1",
        priceMinor: 1495,
        currency: "usd",
        availability: "in_stock",
      },
    ];

    const payload = buildDeltaPayload(deltas);

    assert.strictEqual(payload.products.length, 2);

    // First parent product has 2 variants
    const prod100 = payload.products.find((p) => p.id === "gid://shopify/Product/100");
    assert.ok(prod100);
    assert.strictEqual(prod100.variants.length, 2);
    assert.strictEqual(prod100.variants[0].id, "gid://shopify/ProductVariant/100-1");
    assert.strictEqual(prod100.variants[0].price.amount, 2999);
    assert.strictEqual(prod100.variants[0].price.currency, "USD");
    assert.strictEqual(prod100.variants[0].availability.status, "in_stock");

    assert.strictEqual(prod100.variants[1].id, "gid://shopify/ProductVariant/100-2");
    assert.strictEqual(prod100.variants[1].price.amount, 3499);
    assert.strictEqual(prod100.variants[1].availability.status, "out_of_stock");

    // Second parent product has 1 variant
    const prod200 = payload.products.find((p) => p.id === "gid://shopify/Product/200");
    assert.ok(prod200);
    assert.strictEqual(prod200.variants.length, 1);
    assert.strictEqual(prod200.variants[0].price.amount, 1495);
    assert.strictEqual(prod200.variants[0].price.currency, "USD");
  });

  test("handles empty deltas array", () => {
    const payload = buildDeltaPayload([]);
    assert.deepStrictEqual(payload.products, []);
  });
});

describe("openai-feed-client: 403 Feed Access Fallback Message", () => {
  test("exact fallback message is defined per requirements", () => {
    const expected =
      "Product feed access isn't enabled on your ChatGPT Ads account yet. You can keep using the official ChatGPT Ads app for syncing; Cartlight will still check tracking and profit.";
    assert.strictEqual(FEED_DISABLED_MESSAGE, expected);
  });
});

describe("openai-feed-client: SFTP Credential Encryption", () => {
  test("SFTP password and private key are encrypted with AES-256-GCM and decrypt correctly", () => {
    const sftpPassword = "SuperSecretSftpPassword123!@#";
    const sftpPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\ntestkey\n-----END OPENSSH PRIVATE KEY-----";

    const encryptedPassword = encrypt(sftpPassword);
    const encryptedKey = encrypt(sftpPrivateKey);

    // Format is <iv>:<tag>:<ciphertext> in base64
    assert.strictEqual(encryptedPassword.split(":").length, 3);
    assert.strictEqual(encryptedKey.split(":").length, 3);

    // Decrypts accurately
    assert.strictEqual(decrypt(encryptedPassword), sftpPassword);
    assert.strictEqual(decrypt(encryptedKey), sftpPrivateKey);
  });
});
