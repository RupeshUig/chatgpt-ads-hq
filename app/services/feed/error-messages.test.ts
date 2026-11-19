import { test, describe } from "node:test";
import assert from "node:assert";
import {
  mapOpenAIError,
  getShopifyProductAdminUrl,
  extractNumericId,
} from "./error-messages.ts";

describe("error-messages: OpenAI Error Mapping", () => {
  const context = {
    shopDomain: "atelier-mandala.myshopify.com",
    shopifyProductId: "gid://shopify/Product/8451234567",
    shopifyVariantId: "gid://shopify/ProductVariant/4451234567",
  };

  test("maps invalid_value on price to exact plain-language message and Shopify admin link", () => {
    const res = mapOpenAIError("invalid_value", "price", undefined, context);

    assert.strictEqual(
      res.plainLanguageReason,
      "Price is missing or invalid for these variants. Add a price in Shopify."
    );
    assert.strictEqual(res.action.type, "OPEN_SHOPIFY_ADMIN");
    assert.strictEqual(res.action.isAutomatic, false);
    assert.strictEqual(
      res.action.url,
      "https://admin.shopify.com/store/atelier-mandala/products/8451234567/variants/4451234567"
    );

    // Also provides one-click exclude action
    assert.ok(res.secondaryAction);
    assert.strictEqual(res.secondaryAction?.type, "EXCLUDE_PRODUCT");
    assert.strictEqual(res.secondaryAction?.isAutomatic, true);
  });

  test("maps invalid_value on url, image_url, and title", () => {
    const urlRes = mapOpenAIError("invalid_value", "url", undefined, context);
    assert.match(urlRes.plainLanguageReason, /Product URL is missing or invalid/);
    assert.strictEqual(urlRes.action.type, "OPEN_SHOPIFY_ADMIN");

    const imgRes = mapOpenAIError("invalid_value", "image_url", undefined, context);
    assert.match(imgRes.plainLanguageReason, /Product image is missing/);
    assert.strictEqual(imgRes.action.type, "OPEN_SHOPIFY_ADMIN");

    const titleRes = mapOpenAIError("invalid_value", "title", undefined, context);
    assert.match(titleRes.plainLanguageReason, /Product title exceeds OpenAI's 150-character limit/);
    assert.strictEqual(titleRes.action.type, "OPEN_SHOPIFY_ADMIN");
  });

  test("maps missing_required_column for essential fields", () => {
    const priceRes = mapOpenAIError("missing_required_column", "price", undefined, context);
    assert.strictEqual(
      priceRes.plainLanguageReason,
      "Price is missing for these variants. Add a price in Shopify."
    );
    assert.strictEqual(priceRes.action.type, "OPEN_SHOPIFY_ADMIN");

    const imgRes = mapOpenAIError("missing_required_column", "image_url", undefined, context);
    assert.strictEqual(
      imgRes.plainLanguageReason,
      "Product image is missing. Add an image in Shopify."
    );

    const titleRes = mapOpenAIError("missing_required_column", "title", undefined, context);
    assert.strictEqual(
      titleRes.plainLanguageReason,
      "Product title is missing. Add a title in Shopify."
    );
  });

  test("maps invalid_sftp_directory_layout to automatic 1-click retry action", () => {
    const res = mapOpenAIError("invalid_sftp_directory_layout");
    assert.match(res.plainLanguageReason, /nested folder.*root directory/);
    assert.strictEqual(res.action.type, "RETRY_FEED_UPLOAD");
    assert.strictEqual(res.action.isAutomatic, true);
    assert.strictEqual(res.action.actionId, "retry_sftp_upload");
  });

  test("maps unsupported_file_type to automatic 1-click retry action", () => {
    const res = mapOpenAIError("unsupported_file_type");
    assert.match(res.plainLanguageReason, /UTF-8 encoded CSV or TSV/);
    assert.strictEqual(res.action.type, "RETRY_FEED_UPLOAD");
    assert.strictEqual(res.action.isAutomatic, true);
  });

  test("maps product_feed_api_disabled to exact required fallback notice", () => {
    const res = mapOpenAIError("product_feed_api_disabled");
    assert.strictEqual(
      res.plainLanguageReason,
      "Product feed access isn't enabled on your ChatGPT Ads account yet. You can keep using the official ChatGPT Ads app for syncing; Cartlight will still check tracking and profit."
    );
    assert.strictEqual(res.action.type, "CONTACT_SUPPORT");
  });

  test("maps product_feed_delta_api_disabled to informational full sync notice", () => {
    const res = mapOpenAIError("product_feed_delta_api_disabled");
    assert.match(res.plainLanguageReason, /Real-time feed delta updates are not enabled/);
    assert.strictEqual(res.action.type, "INFO");
  });
});

describe("error-messages: Shopify Admin Deep Link Helpers", () => {
  test("extractNumericId strips GID prefixes cleanly", () => {
    assert.strictEqual(
      extractNumericId("gid://shopify/Product/1234567890"),
      "1234567890"
    );
    assert.strictEqual(
      extractNumericId("gid://shopify/ProductVariant/9876543210"),
      "9876543210"
    );
    assert.strictEqual(extractNumericId("12345"), "12345");
    assert.strictEqual(extractNumericId(undefined), undefined);
  });

  test("getShopifyProductAdminUrl generates product & variant URLs", () => {
    const shop = "my-test-store.myshopify.com";

    // Product with variant
    const urlWithVariant = getShopifyProductAdminUrl(shop, "gid://shopify/Product/100", "gid://shopify/ProductVariant/200");
    assert.strictEqual(
      urlWithVariant,
      "https://admin.shopify.com/store/my-test-store/products/100/variants/200"
    );

    // Product only
    const urlProductOnly = getShopifyProductAdminUrl(shop, "gid://shopify/Product/100");
    assert.strictEqual(
      urlProductOnly,
      "https://admin.shopify.com/store/my-test-store/products/100"
    );

    // Fallback to store products list
    const urlFallback = getShopifyProductAdminUrl(shop);
    assert.strictEqual(urlFallback, "https://admin.shopify.com/store/my-test-store/products");
  });
});
