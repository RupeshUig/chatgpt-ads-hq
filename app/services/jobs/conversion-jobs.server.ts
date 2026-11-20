import db from "../../db.server.ts";
import { getBoss } from "./boss.server.ts";
import {
  buildCapiPurchasePayload,
  sendOpenAiCapiEvent,
  normalizeShopifyOrderId,
} from "../tracking/openai-capi.server.ts";
import { decrypt } from "../../lib/crypto.server.ts";
import { logger } from "../../lib/logger.server.ts";

export const CONVERSION_QUEUES = {
  ORDER_CONVERSION: "order-conversion-sync",
} as const;

export interface OrderConversionJobData {
  shopId: string;
  orderId: string | number;
  createdAt: string;
  currency: string;
  totalPriceMinor: number;
  shopDomain: string;
  clickId?: string | null;
  lineItems?: Array<{
    variantId?: string | number | null;
    productId?: string | number | null;
    quantity?: number | null;
    unitPriceMinor?: number | null;
  }> | null;
}

/**
 * Enqueues an order conversion sync job to pg-boss.
 */
export async function enqueueOrderConversion(
  data: OrderConversionJobData
): Promise<string | null> {
  const boss = getBoss();
  return boss.send(CONVERSION_QUEUES.ORDER_CONVERSION, data);
}

/**
 * Worker handler for processing order conversions and dispatching to OpenAI CAPI.
 * Records send status to ConversionSendLog with zero customer personal data.
 */
export async function handleOrderConversion(
  jobs: Array<{ data: OrderConversionJobData }>
): Promise<void> {
  for (const job of jobs) {
    const data = job.data;
    const numericOrderId = normalizeShopifyOrderId(data.orderId);

    logger.info("Processing order conversion job for OpenAI CAPI", {
      shopId: data.shopId,
      orderId: numericOrderId,
      hasClickId: Boolean(data.clickId),
    });

    const connection = await db.adsConnection.findUnique({
      where: { shopId: data.shopId },
    });

    // 1. Missing Connection or Credentials Handling
    if (!connection) {
      await db.conversionSendLog.create({
        data: {
          shopId: data.shopId,
          eventId: numericOrderId,
          eventName: "order_created",
          status: "SKIPPED",
          errorCode: "NO_CONNECTION",
          errorMessage: "AdsConnection not configured for shop",
          hasClickId: Boolean(data.clickId),
        },
      });
      continue;
    }

    const pixelId = connection.pixelId?.trim() || "";
    const encryptedKey = connection.encryptedConversionKey?.trim() || "";

    if (!pixelId || !encryptedKey) {
      await db.conversionSendLog.create({
        data: {
          shopId: data.shopId,
          eventId: numericOrderId,
          eventName: "order_created",
          status: "SKIPPED",
          errorCode: "MISSING_CONFIG",
          errorMessage: "OpenAI Pixel ID or Conversion Key not configured",
          hasClickId: Boolean(data.clickId),
        },
      });
      continue;
    }

    // 2. Decrypt Conversion Key
    let conversionKey = "";
    try {
      conversionKey = decrypt(encryptedKey);
    } catch (err: unknown) {
      logger.error("Failed to decrypt conversion key for shop", {
        shopId: data.shopId,
        error: String(err),
      });

      await db.conversionSendLog.create({
        data: {
          shopId: data.shopId,
          eventId: numericOrderId,
          eventName: "order_created",
          status: "FAILED",
          errorCode: "DECRYPTION_ERROR",
          errorMessage: "Could not decrypt conversion key",
          hasClickId: Boolean(data.clickId),
        },
      });
      continue;
    }

    // 3. Build Payload & Dispatch CAPI Event
    const payload = buildCapiPurchasePayload({
      orderId: numericOrderId,
      createdAt: data.createdAt,
      currency: data.currency,
      totalPriceMinor: data.totalPriceMinor,
      shopDomain: data.shopDomain,
      clickId: data.clickId,
      lineItems: data.lineItems,
    });

    const result = await sendOpenAiCapiEvent(pixelId, conversionKey, payload);

    // 4. Record Send Log (Strict Zero Customer PII)
    await db.conversionSendLog.create({
      data: {
        shopId: data.shopId,
        eventId: numericOrderId,
        eventName: "order_created",
        status: result.success ? "SUCCESS" : "FAILED",
        errorCode: result.errorCode || null,
        errorMessage: result.errorMessage || null,
        hasClickId: Boolean(data.clickId),
      },
    });

    logger.info("OpenAI CAPI conversion dispatch complete", {
      shopId: data.shopId,
      orderId: numericOrderId,
      status: result.success ? "SUCCESS" : "FAILED",
      statusHttp: result.status,
    });
  }
}

/**
 * Registers background workers with pg-boss for order conversion CAPI dispatch.
 */
export async function registerConversionWorkers(): Promise<void> {
  const boss = getBoss();
  await boss.work(CONVERSION_QUEUES.ORDER_CONVERSION, handleOrderConversion);
  logger.info("Conversion workers registered with pg-boss");
}
