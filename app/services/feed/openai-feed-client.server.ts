import db from "../../db.server.ts";
import { logger } from "../../lib/logger.server.ts";

export const FEED_DISABLED_MESSAGE =
  "Product feed access isn't enabled on your ChatGPT Ads account yet. You can keep using the official ChatGPT Ads app for syncing; Cartlight will still check tracking and profit.";

export const OPENAI_ADS_API_BASE_URL = "https://api.ads.openai.com/v1";

export interface DeltaVariantInput {
  shopifyProductId: string;
  shopifyVariantId: string;
  priceMinor: number;
  currency: string;
  availability: "in_stock" | "out_of_stock" | string;
}

export interface OpenAIDeltaPayload {
  products: Array<{
    id: string;
    variants: Array<{
      id: string;
      price: {
        amount: number;
        currency: string;
      };
      availability: {
        status: string;
      };
    }>;
  }>;
}

export interface UploadDiagnosticItem {
  code: string;
  row_number?: number;
  item_id?: string;
  message: string;
}

export interface UploadRecord {
  id: string;
  status: "scanning" | "received" | "processing" | "completed" | "completed_with_errors" | "failed" | string;
  total_rows?: number;
  accepted_rows?: number;
  rejected_rows?: number;
  diagnostics?: UploadDiagnosticItem[];
}

export interface UploadHistoryResponse {
  success: boolean;
  isFeedAccessDisabled: boolean;
  errorMessage?: string;
  latestUpload?: UploadRecord;
}

/**
 * Transforms a flat list of variant deltas into OpenAI's nested product-variant Delta API payload.
 * Prices are strictly formatted in integer minor units (e.g. 2999 cents).
 */
export function buildDeltaPayload(deltas: DeltaVariantInput[]): OpenAIDeltaPayload {
  const productMap = new Map<
    string,
    Array<{
      id: string;
      price: { amount: number; currency: string };
      availability: { status: string };
    }>
  >();

  for (const delta of deltas) {
    const parentId = delta.shopifyProductId;
    if (!productMap.has(parentId)) {
      productMap.set(parentId, []);
    }

    productMap.get(parentId)!.push({
      id: delta.shopifyVariantId,
      price: {
        amount: Math.round(delta.priceMinor),
        currency: delta.currency.toUpperCase(),
      },
      availability: {
        status: delta.availability === "out_of_stock" ? "out_of_stock" : "in_stock",
      },
    });
  }

  const products = Array.from(productMap.entries()).map(([productId, variants]) => ({
    id: productId,
    variants,
  }));

  return { products };
}

/**
 * Sends a delta update request to the OpenAI Advertiser API.
 */
export async function sendFeedDeltaUpdates(
  apiKey: string,
  feedId: string,
  deltas: DeltaVariantInput[]
): Promise<{ success: boolean; isFeedAccessDisabled: boolean; errorMessage?: string }> {
  if (deltas.length === 0) {
    return { success: true, isFeedAccessDisabled: false };
  }

  const payload = buildDeltaPayload(deltas);
  const endpoint = `${OPENAI_ADS_API_BASE_URL}/feeds/${encodeURIComponent(feedId)}/products`;

  try {
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 403) {
      const data = await response.json().catch(() => ({}));
      logger.warn("Feed Delta API returned 403 Forbidden", { feedId, data });
      return {
        success: false,
        isFeedAccessDisabled: true,
        errorMessage: FEED_DISABLED_MESSAGE,
      };
    }

    if (!response.ok) {
      const errBody = await response.text();
      logger.error("Feed Delta API error", { status: response.status, body: errBody });
      return {
        success: false,
        isFeedAccessDisabled: false,
        errorMessage: `Delta API responded with status ${response.status}: ${errBody}`,
      };
    }

    logger.info("Successfully sent feed delta updates", {
      feedId,
      variantCount: deltas.length,
      productCount: payload.products.length,
    });

    return { success: true, isFeedAccessDisabled: false };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Network failure calling Feed Delta API", { error: errorMsg, feedId });
    return {
      success: false,
      isFeedAccessDisabled: false,
      errorMessage: errorMsg,
    };
  }
}

/**
 * Queries upload history and row diagnostics from the OpenAI Advertiser API.
 */
export async function fetchUploadHistory(
  apiKey: string,
  feedId: string
): Promise<UploadHistoryResponse> {
  const endpoint = `${OPENAI_ADS_API_BASE_URL}/feeds/uploads?feed_id=${encodeURIComponent(feedId)}`;

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 403) {
      logger.warn("Feed Uploads API returned 403 Forbidden", { feedId });
      return {
        success: false,
        isFeedAccessDisabled: true,
        errorMessage: FEED_DISABLED_MESSAGE,
      };
    }

    if (!response.ok) {
      const errBody = await response.text();
      return {
        success: false,
        isFeedAccessDisabled: false,
        errorMessage: `Failed to fetch upload history (${response.status}): ${errBody}`,
      };
    }

    const json = (await response.json()) as { data?: UploadRecord[] };
    const uploads = json.data || [];
    const latestUpload = uploads[0];

    return {
      success: true,
      isFeedAccessDisabled: false,
      latestUpload,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Network error fetching feed upload history", { error: errorMsg, feedId });
    return {
      success: false,
      isFeedAccessDisabled: false,
      errorMessage: errorMsg,
    };
  }
}

/**
 * Updates Product sync statuses in the database based on OpenAI upload diagnostics.
 */
export async function applyDiagnosticsToProducts(
  shopId: string,
  diagnostics: UploadDiagnosticItem[]
): Promise<{ updatedCount: number; rejectedCount: number }> {
  let rejectedCount = 0;

  for (const diag of diagnostics) {
    if (diag.item_id) {
      const reason = `OpenAI rejection [${diag.code}]: ${diag.message}`;
      const res = await db.product.updateMany({
        where: { shopId, shopifyVariantId: diag.item_id },
        data: {
          syncStatus: "REJECTED",
          rejectReason: reason,
        },
      });
      if (res.count > 0) rejectedCount++;
    }
  }

  logger.info("Applied OpenAI upload diagnostics to shop products", {
    shopId,
    rejectedUpdated: rejectedCount,
  });

  return { updatedCount: diagnostics.length, rejectedCount };
}
