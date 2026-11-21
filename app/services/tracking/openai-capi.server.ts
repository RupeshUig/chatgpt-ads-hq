import { logger } from "../../lib/logger.server.ts";
import { fromMinorBigInt } from "../profit/money.server.ts";

export const OPENAI_CAPI_ENDPOINT = "https://bzr.openai.com/v1/events";

export interface CapiEventUser {
  click_id?: string;
}

export interface CapiEventData {
  type: "contents";
  amount?: number; // Integer minor units (cents)
  currency?: string;
}

export interface CapiEventItem {
  id: string; // Stable Shopify numeric Order ID matching pixel
  type:
    | "page_viewed"
    | "contents_viewed"
    | "items_added"
    | "checkout_started"
    | "order_created";
  timestamp_ms: number;
  action_source: "web";
  source_url: string;
  user?: CapiEventUser;
  data: CapiEventData;
}

export interface CapiBatchPayload {
  events: CapiEventItem[];
}

export interface CapiSendResult {
  success: boolean;
  status: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Normalizes Shopify GID to clean numeric ID (e.g., 'gid://shopify/Order/12345' -> '12345')
 */
export function normalizeShopifyOrderId(id: string | number | undefined | null): string {
  if (!id) return "";
  return String(id).replace(/^gid:\/\/shopify\/[A-Za-z]+\//, "").trim();
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
 * Builds user object containing strictly the click_id, NEVER any customer PII.
 */
export function buildCapiUser(clickId?: string | null): CapiEventUser | undefined {
  if (clickId && clickId.trim()) {
    return { click_id: clickId.trim() };
  }
  return undefined;
}

export const buildCapiUserData = buildCapiUser;

/**
 * Builds the CAPI order_created batch payload matching OpenAI live bzr schema.
 */
export function buildCapiPurchasePayload(options: {
  orderId: string | number;
  createdAt?: string | Date | null;
  currency?: string | null;
  totalPriceMinor: number;
  shopDomain: string;
  clickId?: string | null;
  lineItems?: Array<{
    variantId?: string | number | null;
    productId?: string | number | null;
    quantity?: number | null;
    unitPriceMinor?: number | null;
  }> | null;
}): CapiBatchPayload {
  const eventId = normalizeShopifyOrderId(options.orderId);
  const currency = (options.currency || "USD").toUpperCase();
  const timestampMs = options.createdAt
    ? new Date(options.createdAt).getTime()
    : Date.now();

  const user = buildCapiUser(options.clickId);

  return {
    events: [
      {
        id: eventId,
        type: "order_created",
        timestamp_ms: timestampMs,
        action_source: "web",
        source_url: `https://${options.shopDomain}`,
        user,
        data: {
          type: "contents",
          amount: options.totalPriceMinor,
          currency,
        },
      },
    ],
  };
}

/**
 * Dispatches the purchase event to OpenAI Conversions API endpoint.
 */
export async function sendOpenAiCapiEvent(
  pixelId: string,
  conversionKey: string,
  payload: CapiBatchPayload,
  endpointBase: string = OPENAI_CAPI_ENDPOINT
): Promise<CapiSendResult> {
  const cleanPixelId = pixelId.trim();
  const cleanKey = conversionKey.trim();

  if (!cleanPixelId || !cleanKey) {
    return {
      success: false,
      status: 400,
      errorCode: "MISSING_CONFIG",
      errorMessage: "Pixel ID or Conversion Key not configured",
    };
  }

  const url = `${endpointBase}?pid=${encodeURIComponent(cleanPixelId)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cleanKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return {
        success: true,
        status: response.status,
      };
    }

    let errorData: unknown = null;
    try {
      errorData = await response.json();
    } catch {
      // Non-JSON response
    }

    const errorMsg =
      errorData && typeof errorData === "object"
        ? "error" in errorData
          ? JSON.stringify((errorData as { error: unknown }).error)
          : "message" in errorData
          ? String((errorData as { message: unknown }).message)
          : JSON.stringify(errorData)
        : `OpenAI CAPI returned HTTP ${response.status}`;

    // Ensure error message is sanitized and free of customer PII
    const sanitizedError = errorMsg.replace(
      /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
      "[REDACTED_EMAIL]"
    );

    return {
      success: false,
      status: response.status,
      errorCode: String(response.status),
      errorMessage: sanitizedError,
    };
  } catch (err: unknown) {
    logger.error("Network error sending OpenAI CAPI event", {
      error: String(err),
      eventsCount: payload.events?.length,
    });

    return {
      success: false,
      status: 0,
      errorCode: "NETWORK_ERROR",
      errorMessage: err instanceof Error ? err.message : "Unknown network error",
    };
  }
}
