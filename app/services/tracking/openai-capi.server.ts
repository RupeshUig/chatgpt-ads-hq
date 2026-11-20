import { logger } from "../../lib/logger.server.ts";

export const OPENAI_CAPI_ENDPOINT = "https://bzr.openai.com/v1/events";

export interface CapiContentItem {
  content_id: string;
  content_type: "product";
  quantity: number;
  item_price: number; // Integer minor units (cents)
}

export interface CapiCustomData {
  currency: string;
  value: number; // Integer minor units (cents)
  content_type: "product";
  contents?: CapiContentItem[];
  num_items: number;
}

export interface CapiUserData {
  click_id?: string; // Captured from oppref
}

export interface CapiOrderPayload {
  event_name: "order_created";
  event_id: string; // Exact Shopify numeric Order ID matching pixel
  event_time: number; // Unix timestamp in seconds
  event_source_url: string;
  user_data: CapiUserData;
  custom_data: CapiCustomData;
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
 * Builds user_data containing strictly the click_id, NEVER any customer PII.
 * Per OpenAI CAPI docs, identifiers are optional; when not required, send NONE.
 */
export function buildCapiUserData(clickId?: string | null): CapiUserData {
  if (clickId && clickId.trim()) {
    return { click_id: clickId.trim() };
  }
  return {};
}

/**
 * Builds the CAPI order_created payload using the exact same event_id as the Web Pixel.
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
}): CapiOrderPayload {
  const eventId = normalizeShopifyOrderId(options.orderId);
  const currency = (options.currency || "USD").toUpperCase();
  const eventTime = options.createdAt
    ? Math.floor(new Date(options.createdAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const contents: CapiContentItem[] = [];
  let numItems = 0;

  if (options.lineItems) {
    for (const item of options.lineItems) {
      const qty = item.quantity || 1;
      numItems += qty;
      const contentId =
        normalizeShopifyOrderId(item.variantId) ||
        normalizeShopifyOrderId(item.productId);
      const unitPriceMinor = item.unitPriceMinor || 0;

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
    event_id: eventId,
    event_time: eventTime,
    event_source_url: `https://${options.shopDomain}`,
    user_data: buildCapiUserData(options.clickId),
    custom_data: {
      currency,
      value: options.totalPriceMinor,
      content_type: "product",
      num_items: numItems > 0 ? numItems : 1,
      contents: contents.length > 0 ? contents : undefined,
    },
  };
}

/**
 * Dispatches the purchase event to OpenAI Conversions API endpoint.
 * Requires pixelId and encrypted/decrypted conversion key.
 */
export async function sendOpenAiCapiEvent(
  pixelId: string,
  conversionKey: string,
  payload: CapiOrderPayload,
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
      errorData && typeof errorData === "object" && "message" in errorData
        ? String((errorData as { message: unknown }).message)
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
      eventId: payload.event_id,
    });

    return {
      success: false,
      status: 0,
      errorCode: "NETWORK_ERROR",
      errorMessage: err instanceof Error ? err.message : "Unknown network error",
    };
  }
}
