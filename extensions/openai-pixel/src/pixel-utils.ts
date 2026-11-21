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
 * Validates and converts a BigInt back into a safe Number.
 * @throws RangeError if BigInt exceeds Number safe integer bounds.
 */
export function fromMinorBigInt(val: bigint): number {
  if (val > BigInt(Number.MAX_SAFE_INTEGER) || val < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`BigInt ${val} exceeds JavaScript Number.isSafeInteger range.`);
  }
  return Number(val);
}

/**
 * ISO 4217 minor unit exponent mapping.
 * Exponent 0: JPY, KRW, VND, CLP, ISK.
 * Exponent 3: KWD, BHD, OMR, JOD, TND, LYD, IQD.
 * Exponent 2: USD, EUR, GBP, CAD, AUD, and default.
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  LYD: 3,
  IQD: 3,
};

export function getCurrencyExponent(currency: string = "USD"): number {
  const code = (currency || "USD").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code)) {
    return CURRENCY_EXPONENTS[code];
  }
  return 2;
}

/**
 * Converts decimal prices into integer minor units without floating-point multiplication (zero float drift).
 * Parses the string representation directly with ISO 4217 exponent and round half away from zero.
 * 
 * - Returns 0 ONLY for null or undefined (intentional default for missing optional amounts).
 * - Throws RangeError for any invalid input:
 *   - Non-finite numbers (NaN, Infinity, -Infinity)
 *   - Scientific notation ("1e-7")
 *   - Malformed strings with commas ("1,299.00"), multiple dots ("1.2.3"), or letters ("abc")
 *   - Empty/whitespace strings
 * - Uses fromMinorBigInt() so amounts exceeding JavaScript safe integer range throw RangeError.
 */
export function toMinorUnits(
  amount: number | string | undefined | null,
  currency: string = "USD"
): number {
  // Intentional default: null or undefined amounts evaluate to 0
  if (amount == null) return 0;

  let str: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || Number.isNaN(amount)) {
      throw new RangeError(`Invalid numeric amount in toMinorUnits: ${amount}`);
    }
    str = amount.toString();
  } else if (typeof amount === "string") {
    str = amount.trim();
  } else {
    throw new RangeError(`Expected number, string, null, or undefined, got ${typeof amount}`);
  }

  if (!str) {
    throw new RangeError("Amount string cannot be empty");
  }

  // Reject scientific notation
  if (/e/i.test(str)) {
    throw new RangeError(`Scientific notation is not supported in toMinorUnits: ${str}`);
  }

  // Reject malformed strings (commas, multiple dots, letters, etc.)
  const isNegative = str.startsWith("-");
  const cleanStr = str.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(cleanStr)) {
    throw new RangeError(`Malformed amount string in toMinorUnits: "${str}"`);
  }

  const parts = cleanStr.split(".");
  const integerPart = parts[0] || "0";
  const fractionalPart = parts[1] || "";

  const exp = getCurrencyExponent(currency);
  const fracLen = fractionalPart.length;

  let minorBigInt: bigint;

  if (fracLen <= exp) {
    const paddedFrac = fractionalPart.padEnd(exp, "0");
    minorBigInt = BigInt(integerPart + paddedFrac);
  } else {
    const fullIntStr = integerPart + fractionalPart;
    const numerator = BigInt(fullIntStr);
    const denominator = 10n ** BigInt(fracLen - exp);

    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const roundUp = 2n * remainder >= denominator;
    minorBigInt = roundUp ? quotient + 1n : quotient;
  }

  const result = fromMinorBigInt(minorBigInt);
  return isNegative ? -result : result;
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
