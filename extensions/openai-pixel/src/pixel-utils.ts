/**
 * OpenAI Measurement Pixel Utilities & Payload Builders
 *
 * Implements strict zero-PII event schemas and deduplication logic
 * for the OpenAI Measurement Pixel & Conversions API.
 */

export interface OpenAIContentItem {
  content_id: string;
  content_type: "product";
  quantity: number;
  item_price: number; // Integer minor units (e.g. cents)
}

export interface OpenAICustomData {
  currency?: string;
  value?: number; // Integer minor units (e.g. cents)
  content_type?: "product";
  contents?: OpenAIContentItem[];
  num_items?: number;
}

export interface OpenAIUserData {
  click_id?: string; // Captured from oppref URL param / cookie
}

export interface OpenAIEventPayload {
  event_name:
    | "page_viewed"
    | "contents_viewed"
    | "items_added"
    | "checkout_started"
    | "order_created";
  event_id: string; // Used for deduplication (pid + event_id)
  event_time: number; // Unix timestamp in seconds
  event_source_url: string;
  user_data: OpenAIUserData;
  custom_data?: OpenAICustomData;
}

export interface ProductVariantInput {
  id?: string | number | null;
  price?: { amount?: number | string | null; currencyCode?: string | null } | null;
  product?: { id?: string | number | null; title?: string | null } | null;
}

export interface CartLineInput {
  quantity?: number | null;
  cost?: { totalAmount?: { amount?: number | string | null; currencyCode?: string | null } | null } | null;
  merchandise?: {
    id?: string | number | null;
    price?: { amount?: number | string | null; currencyCode?: string | null } | null;
    product?: { id?: string | number | null } | null;
  } | null;
}

export interface CheckoutLineItemInput {
  id?: string | number | null;
  quantity?: number | null;
  variant?: {
    id?: string | number | null;
    price?: { amount?: number | string | null; currencyCode?: string | null } | null;
    product?: { id?: string | number | null } | null;
  } | null;
}

export interface CheckoutInput {
  order?: { id?: string | number | null } | null;
  token?: string | null;
  totalPrice?: { amount?: number | string | null; currencyCode?: string | null } | null;
  lineItems?: CheckoutLineItemInput[] | null;
}

/**
 * Normalizes Shopify GID to numeric ID (e.g., 'gid://shopify/ProductVariant/12345' -> '12345')
 */
export function normalizeShopifyId(id: string | number | undefined | null): string {
  if (!id) return "";
  return String(id).replace(/^gid:\/\/shopify\/[A-Za-z]+\//, "").trim();
}

/**
 * Converts dollar float amounts into integer minor units (cents)
 * e.g. 29.99 -> 2999, 10 -> 1000
 */
export function toMinorUnits(amount: number | string | undefined | null): number {
  if (amount == null) return 0;
  const num = typeof amount === "number" ? amount : parseFloat(String(amount));
  return isNaN(num) ? 0 : Math.round(num * 100);
}

/**
 * Extracts the 'oppref' click ID from a URL query string
 */
export function extractOppref(urlStr: string | undefined | null): string | null {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    const oppref = url.searchParams.get("oppref");
    return oppref ? oppref.trim() : null;
  } catch {
    // If invalid URL, fallback to regex
    const match = urlStr.match(/[?&]oppref=([^&#]+)/);
    return match ? decodeURIComponent(match[1]).trim() : null;
  }
}

/**
 * Evaluates Shopify Customer Privacy API flags for analytics & marketing tracking
 */
export function hasUserConsent(privacy?: {
  analyticsProcessingAllowed?: boolean | null;
  marketingAllowed?: boolean | null;
} | null): boolean {
  if (!privacy) return false;
  // OpenAI advertising pixel requires marketing and analytics consent
  return Boolean(privacy.analyticsProcessingAllowed) && Boolean(privacy.marketingAllowed);
}

/**
 * Builds user_data containing strictly the click_id, NEVER any customer PII
 */
export function buildUserData(clickId?: string | null): OpenAIUserData {
  if (clickId && clickId.trim()) {
    return { click_id: clickId.trim() };
  }
  return {};
}

/**
 * Builds standard page_viewed payload
 */
export function buildPageViewPayload(
  eventId: string,
  url: string,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAIEventPayload {
  return {
    event_name: "page_viewed",
    event_id: eventId,
    event_time: Math.floor(timestampMs / 1000),
    event_source_url: url,
    user_data: buildUserData(clickId),
  };
}

/**
 * Builds contents_viewed payload (Shopify product_viewed)
 */
export function buildProductViewPayload(
  eventId: string,
  url: string,
  productVariant?: ProductVariantInput | null,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAIEventPayload {
  const priceMinor = toMinorUnits(productVariant?.price?.amount);
  const currency = productVariant?.price?.currencyCode || "USD";
  const contentId =
    normalizeShopifyId(productVariant?.id) ||
    normalizeShopifyId(productVariant?.product?.id);

  const customData: OpenAICustomData = {
    content_type: "product",
    currency,
    value: priceMinor,
    num_items: 1,
  };

  if (contentId) {
    customData.contents = [
      {
        content_id: contentId,
        content_type: "product",
        quantity: 1,
        item_price: priceMinor,
      },
    ];
  }

  return {
    event_name: "contents_viewed",
    event_id: eventId,
    event_time: Math.floor(timestampMs / 1000),
    event_source_url: url,
    user_data: buildUserData(clickId),
    custom_data: customData,
  };
}

/**
 * Builds items_added payload (Shopify product_added_to_cart)
 */
export function buildAddToCartPayload(
  eventId: string,
  url: string,
  cartLine?: CartLineInput | null,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAIEventPayload {
  const quantity = cartLine?.quantity || 1;
  const unitPriceMinor = toMinorUnits(cartLine?.merchandise?.price?.amount);
  const lineTotalMinor =
    toMinorUnits(cartLine?.cost?.totalAmount?.amount) || unitPriceMinor * quantity;
  const currency =
    cartLine?.cost?.totalAmount?.currencyCode ||
    cartLine?.merchandise?.price?.currencyCode ||
    "USD";
  const contentId =
    normalizeShopifyId(cartLine?.merchandise?.id) ||
    normalizeShopifyId(cartLine?.merchandise?.product?.id);

  const customData: OpenAICustomData = {
    content_type: "product",
    currency,
    value: lineTotalMinor,
    num_items: quantity,
  };

  if (contentId) {
    customData.contents = [
      {
        content_id: contentId,
        content_type: "product",
        quantity,
        item_price: unitPriceMinor,
      },
    ];
  }

  return {
    event_name: "items_added",
    event_id: eventId,
    event_time: Math.floor(timestampMs / 1000),
    event_source_url: url,
    user_data: buildUserData(clickId),
    custom_data: customData,
  };
}

/**
 * Builds checkout_started payload (Shopify checkout_started)
 */
export function buildCheckoutStartedPayload(
  eventId: string,
  url: string,
  checkout?: CheckoutInput | null,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAIEventPayload {
  const totalValueMinor = toMinorUnits(checkout?.totalPrice?.amount);
  const currency = checkout?.totalPrice?.currencyCode || "USD";

  const contents: OpenAIContentItem[] = [];
  let numItems = 0;

  if (checkout?.lineItems) {
    for (const item of checkout.lineItems) {
      const qty = item.quantity || 1;
      numItems += qty;
      const contentId =
        normalizeShopifyId(item.variant?.id) ||
        normalizeShopifyId(item.variant?.product?.id) ||
        normalizeShopifyId(item.id);
      const unitPriceMinor = toMinorUnits(item.variant?.price?.amount);

      if (contentId) {
        contents.push({
          content_id: contentId,
          content_type: "product",
          quantity: qty,
          item_price: unitPriceMinor,
        });
      }
    }
  }

  return {
    event_name: "checkout_started",
    event_id: checkout?.token || eventId,
    event_time: Math.floor(timestampMs / 1000),
    event_source_url: url,
    user_data: buildUserData(clickId),
    custom_data: {
      content_type: "product",
      currency,
      value: totalValueMinor,
      num_items: numItems,
      contents: contents.length > 0 ? contents : undefined,
    },
  };
}

/**
 * Builds order_created payload (Shopify checkout_completed)
 * CRITICAL: Uses Shopify Order ID as event_id so CAPI server events match and deduplicate.
 */
export function buildOrderCreatedPayload(
  fallbackEventId: string,
  url: string,
  checkout?: CheckoutInput | null,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAIEventPayload {
  const orderId =
    normalizeShopifyId(checkout?.order?.id) ||
    checkout?.token ||
    fallbackEventId;

  const totalValueMinor = toMinorUnits(checkout?.totalPrice?.amount);
  const currency = checkout?.totalPrice?.currencyCode || "USD";

  const contents: OpenAIContentItem[] = [];
  let numItems = 0;

  if (checkout?.lineItems) {
    for (const item of checkout.lineItems) {
      const qty = item.quantity || 1;
      numItems += qty;
      const contentId =
        normalizeShopifyId(item.variant?.id) ||
        normalizeShopifyId(item.variant?.product?.id) ||
        normalizeShopifyId(item.id);
      const unitPriceMinor = toMinorUnits(item.variant?.price?.amount);

      if (contentId) {
        contents.push({
          content_id: contentId,
          content_type: "product",
          quantity: qty,
          item_price: unitPriceMinor,
        });
      }
    }
  }

  return {
    event_name: "order_created",
    event_id: orderId,
    event_time: Math.floor(timestampMs / 1000),
    event_source_url: url,
    user_data: buildUserData(clickId),
    custom_data: {
      content_type: "product",
      currency,
      value: totalValueMinor,
      num_items: numItems,
      contents: contents.length > 0 ? contents : undefined,
    },
  };
}
