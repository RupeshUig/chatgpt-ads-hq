export type FixActionType =
  | "EXCLUDE_PRODUCT"
  | "OPEN_SHOPIFY_ADMIN"
  | "RETRY_FEED_UPLOAD"
  | "CONTACT_SUPPORT"
  | "INFO";

export interface ActionContext {
  shopDomain?: string;
  shopifyProductId?: string;
  shopifyVariantId?: string;
}

export interface FeedFixAction {
  type: FixActionType;
  label: string;
  isAutomatic: boolean;
  actionId?: string;
  url?: string;
}

export interface FeedErrorResolution {
  code: string;
  field?: string;
  plainLanguageReason: string;
  fixInstruction: string;
  action: FeedFixAction;
  secondaryAction?: FeedFixAction;
}

/**
 * Extracts numeric ID from a Shopify global ID (e.g., gid://shopify/Product/12345 -> 12345).
 */
export function extractNumericId(id?: string | null): string | undefined {
  if (!id) return undefined;
  const match = id.match(/\/(\d+)$/);
  if (match) return match[1];
  if (/^\d+$/.test(id)) return id;
  return id;
}

/**
 * Generates the canonical Shopify Admin deep-link for a product or variant.
 */
export function getShopifyProductAdminUrl(
  shopDomain?: string,
  shopifyProductId?: string,
  shopifyVariantId?: string
): string {
  if (!shopDomain) {
    return "https://admin.shopify.com";
  }

  const shopSlug = shopDomain.replace(/\.myshopify\.com$/i, "");
  const numProductId = extractNumericId(shopifyProductId);
  const numVariantId = extractNumericId(shopifyVariantId);

  if (numProductId && numVariantId) {
    return `https://admin.shopify.com/store/${shopSlug}/products/${numProductId}/variants/${numVariantId}`;
  }

  if (numProductId) {
    return `https://admin.shopify.com/store/${shopSlug}/products/${numProductId}`;
  }

  return `https://admin.shopify.com/store/${shopSlug}/products`;
}

/**
 * Maps documented OpenAI feed error codes and diagnostics to plain-language merchant messages
 * and concrete actionable fixes (either an automatic one-click action or a direct Shopify Admin link).
 */
export function mapOpenAIError(
  code: string,
  field?: string,
  rawMessage?: string,
  context?: ActionContext
): FeedErrorResolution {
  const normalizedCode = (code || "").trim().toLowerCase();
  const normalizedField = (field || "").trim().toLowerCase();

  const adminUrl = getShopifyProductAdminUrl(
    context?.shopDomain,
    context?.shopifyProductId,
    context?.shopifyVariantId
  );

  const excludeAction: FeedFixAction = {
    type: "EXCLUDE_PRODUCT",
    label: "Exclude product from ChatGPT Ads",
    isAutomatic: true,
    actionId: "exclude_product",
  };

  const openShopifyAdminAction: FeedFixAction = {
    type: "OPEN_SHOPIFY_ADMIN",
    label: "Open product in Shopify admin",
    isAutomatic: false,
    url: adminUrl,
  };

  // 1. invalid_value (documented by OpenAI for row field validation)
  if (normalizedCode === "invalid_value") {
    if (normalizedField === "price") {
      return {
        code: "invalid_value",
        field: "price",
        plainLanguageReason:
          "Price is missing or invalid for these variants. Add a price in Shopify.",
        fixInstruction:
          "Open the product in Shopify admin and set a positive price for all variants.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "url") {
      return {
        code: "invalid_value",
        field: "url",
        plainLanguageReason:
          "Product URL is missing or invalid. Check that the product is active and visible.",
        fixInstruction:
          "Ensure the product has a valid handle and is published to your Online Store.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "image_url") {
      return {
        code: "invalid_value",
        field: "image_url",
        plainLanguageReason:
          "Product image is missing or the image URL could not be reached.",
        fixInstruction:
          "Add a public, high-resolution product image in Shopify admin.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "title") {
      return {
        code: "invalid_value",
        field: "title",
        plainLanguageReason:
          "Product title exceeds OpenAI's 150-character limit or is empty.",
        fixInstruction:
          "Shorten the product title to 150 characters or less in Shopify.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "availability") {
      return {
        code: "invalid_value",
        field: "availability",
        plainLanguageReason:
          "Stock availability status is unrecognized.",
        fixInstruction:
          "Update inventory quantity or availability status in Shopify.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    // Generic invalid_value
    const fieldName = field ? `"${field}"` : "attribute";
    return {
      code: "invalid_value",
      field,
      plainLanguageReason: `The value for ${fieldName} does not meet OpenAI feed specifications.`,
      fixInstruction:
        "Update the attribute value in Shopify, or exclude this product from ChatGPT Ads.",
      action: openShopifyAdminAction,
      secondaryAction: excludeAction,
    };
  }

  // 2. missing_required_column (documented by OpenAI for missing schema columns)
  if (normalizedCode === "missing_required_column") {
    if (normalizedField === "price") {
      return {
        code: "missing_required_column",
        field: "price",
        plainLanguageReason:
          "Price is missing for these variants. Add a price in Shopify.",
        fixInstruction:
          "Open the product in Shopify admin and set a positive price for all variants.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "image_url") {
      return {
        code: "missing_required_column",
        field: "image_url",
        plainLanguageReason:
          "Product image is missing. Add an image in Shopify.",
        fixInstruction:
          "Upload a featured product image in Shopify admin.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "title") {
      return {
        code: "missing_required_column",
        field: "title",
        plainLanguageReason:
          "Product title is missing. Add a title in Shopify.",
        fixInstruction:
          "Enter a title for this item in Shopify.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    if (normalizedField === "url") {
      return {
        code: "missing_required_column",
        field: "url",
        plainLanguageReason:
          "Product URL is missing. Ensure the item is published.",
        fixInstruction:
          "Publish this product to the Online Store channel in Shopify.",
        action: openShopifyAdminAction,
        secondaryAction: excludeAction,
      };
    }

    const fieldName = field ? `"${field}"` : "required attribute";
    return {
      code: "missing_required_column",
      field,
      plainLanguageReason: `Required feed column ${fieldName} is missing from the catalog.`,
      fixInstruction:
        "Fill in the missing product information in Shopify admin.",
      action: openShopifyAdminAction,
      secondaryAction: excludeAction,
    };
  }

  // 3. invalid_sftp_directory_layout (documented by OpenAI for nested SFTP folder placement)
  if (normalizedCode === "invalid_sftp_directory_layout") {
    return {
      code: "invalid_sftp_directory_layout",
      plainLanguageReason:
        "Feed file was uploaded to a nested folder. OpenAI requires files directly in the SFTP root directory (/).",
      fixInstruction:
        "Cartlight will automatically stream the feed directly to /catalog.csv on the SFTP root.",
      action: {
        type: "RETRY_FEED_UPLOAD",
        label: "Re-upload feed to SFTP root",
        isAutomatic: true,
        actionId: "retry_sftp_upload",
      },
    };
  }

  // 4. unsupported_file_type (documented by OpenAI for invalid file encoding/extensions)
  if (normalizedCode === "unsupported_file_type") {
    return {
      code: "unsupported_file_type",
      plainLanguageReason:
        "Feed file format is not supported. OpenAI requires UTF-8 encoded CSV or TSV files.",
      fixInstruction:
        "Cartlight generates compliant RFC 4180 UTF-8 CSV catalogs.",
      action: {
        type: "RETRY_FEED_UPLOAD",
        label: "Re-generate & upload valid CSV",
        isAutomatic: true,
        actionId: "retry_sftp_upload",
      },
    };
  }

  // 5. product_feed_api_disabled (documented 403 error for unprovisioned accounts)
  if (normalizedCode === "product_feed_api_disabled") {
    return {
      code: "product_feed_api_disabled",
      plainLanguageReason:
        "Product feed access isn't enabled on your ChatGPT Ads account yet. You can keep using the official ChatGPT Ads app for syncing; Cartlight will still check tracking and profit.",
      fixInstruction:
        "Contact your OpenAI account manager to enable Product Feed API access on your ad account.",
      action: {
        type: "CONTACT_SUPPORT",
        label: "Keep using official app",
        isAutomatic: false,
      },
    };
  }

  // 6. product_feed_delta_api_disabled (documented 403 error for unprovisioned Delta API)
  if (normalizedCode === "product_feed_delta_api_disabled") {
    return {
      code: "product_feed_delta_api_disabled",
      plainLanguageReason:
        "Real-time feed delta updates are not enabled on this ad account yet.",
      fixInstruction:
        "Cartlight will continue using automated full SFTP catalog uploads until delta access is enabled.",
      action: {
        type: "INFO",
        label: "Using full SFTP sync",
        isAutomatic: false,
      },
    };
  }

  // Fallback for any unknown code
  return {
    code,
    field,
    plainLanguageReason: rawMessage || `OpenAI reported an issue with code: "${code}".`,
    fixInstruction:
      "Review this product in Shopify admin or exclude it from ChatGPT Ads.",
    action: openShopifyAdminAction,
    secondaryAction: excludeAction,
  };
}
