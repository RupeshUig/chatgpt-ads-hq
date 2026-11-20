import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShopifyId,
  toMinorUnits,
  extractOppref,
  hasUserConsent,
  buildUserData,
  buildPageViewPayload,
  buildProductViewPayload,
  buildAddToCartPayload,
  buildCheckoutStartedPayload,
  buildOrderCreatedPayload,
} from "../../../extensions/openai-pixel/src/pixel-utils.ts";

describe("OpenAI Web Pixel Utilities & Payloads", () => {
  it("normalizes Shopify GIDs to clean numeric strings", () => {
    assert.equal(
      normalizeShopifyId("gid://shopify/ProductVariant/44556677"),
      "44556677"
    );
    assert.equal(
      normalizeShopifyId("gid://shopify/Product/12345678"),
      "12345678"
    );
    assert.equal(
      normalizeShopifyId("gid://shopify/Order/99887766"),
      "99887766"
    );
    assert.equal(normalizeShopifyId("99887766"), "99887766");
    assert.equal(normalizeShopifyId(null), "");
  });

  it("converts currency float amounts into integer minor units (cents)", () => {
    assert.equal(toMinorUnits(29.99), 2999);
    assert.equal(toMinorUnits("14.50"), 1450);
    assert.equal(toMinorUnits(0), 0);
    assert.equal(toMinorUnits(null), 0);
    assert.equal(toMinorUnits(100), 10000);
  });

  it("extracts oppref click ID accurately from landing URLs", () => {
    assert.equal(
      extractOppref("https://example.com/products/t-shirt?oppref=click_xyz123"),
      "click_xyz123"
    );
    assert.equal(
      extractOppref("https://example.com/products/t-shirt?utm_source=chatgpt&oppref=op_456&foo=bar"),
      "op_456"
    );
    assert.equal(extractOppref("https://example.com/products/t-shirt"), null);
    assert.equal(extractOppref(""), null);
  });

  it("enforces customer privacy consent rules strictly", () => {
    // Both analytics and marketing allowed
    assert.equal(
      hasUserConsent({
        analyticsProcessingAllowed: true,
        marketingAllowed: true,
      }),
      true
    );

    // Only analytics allowed -> false (OpenAI ad tracking requires marketing)
    assert.equal(
      hasUserConsent({
        analyticsProcessingAllowed: true,
        marketingAllowed: false,
      }),
      false
    );

    // Only marketing allowed -> false
    assert.equal(
      hasUserConsent({
        analyticsProcessingAllowed: false,
        marketingAllowed: true,
      }),
      false
    );

    // Declined or missing
    assert.equal(
      hasUserConsent({
        analyticsProcessingAllowed: false,
        marketingAllowed: false,
      }),
      false
    );
    assert.equal(hasUserConsent(null), false);
    assert.equal(hasUserConsent(undefined), false);
  });

  it("builds user_data containing strictly click_id and zero personal data", () => {
    const userData = buildUserData("click_123");
    assert.deepEqual(userData, { click_id: "click_123" });

    // Verify absolutely no PII properties exist
    const emptyUserData = buildUserData("");
    assert.deepEqual(emptyUserData, {});
    assert.equal("email" in userData, false);
    assert.equal("phone" in userData, false);
    assert.equal("first_name" in userData, false);
    assert.equal("ip" in userData, false);
  });

  it("builds correct page_viewed payload", () => {
    const payload = buildPageViewPayload(
      "evt_page_1",
      "https://example.com/",
      "click_abc",
      1700000000000
    );

    assert.equal(payload.event_name, "page_viewed");
    assert.equal(payload.event_id, "evt_page_1");
    assert.equal(payload.event_time, 1700000000);
    assert.equal(payload.event_source_url, "https://example.com/");
    assert.equal(payload.user_data.click_id, "click_abc");
    assert.equal(payload.custom_data, undefined);
  });

  it("builds correct contents_viewed payload for product_viewed", () => {
    const payload = buildProductViewPayload(
      "evt_prod_1",
      "https://example.com/products/item-1",
      {
        id: "gid://shopify/ProductVariant/8877",
        price: { amount: 35.0, currencyCode: "USD" },
        product: { id: "gid://shopify/Product/1122", title: "Cool Item" },
      },
      "click_abc",
      1700000000000
    );

    assert.equal(payload.event_name, "contents_viewed");
    assert.equal(payload.event_id, "evt_prod_1");
    assert.equal(payload.custom_data?.value, 3500); // 3500 cents
    assert.equal(payload.custom_data?.currency, "USD");
    assert.equal(payload.custom_data?.num_items, 1);
    assert.deepEqual(payload.custom_data?.contents, [
      {
        content_id: "8877",
        content_type: "product",
        quantity: 1,
        item_price: 3500,
      },
    ]);
  });

  it("builds correct items_added payload for product_added_to_cart", () => {
    const payload = buildAddToCartPayload(
      "evt_cart_1",
      "https://example.com/products/item-1",
      {
        quantity: 2,
        cost: { totalAmount: { amount: 50.0, currencyCode: "EUR" } },
        merchandise: {
          id: "gid://shopify/ProductVariant/9999",
          price: { amount: 25.0, currencyCode: "EUR" },
        },
      },
      null,
      1700000000000
    );

    assert.equal(payload.event_name, "items_added");
    assert.equal(payload.event_id, "evt_cart_1");
    assert.equal(payload.custom_data?.value, 5000); // 50.00 EUR in cents
    assert.equal(payload.custom_data?.currency, "EUR");
    assert.equal(payload.custom_data?.num_items, 2);
    assert.deepEqual(payload.custom_data?.contents, [
      {
        content_id: "9999",
        content_type: "product",
        quantity: 2,
        item_price: 2500,
      },
    ]);
  });

  it("builds correct checkout_started payload", () => {
    const payload = buildCheckoutStartedPayload(
      "evt_checkout_1",
      "https://example.com/checkout",
      {
        token: "tok_abc123",
        totalPrice: { amount: 75.0, currencyCode: "USD" },
        lineItems: [
          {
            id: "line_1",
            quantity: 3,
            variant: {
              id: "gid://shopify/ProductVariant/444",
              price: { amount: 25.0, currencyCode: "USD" },
            },
          },
        ],
      },
      "click_oppref_99",
      1700000000000
    );

    assert.equal(payload.event_name, "checkout_started");
    assert.equal(payload.event_id, "tok_abc123");
    assert.equal(payload.custom_data?.value, 7500);
    assert.equal(payload.custom_data?.num_items, 3);
    assert.deepEqual(payload.custom_data?.contents, [
      {
        content_id: "444",
        content_type: "product",
        quantity: 3,
        item_price: 2500,
      },
    ]);
  });

  it("builds correct order_created payload using Shopify Order ID for CAPI deduplication", () => {
    const payload = buildOrderCreatedPayload(
      "fallback_id",
      "https://example.com/checkout/thank_you",
      {
        order: { id: "gid://shopify/Order/77665544" },
        token: "tok_checkout_order",
        totalPrice: { amount: 120.5, currencyCode: "USD" },
        lineItems: [
          {
            id: "line_10",
            quantity: 1,
            variant: {
              id: "gid://shopify/ProductVariant/1010",
              price: { amount: 120.5, currencyCode: "USD" },
            },
          },
        ],
      },
      "click_oppref_99",
      1700000000000
    );

    assert.equal(payload.event_name, "order_created");
    // Verifies order ID is numeric string matching server order ID
    assert.equal(payload.event_id, "77665544");
    assert.equal(payload.custom_data?.value, 12050);
    assert.equal(payload.custom_data?.num_items, 1);
    assert.equal(payload.user_data.click_id, "click_oppref_99");
    assert.deepEqual(payload.custom_data?.contents, [
      {
        content_id: "1010",
        content_type: "product",
        quantity: 1,
        item_price: 12050,
      },
    ]);
  });
});
