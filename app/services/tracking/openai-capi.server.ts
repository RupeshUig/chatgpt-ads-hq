import { logger } from "../../lib/logger.server.ts";

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
 * Converts float or string amounts into integer minor units (cents)
 */
export function toMinorUnits(amount: number | string | undefined | null): number {
  if (amount == null) return 0;
  const num = typeof amount === "number" ? amount : parseFloat(String(amount));
  return isNaN(num) ? 0 : Math.round(num * 100);
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
