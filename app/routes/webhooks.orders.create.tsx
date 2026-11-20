import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { enqueueOrderConversion } from "../services/jobs/conversion-jobs.server.ts";
import { logger } from "../lib/logger.server.ts";

interface ShopifyNoteAttribute {
  name: string;
  value: string;
}

interface ShopifyOrderLineItem {
  id: number | string;
  variant_id?: number | string | null;
  product_id?: number | string | null;
  quantity?: number | null;
  price?: string | null;
}

interface ShopifyOrderWebhookPayload {
  id: number | string;
  created_at: string;
  currency: string;
  total_price: string;
  landing_site?: string | null;
  note_attributes?: ShopifyNoteAttribute[];
  line_items?: ShopifyOrderLineItem[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info(`Received ${topic} webhook for ${shop}`);

  const orderPayload = payload as unknown as ShopifyOrderWebhookPayload;
  if (!orderPayload?.id) {
    logger.warn("Received orders/create webhook without order id", { shop });
    return new Response(null, { status: 200 });
  }

  const shopRecord = await db.shop.findUnique({
    where: { shopDomain: shop },
  });

  if (!shopRecord) {
    logger.warn(`Shop record not found for domain: ${shop}`);
    return new Response(null, { status: 200 });
  }

  const orderIdStr = String(orderPayload.id);

  // 1. Extract oppref click ID from cart note_attributes or landing_site
  const noteAttributes = Array.isArray(orderPayload.note_attributes)
    ? orderPayload.note_attributes
    : [];
  const opprefAttr = noteAttributes.find(
    (attr) => attr && (attr.name === "_oppref" || attr.name === "oppref")
  );

  let clickId = opprefAttr?.value?.trim() || null;

  if (!clickId && orderPayload.landing_site) {
    const match = orderPayload.landing_site.match(/[?&]oppref=([^&#]+)/);
    if (match) {
      try {
        clickId = decodeURIComponent(match[1]).trim();
      } catch {
        clickId = match[1].trim();
      }
    }
  }

  // 2. Parse price in integer minor units (cents)
  const parsedTotal = parseFloat(orderPayload.total_price);
  const totalPriceMinor = !isNaN(parsedTotal) ? Math.round(parsedTotal * 100) : 0;

  // 3. Format line items
  const lineItems = (orderPayload.line_items || []).map((item) => {
    const unitPrice = parseFloat(item.price || "0");
    return {
      variantId: item.variant_id ? String(item.variant_id) : null,
      productId: item.product_id ? String(item.product_id) : null,
      quantity: item.quantity || 1,
      unitPriceMinor: !isNaN(unitPrice) ? Math.round(unitPrice * 100) : 0,
    };
  });

  // 4. Enqueue background conversion job to send to OpenAI CAPI
  try {
    await enqueueOrderConversion({
      shopId: shopRecord.id,
      orderId: orderIdStr,
      createdAt: orderPayload.created_at,
      currency: orderPayload.currency || shopRecord.currency,
      totalPriceMinor,
      shopDomain: shopRecord.shopDomain,
      clickId,
      lineItems,
    });

    logger.info("Enqueued OpenAI CAPI conversion job for order", {
      shopDomain: shop,
      orderId: orderIdStr,
      hasClickId: Boolean(clickId),
    });
  } catch (err: unknown) {
    logger.error("Failed to enqueue order conversion job", {
      shopDomain: shop,
      orderId: orderIdStr,
      error: String(err),
    });
  }

  // Acknowledge webhook immediately
  return new Response(null, { status: 200 });
};
