import db from "../../db.server.ts";

export interface FeedProductInput {
  id: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  description?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  brand?: string | null;
  sellerName?: string | null;
  priceMinor: number;
  costMinor?: number | null;
  currency: string;
  availability?: "in_stock" | "out_of_stock" | "pre_order" | "backorder" | "unknown";
  inventoryQuantity?: number | null;
  vendor?: string | null;
  tags?: string[];
  collections?: string[];
  sku?: string | null;
  barcode?: string | null;
  hasVariations?: boolean;
  variantOptions?: Record<string, string>;
}

export interface FeedRuleConditions {
  includeCollections?: string[];
  excludeCollections?: string[];
  includeTags?: string[];
  excludeTags?: string[];
  includeVendors?: string[];
  excludeVendors?: string[];
  minPriceMinor?: number;
  maxPriceMinor?: number;
  inStockOnly?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  rejectReason?: string;
}

export interface RuleEvaluationResult {
  isExcluded: boolean;
  excludeReason?: string;
}

export interface OpenAIFeedRow {
  item_id: string;
  title: string;
  description: string;
  url: string;
  brand: string;
  seller_name: string;
  image_url: string;
  availability: string;
  price: string;
  group_id?: string;
  listing_has_variations?: string;
  variant_dict?: string;
  is_ads_eligible: string;
  is_eligible_search: string;
}

export interface BuildFeedResult {
  total: number;
  synced: number;
  rejected: number;
  excluded: number;
  rows: OpenAIFeedRow[];
  csv: string;
  rejections: Array<{ id: string; title: string; reason: string }>;
  exclusions: Array<{ id: string; title: string; reason: string }>;
}

/**
 * Validates a single product input against OpenAI catalog requirements.
 * Catches issues early with plain-language rejection reasons before OpenAI does.
 */
export function validateFeedProduct(product: FeedProductInput): ValidationResult {
  // 1. Price validation
  if (
    typeof product.priceMinor !== "number" ||
    isNaN(product.priceMinor) ||
    product.priceMinor <= 0
  ) {
    return {
      isValid: false,
      rejectReason:
        "Product price is missing or zero. A valid positive price is required.",
    };
  }

  // 2. Title validation
  const trimmedTitle = product.title?.trim();
  if (!trimmedTitle) {
    return {
      isValid: false,
      rejectReason: "Product title is missing. A non-empty title is required.",
    };
  }

  if (trimmedTitle.length > 150) {
    return {
      isValid: false,
      rejectReason: `Product title exceeds 150 characters (got ${trimmedTitle.length}). Must be 150 characters or less.`,
    };
  }

  // 3. Product URL validation
  const url = product.url?.trim();
  if (!url) {
    return {
      isValid: false,
      rejectReason:
        "Product URL is missing. An absolute HTTP or HTTPS URL is required.",
    };
  }

  try {
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        isValid: false,
        rejectReason:
          "Product URL is invalid. An absolute HTTP or HTTPS URL is required.",
      };
    }
  } catch {
    return {
      isValid: false,
      rejectReason:
        "Product URL is invalid. An absolute HTTP or HTTPS URL is required.",
    };
  }

  // 4. Product Image URL validation
  const imageUrl = product.imageUrl?.trim();
  if (!imageUrl) {
    return {
      isValid: false,
      rejectReason:
        "Product image URL is missing. A valid public product image is required.",
    };
  }

  try {
    const parsedImageUrl = new URL(imageUrl);
    if (!["http:", "https:"].includes(parsedImageUrl.protocol)) {
      return {
        isValid: false,
        rejectReason:
          "Product image URL is invalid. An absolute HTTP or HTTPS URL is required.",
      };
    }
  } catch {
    return {
      isValid: false,
      rejectReason:
        "Product image URL is invalid. An absolute HTTP or HTTPS URL is required.",
    };
  }

  return { isValid: true };
}

/**
 * Evaluates shop include/exclude rules against a product.
 * Supports filtering by in-stock only, price range, tags, vendors, and collections.
 */
export function evaluateFeedRules(
  product: FeedProductInput,
  rules: FeedRuleConditions[]
): RuleEvaluationResult {
  for (const rule of rules) {
    // 1. In-stock only filter
    if (rule.inStockOnly) {
      const isOutOfStock =
        product.availability === "out_of_stock" ||
        (product.inventoryQuantity !== undefined &&
          product.inventoryQuantity !== null &&
          product.inventoryQuantity <= 0);

      if (isOutOfStock) {
        return {
          isExcluded: true,
          excludeReason: "Excluded: Out of stock (in-stock only rule)",
        };
      }
    }

    // 2. Minimum price filter
    if (
      rule.minPriceMinor !== undefined &&
      product.priceMinor < rule.minPriceMinor
    ) {
      return {
        isExcluded: true,
        excludeReason: `Excluded: Price ($${(product.priceMinor / 100).toFixed(
          2
        )}) is below minimum threshold ($${(rule.minPriceMinor / 100).toFixed(
          2
        )})`,
      };
    }

    // 3. Maximum price filter
    if (
      rule.maxPriceMinor !== undefined &&
      product.priceMinor > rule.maxPriceMinor
    ) {
      return {
        isExcluded: true,
        excludeReason: `Excluded: Price ($${(product.priceMinor / 100).toFixed(
          2
        )}) exceeds maximum threshold ($${(rule.maxPriceMinor / 100).toFixed(
          2
        )})`,
      };
    }

    // 4. Excluded tags
    if (rule.excludeTags && rule.excludeTags.length > 0 && product.tags) {
      const productTagsLower = product.tags.map((t) => t.toLowerCase().trim());
      for (const excludedTag of rule.excludeTags) {
        if (productTagsLower.includes(excludedTag.toLowerCase().trim())) {
          return {
            isExcluded: true,
            excludeReason: `Excluded: Product contains excluded tag "${excludedTag}"`,
          };
        }
      }
    }

    // 5. Included tags (must match at least one if list is non-empty)
    if (rule.includeTags && rule.includeTags.length > 0) {
      const productTagsLower = (product.tags || []).map((t) =>
        t.toLowerCase().trim()
      );
      const hasMatch = rule.includeTags.some((t) =>
        productTagsLower.includes(t.toLowerCase().trim())
      );
      if (!hasMatch) {
        return {
          isExcluded: true,
          excludeReason:
            "Excluded: Product does not match any required inclusion tag",
        };
      }
    }

    // 6. Excluded vendors
    if (rule.excludeVendors && rule.excludeVendors.length > 0 && product.vendor) {
      const vendorLower = product.vendor.toLowerCase().trim();
      for (const excludedVendor of rule.excludeVendors) {
        if (vendorLower === excludedVendor.toLowerCase().trim()) {
          return {
            isExcluded: true,
            excludeReason: `Excluded: Vendor "${product.vendor}" is excluded`,
          };
        }
      }
    }

    // 7. Included vendors
    if (rule.includeVendors && rule.includeVendors.length > 0) {
      const vendorLower = (product.vendor || "").toLowerCase().trim();
      const hasMatch = rule.includeVendors.some(
        (v) => vendorLower === v.toLowerCase().trim()
      );
      if (!hasMatch) {
        return {
          isExcluded: true,
          excludeReason: `Excluded: Vendor "${product.vendor || "Unknown"}" is not in the included vendors list`,
        };
      }
    }

    // 8. Excluded collections
    if (
      rule.excludeCollections &&
      rule.excludeCollections.length > 0 &&
      product.collections
    ) {
      const productColsLower = product.collections.map((c) =>
        c.toLowerCase().trim()
      );
      for (const excludedCol of rule.excludeCollections) {
        if (productColsLower.includes(excludedCol.toLowerCase().trim())) {
          return {
            isExcluded: true,
            excludeReason: `Excluded: Product belongs to excluded collection "${excludedCol}"`,
          };
        }
      }
    }

    // 9. Included collections
    if (rule.includeCollections && rule.includeCollections.length > 0) {
      const productColsLower = (product.collections || []).map((c) =>
        c.toLowerCase().trim()
      );
      const hasMatch = rule.includeCollections.some((c) =>
        productColsLower.includes(c.toLowerCase().trim())
      );
      if (!hasMatch) {
        return {
          isExcluded: true,
          excludeReason:
            "Excluded: Product is not in any of the required inclusion collections",
        };
      }
    }
  }

  return { isExcluded: false };
}

/**
 * Strips HTML tags and normalizes whitespace for clean plain-text feed descriptions.
 */
export function cleanDescription(raw?: string | null): string {
  if (!raw) return "";
  const withoutHtml = raw.replace(/<[^>]*>/g, " ");
  const normalized = withoutHtml.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 5000);
}

/**
 * Formats a validated and included product into an OpenAI feed row.
 */
export function formatFeedRow(product: FeedProductInput): OpenAIFeedRow {
  // Resolve availability
  let availability = product.availability;
  if (!availability) {
    if (
      product.inventoryQuantity !== undefined &&
      product.inventoryQuantity !== null
    ) {
      availability = product.inventoryQuantity > 0 ? "in_stock" : "out_of_stock";
    } else {
      availability = "in_stock";
    }
  }

  // Format price in major units with 3-letter currency code (e.g., 29.99 USD)
  const formattedPrice = `${(product.priceMinor / 100).toFixed(2)} ${product.currency.toUpperCase()}`;

  const description =
    cleanDescription(product.description) || product.title.trim();

  return {
    item_id: product.shopifyVariantId || product.id,
    title: product.title.trim(),
    description,
    url: product.url!.trim(),
    brand: product.brand?.trim() || product.vendor?.trim() || "Generic",
    seller_name: product.sellerName?.trim() || "Store",
    image_url: product.imageUrl!.trim(),
    availability,
    price: formattedPrice,
    group_id: product.hasVariations ? product.shopifyProductId : undefined,
    listing_has_variations: product.hasVariations ? "true" : undefined,
    variant_dict:
      product.variantOptions && Object.keys(product.variantOptions).length > 0
        ? JSON.stringify(product.variantOptions)
        : undefined,
    is_ads_eligible: "true",
    is_eligible_search: "true",
  };
}

/**
 * Serializes rows to RFC 4180 compliant CSV.
 */
export function buildFeedCsv(rows: OpenAIFeedRow[]): string {
  const headers = [
    "item_id",
    "title",
    "description",
    "url",
    "brand",
    "seller_name",
    "image_url",
    "availability",
    "price",
    "group_id",
    "listing_has_variations",
    "variant_dict",
    "is_ads_eligible",
    "is_eligible_search",
  ];

  const escapeCsv = (val: string | undefined): string => {
    if (val === undefined || val === null) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvRows = [headers.join(",")];

  for (const row of rows) {
    const line = [
      escapeCsv(row.item_id),
      escapeCsv(row.title),
      escapeCsv(row.description),
      escapeCsv(row.url),
      escapeCsv(row.brand),
      escapeCsv(row.seller_name),
      escapeCsv(row.image_url),
      escapeCsv(row.availability),
      escapeCsv(row.price),
      escapeCsv(row.group_id),
      escapeCsv(row.listing_has_variations),
      escapeCsv(row.variant_dict),
      escapeCsv(row.is_ads_eligible),
      escapeCsv(row.is_eligible_search),
    ];
    csvRows.push(line.join(","));
  }

  return csvRows.join("\n");
}

/**
 * Builds the complete feed for a shop:
 * 1. Loads rules from PostgreSQL for the shop.
 * 2. Evaluates each product input against validations and rules.
 * 3. Updates database product sync statuses (SYNCED, REJECTED, EXCLUDED).
 * 4. Generates OpenAI compliant CSV string.
 */
export async function buildFeedForShop(
  shopId: string,
  productsInput?: FeedProductInput[]
): Promise<BuildFeedResult> {
  // 1. Fetch active rules for the shop
  const activeRules = await db.rule.findMany({
    where: { shopId, status: "ACTIVE" },
  });

  const ruleConditions: FeedRuleConditions[] = activeRules.map(
    (r) => r.conditions as unknown as FeedRuleConditions
  );

  // 2. Fetch products if not passed directly
  let products = productsInput;
  if (!products) {
    const dbProducts = await db.product.findMany({
      where: { shopId },
    });

    products = dbProducts.map((p) => ({
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      shopifyVariantId: p.shopifyVariantId,
      title: p.title,
      priceMinor: p.priceMinor,
      costMinor: p.costMinor,
      currency: p.currency,
      availability: "in_stock",
    }));
  }

  const validRows: OpenAIFeedRow[] = [];
  const rejections: Array<{ id: string; title: string; reason: string }> = [];
  const exclusions: Array<{ id: string; title: string; reason: string }> = [];

  for (const product of products) {
    // Step A: Validation
    const validation = validateFeedProduct(product);
    if (!validation.isValid) {
      rejections.push({
        id: product.id,
        title: product.title,
        reason: validation.rejectReason!,
      });

      await db.product.updateMany({
        where: { shopId, shopifyVariantId: product.shopifyVariantId },
        data: {
          syncStatus: "REJECTED",
          rejectReason: validation.rejectReason,
        },
      });
      continue;
    }

    // Step B: Rule Evaluation
    const ruleEval = evaluateFeedRules(product, ruleConditions);
    if (ruleEval.isExcluded) {
      exclusions.push({
        id: product.id,
        title: product.title,
        reason: ruleEval.excludeReason!,
      });

      await db.product.updateMany({
        where: { shopId, shopifyVariantId: product.shopifyVariantId },
        data: {
          syncStatus: "EXCLUDED",
          rejectReason: ruleEval.excludeReason,
        },
      });
      continue;
    }

    // Step C: Passed validation and rules
    const row = formatFeedRow(product);
    validRows.push(row);

    await db.product.updateMany({
      where: { shopId, shopifyVariantId: product.shopifyVariantId },
      data: {
        syncStatus: "SYNCED",
        rejectReason: null,
      },
    });
  }

  const csv = buildFeedCsv(validRows);

  return {
    total: products.length,
    synced: validRows.length,
    rejected: rejections.length,
    excluded: exclusions.length,
    rows: validRows,
    csv,
    rejections,
    exclusions,
  };
}
