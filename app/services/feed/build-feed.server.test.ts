import { test, describe } from "node:test";
import assert from "node:assert";
import {
  validateFeedProduct,
  evaluateFeedRules,
  formatFeedRow,
  buildFeedCsv,
  cleanDescription,
  type FeedProductInput,
  type FeedRuleConditions,
} from "./build-feed.server.ts";

function createValidProduct(overrides?: Partial<FeedProductInput>): FeedProductInput {
  return {
    id: "prod_1",
    shopifyProductId: "gid://shopify/Product/123456789",
    shopifyVariantId: "gid://shopify/ProductVariant/987654321",
    title: "Organic Cold Brew Coffee - 12 Pack",
    description: "<p>Refreshing cold brew made with 100% Arabica beans.</p>",
    url: "https://shop.example.com/products/cold-brew-12-pack",
    imageUrl: "https://cdn.example.com/images/cold-brew.png",
    brand: "Atelier Coffee",
    vendor: "Atelier Roasters",
    sellerName: "Atelier Mandala",
    priceMinor: 2499,
    costMinor: 850,
    currency: "USD",
    availability: "in_stock",
    inventoryQuantity: 50,
    tags: ["beverage", "organic", "cold-brew"],
    collections: ["best-sellers", "summer-drinks"],
    hasVariations: false,
    ...overrides,
  };
}

describe("build-feed: Product Pre-upload Validation", () => {
  test("valid product passes all checks", () => {
    const product = createValidProduct();
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.rejectReason, undefined);
  });

  test("rejects zero price with plain-language reason", () => {
    const product = createValidProduct({ priceMinor: 0 });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product price is missing or zero/);
  });

  test("rejects negative price with plain-language reason", () => {
    const product = createValidProduct({ priceMinor: -500 });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product price is missing or zero/);
  });

  test("rejects missing or empty title", () => {
    const product = createValidProduct({ title: "   " });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product title is missing/);
  });

  test("rejects title exceeding 150 characters with exact length in reason", () => {
    const longTitle = "A".repeat(151);
    const product = createValidProduct({ title: longTitle });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product title exceeds 150 characters \(got 151\)/);
  });

  test("allows title with exactly 150 characters", () => {
    const exactTitle = "A".repeat(150);
    const product = createValidProduct({ title: exactTitle });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, true);
  });

  test("rejects missing product URL", () => {
    const product = createValidProduct({ url: "" });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product URL is missing/);
  });

  test("rejects malformed product URL", () => {
    const product = createValidProduct({ url: "not-a-valid-url" });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product URL is invalid/);
  });

  test("rejects non-http/https URL protocol", () => {
    const product = createValidProduct({ url: "ftp://example.com/file" });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product URL is invalid/);
  });

  test("rejects missing image URL", () => {
    const product = createValidProduct({ imageUrl: null });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product image URL is missing/);
  });

  test("rejects malformed image URL", () => {
    const product = createValidProduct({ imageUrl: "invalid-image-path" });
    const result = validateFeedProduct(product);
    assert.strictEqual(result.isValid, false);
    assert.match(result.rejectReason!, /Product image URL is invalid/);
  });
});

describe("build-feed: Include/Exclude Rules", () => {
  test("excludes out-of-stock product when inStockOnly rule is active", () => {
    const product = createValidProduct({ availability: "out_of_stock", inventoryQuantity: 0 });
    const rules: FeedRuleConditions[] = [{ inStockOnly: true }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /Out of stock/);
  });

  test("allows in-stock product when inStockOnly rule is active", () => {
    const product = createValidProduct({ availability: "in_stock", inventoryQuantity: 10 });
    const rules: FeedRuleConditions[] = [{ inStockOnly: true }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, false);
  });

  test("excludes product below minimum price threshold", () => {
    const product = createValidProduct({ priceMinor: 999 }); // $9.99
    const rules: FeedRuleConditions[] = [{ minPriceMinor: 1500 }]; // $15.00 min
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /below minimum threshold \(\$15\.00\)/);
  });

  test("excludes product above maximum price threshold", () => {
    const product = createValidProduct({ priceMinor: 12000 }); // $120.00
    const rules: FeedRuleConditions[] = [{ maxPriceMinor: 10000 }]; // $100.00 max
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /exceeds maximum threshold \(\$100\.00\)/);
  });

  test("excludes product with excluded tag (case-insensitive)", () => {
    const product = createValidProduct({ tags: ["wholesale", "clearance"] });
    const rules: FeedRuleConditions[] = [{ excludeTags: ["CLEARANCE"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /excluded tag "CLEARANCE"/);
  });

  test("excludes product missing required inclusion tag", () => {
    const product = createValidProduct({ tags: ["clothing"] });
    const rules: FeedRuleConditions[] = [{ includeTags: ["featured", "bestseller"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /does not match any required inclusion tag/);
  });

  test("allows product matching at least one inclusion tag", () => {
    const product = createValidProduct({ tags: ["clothing", "featured"] });
    const rules: FeedRuleConditions[] = [{ includeTags: ["featured", "bestseller"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, false);
  });

  test("excludes product matching excluded vendor", () => {
    const product = createValidProduct({ vendor: "Discontinued Supplier" });
    const rules: FeedRuleConditions[] = [{ excludeVendors: ["Discontinued Supplier"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /Vendor "Discontinued Supplier" is excluded/);
  });

  test("excludes product not in included vendors list", () => {
    const product = createValidProduct({ vendor: "Third-Party Merchant" });
    const rules: FeedRuleConditions[] = [{ includeVendors: ["Atelier Roasters", "Partner Coffee"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /is not in the included vendors list/);
  });

  test("excludes product in excluded collection", () => {
    const product = createValidProduct({ collections: ["seasonal", "archived"] });
    const rules: FeedRuleConditions[] = [{ excludeCollections: ["archived"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /excluded collection "archived"/);
  });

  test("excludes product not in included collections", () => {
    const product = createValidProduct({ collections: ["accessories"] });
    const rules: FeedRuleConditions[] = [{ includeCollections: ["apparel", "footwear"] }];
    const result = evaluateFeedRules(product, rules);
    assert.strictEqual(result.isExcluded, true);
    assert.match(result.excludeReason!, /is not in any of the required inclusion collections/);
  });
});

describe("build-feed: Description Sanitization & CSV Formatting", () => {
  test("cleanDescription removes HTML tags and collapses spaces", () => {
    const raw = "<div><p>Hello <strong>World</strong>!</p><ul><li>Item 1</li></ul></div>";
    const cleaned = cleanDescription(raw);
    assert.strictEqual(cleaned, "Hello World ! Item 1");
  });

  test("formatFeedRow converts minor price cents into major decimal + currency", () => {
    const product = createValidProduct({ priceMinor: 4999, currency: "USD" });
    const row = formatFeedRow(product);
    assert.strictEqual(row.price, "49.99 USD");
    assert.strictEqual(row.is_ads_eligible, "true");
    assert.strictEqual(row.is_eligible_search, "true");
  });

  test("formatFeedRow serializes variant info when hasVariations is true", () => {
    const product = createValidProduct({
      hasVariations: true,
      shopifyProductId: "gid://shopify/Product/111",
      shopifyVariantId: "gid://shopify/ProductVariant/222",
      variantOptions: { Size: "Medium", Color: "Navy" },
    });
    const row = formatFeedRow(product);
    assert.strictEqual(row.group_id, "gid://shopify/Product/111");
    assert.strictEqual(row.listing_has_variations, "true");
    assert.strictEqual(row.variant_dict, JSON.stringify({ Size: "Medium", Color: "Navy" }));
  });

  test("buildFeedCsv generates RFC 4180 compliant CSV with escaped commas and quotes", () => {
    const product1 = createValidProduct({
      title: 'T-Shirt, "Limited Edition"',
      description: "A cool, comfortable t-shirt with a vintage vibe.",
    });
    const row1 = formatFeedRow(product1);
    const csv = buildFeedCsv([row1]);

    const lines = csv.split("\n");
    assert.strictEqual(lines.length, 2); // header + 1 data row
    assert.match(lines[0], /^item_id,title,description,url,brand/);
    // Escaped title should be surrounded by quotes with doubled interior quotes
    assert.ok(lines[1].includes('"T-Shirt, ""Limited Edition"""'));
  });
});
