import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  normalizeShopifyOrderId,
  toMinorUnits,
  buildCapiUserData,
  buildCapiPurchasePayload,
  sendOpenAiCapiEvent,
} from "./openai-capi.server.ts";
import { encrypt, decrypt } from "../../lib/crypto.server.ts";

describe("OpenAI Conversions API (CAPI) Service", () => {
  const originalEnvKey = process.env.ENCRYPTION_KEY;
  before(() => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  });

  after(() => {
    process.env.ENCRYPTION_KEY = originalEnvKey;
  });
  it("normalizes Shopify Order GIDs to clean numeric string event IDs", () => {
    assert.equal(normalizeShopifyOrderId("gid://shopify/Order/987654321"), "987654321");
    assert.equal(normalizeShopifyOrderId("987654321"), "987654321");
    assert.equal(normalizeShopifyOrderId(123456789), "123456789");
    assert.equal(normalizeShopifyOrderId(null), "");
  });

  it("converts order totals and item prices into integer minor units (cents)", () => {
    assert.equal(toMinorUnits(120.5), 12050);
    assert.equal(toMinorUnits("99.99"), 9999);
    assert.equal(toMinorUnits(0), 0);
    assert.equal(toMinorUnits(null), 0);
  });

  it("builds user_data containing strictly click_id and zero personal data", () => {
    const withClick = buildCapiUserData("oppref_abc123");
    assert.deepEqual(withClick, { click_id: "oppref_abc123" });

    const withoutClick = buildCapiUserData("");
    assert.deepEqual(withoutClick, {});

    // Verify zero PII properties exist
    assert.equal("email" in withClick, false);
    assert.equal("phone" in withClick, false);
    assert.equal("first_name" in withClick, false);
    assert.equal("last_name" in withClick, false);
    assert.equal("address" in withClick, false);
    assert.equal("client_ip_address" in withClick, false);
  });

  it("builds CAPI order_created payload with exact matching event_id for deduplication", () => {
    const payload = buildCapiPurchasePayload({
      orderId: "gid://shopify/Order/5544332211",
      createdAt: "2026-11-20T04:00:00Z",
      currency: "usd",
      totalPriceMinor: 8950,
      shopDomain: "mystore.myshopify.com",
      clickId: "click_oppref_999",
      lineItems: [
        {
          variantId: "gid://shopify/ProductVariant/111",
          productId: "gid://shopify/Product/222",
          quantity: 2,
          unitPriceMinor: 4475,
        },
      ],
    });

    assert.equal(payload.event_name, "order_created");
    // Verify event_id is numeric order ID matching pixel
    assert.equal(payload.event_id, "5544332211");
    assert.equal(payload.event_source_url, "https://mystore.myshopify.com");
    assert.equal(payload.event_time, 1795147200);
    assert.equal(payload.user_data.click_id, "click_oppref_999");
    assert.equal(payload.custom_data.value, 8950);
    assert.equal(payload.custom_data.currency, "USD");
    assert.equal(payload.custom_data.num_items, 2);
    assert.deepEqual(payload.custom_data.contents, [
      {
        content_id: "111",
        content_type: "product",
        quantity: 2,
        item_price: 4475,
      },
    ]);
  });

  it("encrypts and decrypts conversion keys with AES-256-GCM identically to API keys", () => {
    const rawKey = "openaicapi_sec_abc123456789xyz";
    const encrypted = encrypt(rawKey);

    assert.notEqual(encrypted, rawKey);
    const parts = encrypted.split(":");
    assert.equal(parts.length, 3); // iv:tag:ciphertext

    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, rawKey);
  });

  it("handles missing pixel ID or conversion key without throwing", async () => {
    const payload = buildCapiPurchasePayload({
      orderId: "123",
      totalPriceMinor: 1000,
      shopDomain: "test.myshopify.com",
    });

    const result = await sendOpenAiCapiEvent("", "", payload);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "MISSING_CONFIG");
  });

  it("dispatches CAPI event and handles HTTP 200 response", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let capturedUrl = "";
      let capturedAuth = "";
      let capturedBody = "";

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
        capturedBody = String(init?.body || "");
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch;

      const payload = buildCapiPurchasePayload({
        orderId: "998877",
        totalPriceMinor: 5000,
        shopDomain: "test.myshopify.com",
        clickId: "click_1",
      });

      const result = await sendOpenAiCapiEvent(
        "pid_test_pixel",
        "key_test_conversion",
        payload
      );

      assert.equal(result.success, true);
      assert.equal(result.status, 200);
      assert.ok(capturedUrl.includes("pid=pid_test_pixel"));
      assert.equal(capturedAuth, "Bearer key_test_conversion");

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.event_name, "order_created");
      assert.equal(parsed.event_id, "998877");
      assert.equal(parsed.user_data.click_id, "click_1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sanitizes error responses and prevents any PII leakage", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            message: "Invalid event data for user customer@example.com",
          }),
          { status: 400 }
        );
      }) as typeof fetch;

      const payload = buildCapiPurchasePayload({
        orderId: "998877",
        totalPriceMinor: 5000,
        shopDomain: "test.myshopify.com",
      });

      const result = await sendOpenAiCapiEvent(
        "pid_test_pixel",
        "key_test_conversion",
        payload
      );

      assert.equal(result.success, false);
      assert.equal(result.status, 400);
      assert.equal(result.errorCode, "400");
      assert.ok(!result.errorMessage?.includes("customer@example.com"));
      assert.ok(result.errorMessage?.includes("[REDACTED_EMAIL]"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
