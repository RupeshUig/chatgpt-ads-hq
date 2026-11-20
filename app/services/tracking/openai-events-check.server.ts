import db from "../../db.server.ts";
import { decrypt } from "../../lib/crypto.server.ts";
import { logger } from "../../lib/logger.server.ts";
import { OPENAI_ADS_API_BASE_URL } from "../feed/openai-feed-client.server.ts";
import { normalizeShopifyOrderId } from "./openai-capi.server.ts";

export interface EventHealthStatus {
  eventName:
    | "page_viewed"
    | "contents_viewed"
    | "items_added"
    | "checkout_started"
    | "order_created";
  displayName: string;
  status: "active" | "inactive";
  count: number;
  lastSeenAt: string | null;
}

export interface PurchaseGapItem {
  orderId: string;
  orderName: string;
  createdAt: string;
  amountMinor: number;
  currency: string;
  hasOppref: boolean;
  opprefValue?: string | null;
  capiStatus: "SUCCESS" | "FAILED" | "SKIPPED" | "NOT_SENT";
  gapType: "NONE" | "ORGANIC" | "GAP_FAILED" | "GAP_MISSING" | "GAP_SKIPPED";
  gapReason?: string;
}

export interface PurchaseGapAnalysis {
  totalShopifyOrders: number;
  attributedOrders: number;
  syncedPurchases: number;
  gapCount: number;
  gaps: PurchaseGapItem[];
  allOrders: PurchaseGapItem[];
}

const STANDARD_EVENT_DISPLAY_NAMES: Record<
  EventHealthStatus["eventName"],
  string
> = {
  page_viewed: "Page View",
  contents_viewed: "Product View",
  items_added: "Add to Cart",
  checkout_started: "Checkout Started",
  order_created: "Purchase (Order Created)",
};

/**
 * Checks recent event delivery from OpenAI Events Check endpoint (last ~15 minutes).
 * Falls back to database logs and graceful defaults if credentials are not configured or OpenAI API is unreachable.
 */
export async function checkOpenAiEventsHealth(
  shopId: string
): Promise<{
  isConnected: boolean;
  pixelId: string | null;
  events: EventHealthStatus[];
  windowMinutes: number;
  lastCheckedAt: string;
}> {
  const windowMinutes = 15;
  const fifteenMinutesAgo = new Date(Date.now() - windowMinutes * 60 * 1000);

  const connection = await db.adsConnection.findUnique({
    where: { shopId },
  });

  const pixelId = connection?.pixelId || null;
  const isConfigured = Boolean(
    pixelId && (connection?.encryptedConversionKey || connection?.encryptedApiKey)
  );

  // Initialize all 5 standard events with inactive default state
  const eventMap: Record<EventHealthStatus["eventName"], EventHealthStatus> = {
    page_viewed: {
      eventName: "page_viewed",
      displayName: STANDARD_EVENT_DISPLAY_NAMES.page_viewed,
      status: "inactive",
      count: 0,
      lastSeenAt: null,
    },
    contents_viewed: {
      eventName: "contents_viewed",
      displayName: STANDARD_EVENT_DISPLAY_NAMES.contents_viewed,
      status: "inactive",
      count: 0,
      lastSeenAt: null,
    },
    items_added: {
      eventName: "items_added",
      displayName: STANDARD_EVENT_DISPLAY_NAMES.items_added,
      status: "inactive",
      count: 0,
      lastSeenAt: null,
    },
    checkout_started: {
      eventName: "checkout_started",
      displayName: STANDARD_EVENT_DISPLAY_NAMES.checkout_started,
      status: "inactive",
      count: 0,
      lastSeenAt: null,
    },
    order_created: {
      eventName: "order_created",
      displayName: STANDARD_EVENT_DISPLAY_NAMES.order_created,
      status: "inactive",
      count: 0,
      lastSeenAt: null,
    },
  };

  // 1. Check local ConversionSendLog for purchases within the last 15 minutes
  const recentSuccessfulPurchases = await db.conversionSendLog.findMany({
    where: {
      shopId,
      eventName: "order_created",
      status: "SUCCESS",
      sentAt: { gte: fifteenMinutesAgo },
    },
    orderBy: { sentAt: "desc" },
  });

  if (recentSuccessfulPurchases.length > 0) {
    eventMap.order_created.count = recentSuccessfulPurchases.length;
    eventMap.order_created.status = "active";
    eventMap.order_created.lastSeenAt =
      recentSuccessfulPurchases[0].sentAt.toISOString();
  }

  // 2. Query remote OpenAI Events Check endpoint if configured
  if (isConfigured && pixelId && connection) {
    try {
      const apiKeyOrConversionKey = connection.encryptedConversionKey
        ? decrypt(connection.encryptedConversionKey)
        : decrypt(connection.encryptedApiKey);

      const endpoint = `${OPENAI_ADS_API_BASE_URL}/measurement/pixels/${encodeURIComponent(
        pixelId
      )}/events/recent?window_minutes=${windowMinutes}`;

      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKeyOrConversionKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const json = (await response.json()) as {
          events?: Array<{
            event_name: string;
            count?: number;
            last_seen_at?: string;
          }>;
        };

        if (Array.isArray(json.events)) {
          for (const ev of json.events) {
            const name = ev.event_name as EventHealthStatus["eventName"];
            if (eventMap[name]) {
              const count = ev.count || 0;
              if (count > 0) {
                eventMap[name].count = Math.max(eventMap[name].count, count);
                eventMap[name].status = "active";
                if (ev.last_seen_at) {
                  eventMap[name].lastSeenAt = ev.last_seen_at;
                }
              }
            }
          }
        }
      } else {
        logger.warn("OpenAI events check endpoint returned non-200", {
          status: response.status,
          pixelId,
        });
      }
    } catch (err: unknown) {
      logger.warn("Failed to fetch OpenAI events check endpoint", {
        error: String(err),
      });
    }
  }

  return {
    isConnected: isConfigured,
    pixelId,
    events: Object.values(eventMap),
    windowMinutes,
    lastCheckedAt: new Date().toISOString(),
  };
}

/**
 * Compares Shopify orders from the last 24 hours against OpenAI Conversions API send logs
 * and flags gaps where orders with ChatGPT Ads attribution were not successfully reported.
 */
export async function analyzePurchaseGaps(
  shopId: string,
  rawShopifyOrders: Array<{
    id: string;
    name: string;
    createdAt: string;
    totalPriceSet?: {
      shopMoney?: {
        amount?: string | number;
        currencyCode?: string;
      };
    };
    customAttributes?: Array<{ key: string; value: string }>;
  }>
): Promise<PurchaseGapAnalysis> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch all CAPI conversion logs for this shop in the last 24 hours
  const logs = await db.conversionSendLog.findMany({
    where: {
      shopId,
      sentAt: { gte: twentyFourHoursAgo },
    },
  });

  const logByOrderId = new Map<string, (typeof logs)[0]>();
  for (const log of logs) {
    logByOrderId.set(log.eventId, log);
  }

  const allItems: PurchaseGapItem[] = [];
  const gaps: PurchaseGapItem[] = [];
  let attributedCount = 0;
  let syncedCount = 0;

  for (const shopifyOrder of rawShopifyOrders) {
    const numericOrderId = normalizeShopifyOrderId(shopifyOrder.id);
    const amountStr = shopifyOrder.totalPriceSet?.shopMoney?.amount || "0";
    const currency =
      shopifyOrder.totalPriceSet?.shopMoney?.currencyCode || "USD";
    const amountMinor = Math.round(parseFloat(String(amountStr)) * 100);

    // Check for oppref in customAttributes
    const customAttrs = Array.isArray(shopifyOrder.customAttributes)
      ? shopifyOrder.customAttributes
      : [];
    const opprefAttr = customAttrs.find(
      (a) => a.key === "_oppref" || a.key === "oppref"
    );
    const hasOppref = Boolean(opprefAttr && opprefAttr.value?.trim());
    const opprefValue = opprefAttr?.value?.trim() || null;

    if (hasOppref) {
      attributedCount++;
    }

    const conversionLog = logByOrderId.get(numericOrderId);
    let capiStatus: PurchaseGapItem["capiStatus"] = "NOT_SENT";
    if (conversionLog) {
      if (conversionLog.status === "SUCCESS") capiStatus = "SUCCESS";
      else if (conversionLog.status === "FAILED") capiStatus = "FAILED";
      else if (conversionLog.status === "SKIPPED") capiStatus = "SKIPPED";
    }

    let gapType: PurchaseGapItem["gapType"] = "NONE";
    let gapReason: string | undefined;

    if (capiStatus === "SUCCESS") {
      syncedCount++;
      gapType = "NONE";
    } else if (!hasOppref) {
      gapType = "ORGANIC";
      gapReason = "Organic Shopify order (no ChatGPT Ads click ID)";
    } else if (capiStatus === "FAILED") {
      gapType = "GAP_FAILED";
      gapReason = conversionLog?.errorMessage || "OpenAI CAPI delivery failed";
      gaps.push({
        orderId: numericOrderId,
        orderName: shopifyOrder.name,
        createdAt: shopifyOrder.createdAt,
        amountMinor,
        currency,
        hasOppref,
        opprefValue,
        capiStatus,
        gapType,
        gapReason,
      });
    } else if (capiStatus === "SKIPPED") {
      gapType = "GAP_SKIPPED";
      gapReason =
        conversionLog?.errorMessage ||
        "Skipped: Missing OpenAI Pixel ID or Conversion Key";
      gaps.push({
        orderId: numericOrderId,
        orderName: shopifyOrder.name,
        createdAt: shopifyOrder.createdAt,
        amountMinor,
        currency,
        hasOppref,
        opprefValue,
        capiStatus,
        gapType,
        gapReason,
      });
    } else {
      // Order had oppref, but was never sent via CAPI (missing log)
      gapType = "GAP_MISSING";
      gapReason = "Attributed order not received or queued for CAPI";
      gaps.push({
        orderId: numericOrderId,
        orderName: shopifyOrder.name,
        createdAt: shopifyOrder.createdAt,
        amountMinor,
        currency,
        hasOppref,
        opprefValue,
        capiStatus,
        gapType,
        gapReason,
      });
    }

    allItems.push({
      orderId: numericOrderId,
      orderName: shopifyOrder.name,
      createdAt: shopifyOrder.createdAt,
      amountMinor,
      currency,
      hasOppref,
      opprefValue,
      capiStatus,
      gapType,
      gapReason,
    });
  }

  return {
    totalShopifyOrders: rawShopifyOrders.length,
    attributedOrders: attributedCount,
    syncedPurchases: syncedCount,
    gapCount: gaps.length,
    gaps,
    allOrders: allItems,
  };
}
