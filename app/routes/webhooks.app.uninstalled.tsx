import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  logger.info(`Received ${topic} webhook for ${shop}`, { shop });

  // 1. Mark the shop as uninstalled and delete its AdsConnection immediately
  const existingShop = await db.shop.findUnique({
    where: { shopDomain: shop },
  });

  if (existingShop) {
    await db.adsConnection.deleteMany({
      where: { shopId: existingShop.id },
    });

    await db.shop.update({
      where: { id: existingShop.id },
      data: { uninstalledAt: new Date() },
    });
  }

  // 2. Clean up shop sessions
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response(null, { status: 200 });
};
