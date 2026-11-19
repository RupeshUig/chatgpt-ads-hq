import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info(`Received ${topic} webhook. Purging all data for shop`, { shop });

  // Deleting the Shop record cascades to delete AdsConnection, Product,
  // DailyInsight, Rule, Alert, and AuditLog records automatically.
  await db.shop.deleteMany({
    where: { shopDomain: shop },
  });

  // Clean up any remaining sessions
  await db.session.deleteMany({
    where: { shop },
  });

  return new Response(null, { status: 200 });
};
