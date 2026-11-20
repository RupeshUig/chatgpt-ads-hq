/**
 * OpenAI Measurement Pixel Utilities & Payload Builders
 *
 * Implements strict zero-PII live schema matching bzr.openai.com
 */

export interface OpenAILiveEventItem {
  id: string;
  type:
    | "page_viewed"
    | "contents_viewed"
    | "items_added"
    | "checkout_started"
    | "order_created";
  timestamp_ms: number;
  action_source: "web";
  source_url: string;
  user?: {
    click_id?: string;
  };
  data: {
    type: "contents";
    amount?: number; // Integer minor units (e.g. cents)
    currency?: string;
  };
}

export interface OpenAILiveBatchPayload {
  events: OpenAILiveEventItem[];
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
  return Boolean(privacy.analyticsProcessingAllowed) && Boolean(privacy.marketingAllowed);
}

/**
 * Builds user object containing strictly the click_id, NEVER any customer PII
 */
export function buildUserData(clickId?: string | null): { click_id: string } | undefined {
  if (clickId && clickId.trim()) {
    return { click_id: clickId.trim() };
  }
  return undefined;
}

/**
 * Builds standard page_viewed payload
 */
export function buildPageViewPayload(
  eventId: string,
  url: string,
  clickId?: string | null,
  timestampMs: number = Date.now()
): OpenAILiveBatchPayload {
  return {
    events: [
      {
        id: eventId,
        type: "page_viewed",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: url,
        user: buildUserData(clickId),
        data: {
          type: "contents",
        },
      },
    ],
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
): OpenAILiveBatchPayload {
  const priceMinor = toMinorUnits(productVariant?.price?.amount);
  const currency = (productVariant?.price?.currencyCode || "USD").toUpperCase();

  return {
    events: [
      {
        id: eventId,
        type: "contents_viewed",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: url,
        user: buildUserData(clickId),
        data: {
          type: "contents",
          amount: priceMinor,
          currency,
        },
      },
    ],
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
): OpenAILiveBatchPayload {
  const quantity = cartLine?.quantity || 1;
  const unitPriceMinor = toMinorUnits(cartLine?.merchandise?.price?.amount);
  const lineTotalMinor =
    toMinorUnits(cartLine?.cost?.totalAmount?.amount) || unitPriceMinor * quantity;
  const currency = (
    cartLine?.cost?.totalAmount?.currencyCode ||
    cartLine?.merchandise?.price?.currencyCode ||
    "USD"
  ).toUpperCase();

  return {
    events: [
      {
        id: eventId,
        type: "items_added",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: url,
        user: buildUserData(clickId),
        data: {
          type: "contents",
          amount: lineTotalMinor,
          currency,
        },
      },
    ],
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
): OpenAILiveBatchPayload {
  const totalValueMinor = toMinorUnits(checkout?.totalPrice?.amount);
  const currency = (checkout?.totalPrice?.currencyCode || "USD").toUpperCase();

  return {
    events: [
      {
        id: checkout?.token || eventId,
        type: "checkout_started",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: url,
        user: buildUserData(clickId),
        data: {
          type: "contents",
          amount: totalValueMinor,
          currency,
        },
      },
    ],
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
): OpenAILiveBatchPayload {
  const orderId =
    normalizeShopifyId(checkout?.order?.id) ||
    checkout?.token ||
    fallbackEventId;

  const totalValueMinor = toMinorUnits(checkout?.totalPrice?.amount);
  const currency = (checkout?.totalPrice?.currencyCode || "USD").toUpperCase();

  return {
    events: [
      {
        id: orderId,
        type: "order_created",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: url,
        user: buildUserData(clickId),
        data: {
          type: "contents",
          amount: totalValueMinor,
          currency,
        },
      },
    ],
  };
}
