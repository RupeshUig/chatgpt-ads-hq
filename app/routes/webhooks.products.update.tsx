import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { enqueueDebouncedDeltaSync } from "../services/jobs/feed-jobs.server.ts";
import { logger } from "../lib/logger.server.ts";

interface ShopifyWebhookVariant {
  id: number | string;
  product_id: number | string;
  title: string;
  price: string;
  inventory_quantity?: number | null;
  sku?: string | null;
}

interface ShopifyProductWebhookPayload {
  id: number | string;
  title: string;
  vendor?: string | null;
  variants?: ShopifyWebhookVariant[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info(`Received ${topic} webhook for ${shop}`);

  const productPayload = payload as unknown as ShopifyProductWebhookPayload;
  if (!productPayload?.id || !productPayload?.variants) {
    return new Response(null, { status: 200 });
  }

  const shopRecord = await db.shop.findUnique({
    where: { shopDomain: shop },
  });

  if (!shopRecord) {
    logger.warn(`Shop record not found for domain: ${shop}`);
    return new Response(null, { status: 200 });
  }

  const productIdStr = String(productPayload.id);

  for (const variant of productPayload.variants) {
    const variantIdStr = String(variant.id);
    const parsedPrice = parseFloat(variant.price);
    const priceMinor = !isNaN(parsedPrice) ? Math.round(parsedPrice * 100) : 0;
    const availability =
      variant.inventory_quantity !== undefined &&
      variant.inventory_quantity !== null &&
      variant.inventory_quantity <= 0
        ? "out_of_stock"
        : "in_stock";

    // 1. Update or create the product variant record in PostgreSQL
    await db.product.upsert({
      where: {
        shopId_shopifyVariantId: {
          shopId: shopRecord.id,
          shopifyVariantId: variantIdStr,
        },
      },
      create: {
        shopId: shopRecord.id,
        shopifyProductId: productIdStr,
        shopifyVariantId: variantIdStr,
        title: `${productPayload.title}${
          variant.title && variant.title !== "Default Title" ? ` - ${variant.title}` : ""
        }`,
        priceMinor,
        currency: shopRecord.currency,
        syncStatus: "PENDING",
      },
      update: {
        priceMinor,
        title: `${productPayload.title}${
          variant.title && variant.title !== "Default Title" ? ` - ${variant.title}` : ""
        }`,
      },
    });

    // 2. Buffer delta change for OpenAI feed
    await db.feedDelta.upsert({
      where: {
        shopId_shopifyVariantId: {
          shopId: shopRecord.id,
          shopifyVariantId: variantIdStr,
        },
      },
      create: {
        shopId: shopRecord.id,
        shopifyProductId: productIdStr,
        shopifyVariantId: variantIdStr,
        priceMinor,
        currency: shopRecord.currency,
        availability,
        status: "PENDING",
      },
      update: {
        priceMinor,
        availability,
        status: "PENDING",
        errorMessage: null,
      },
    });
  }

  // 3. Enqueue debounced delta sync (batches updates over 3 minutes)
  try {
    await enqueueDebouncedDeltaSync(shopRecord.id, 180);
  } catch (err: unknown) {
    logger.error("Failed to enqueue debounced delta sync job", {
      shop: shopRecord.shopDomain,
      error: String(err),
    });
  }

  return new Response(null, { status: 200 });
};
