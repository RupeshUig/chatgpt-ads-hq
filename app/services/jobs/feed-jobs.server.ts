import db from "../../db.server.ts";
import { getBoss } from "./boss.server.ts";
import { buildFeedForShop } from "../feed/build-feed.server.ts";
import { uploadFeedViaSftp } from "../feed/sftp-upload.server.ts";
import {
  fetchUploadHistory,
  sendFeedDeltaUpdates,
  applyDiagnosticsToProducts,
  FEED_DISABLED_MESSAGE,
} from "../feed/openai-feed-client.server.ts";
import { decrypt } from "../../lib/crypto.server.ts";
import { logger } from "../../lib/logger.server.ts";

export const QUEUES = {
  FULL_FEED_UPLOAD: "feed-full-upload",
  DELTA_FEED_SYNC: "feed-delta-sync",
} as const;

/**
 * Enqueues a full feed upload job for a given shop.
 */
export async function enqueueFullFeedUpload(shopId: string): Promise<string | null> {
  const boss = getBoss();
  return boss.send(QUEUES.FULL_FEED_UPLOAD, { shopId });
}

/**
 * Enqueues a debounced delta sync job for a shop.
 * The job is debounced by 3 minutes (180 seconds) so that multiple variant/product
 * updates in Shopify batch cleanly into a single Delta API PATCH request.
 */
export async function enqueueDebouncedDeltaSync(
  shopId: string,
  debounceSeconds: number = 180
): Promise<string | null> {
  const boss = getBoss();
  return boss.sendDebounced(
    QUEUES.DELTA_FEED_SYNC,
    { shopId },
    null,
    debounceSeconds,
    `delta-sync-${shopId}`
  );
}

/**
 * Worker handler for processing full feed uploads via SFTP and querying upload history.
 */
export async function handleFullFeedUpload(jobs: Array<{ data: { shopId: string } }>): Promise<void> {
  for (const job of jobs) {
    const { shopId } = job.data;
    logger.info("Starting full feed upload job", { shopId });

    const connection = await db.adsConnection.findUnique({
      where: { shopId },
    });

    if (!connection || !connection.sftpHost || !connection.sftpUsername || !connection.feedId) {
      logger.warn("Skipping full feed upload: SFTP credentials or feedId not configured", { shopId });
      continue;
    }

    // 1. Build and validate feed products
    const feedResult = await buildFeedForShop(shopId);

    // 2. Upload feed CSV directly to SFTP root
    const sftpResult = await uploadFeedViaSftp(
      {
        host: connection.sftpHost,
        port: connection.sftpPort ?? 22,
        username: connection.sftpUsername,
        encryptedPassword: connection.encryptedSftpPassword,
        encryptedPrivateKey: connection.encryptedSftpPrivateKey,
      },
      feedResult.csv,
      "catalog.csv"
    );

    if (!sftpResult.success) {
      await db.adsConnection.update({
        where: { shopId },
        data: {
          lastFeedUploadStatus: `SFTP_FAILED: ${sftpResult.error}`,
        },
      });
      continue;
    }

    // 3. Query upload history from OpenAI API to track ingestion & row errors
    const apiKey = decrypt(connection.encryptedApiKey);
    const historyResult = await fetchUploadHistory(apiKey, connection.feedId);

    if (historyResult.isFeedAccessDisabled) {
      await db.adsConnection.update({
        where: { shopId },
        data: {
          feedAccessStatus: "DISABLED_403",
          feedAccessMessage: FEED_DISABLED_MESSAGE,
          lastFeedUploadStatus: "FAILED_403",
        },
      });
      continue;
    }

    if (historyResult.latestUpload?.diagnostics && historyResult.latestUpload.diagnostics.length > 0) {
      await applyDiagnosticsToProducts(shopId, historyResult.latestUpload.diagnostics);
    }

    await db.adsConnection.update({
      where: { shopId },
      data: {
        feedAccessStatus: "ENABLED",
        feedAccessMessage: null,
        lastFeedUploadAt: new Date(),
        lastFeedUploadStatus: historyResult.latestUpload?.status || "COMPLETED",
      },
    });

    logger.info("Completed full feed upload job", {
      shopId,
      syncedRows: feedResult.synced,
      rejectedRows: feedResult.rejected,
    });
  }
}

/**
 * Worker handler for sending batched price and stock delta updates via the Delta API.
 */
export async function handleDeltaFeedSync(jobs: Array<{ data: { shopId: string } }>): Promise<void> {
  for (const job of jobs) {
    const { shopId } = job.data;
    logger.info("Starting batched delta feed sync", { shopId });

    const connection = await db.adsConnection.findUnique({
      where: { shopId },
    });

    if (!connection || !connection.feedId) {
      logger.warn("Skipping delta feed sync: no AdsConnection or feedId found", { shopId });
      continue;
    }

    // 1. Fetch pending deltas for this shop
    const pendingDeltas = await db.feedDelta.findMany({
      where: { shopId, status: "PENDING" },
    });

    if (pendingDeltas.length === 0) {
      logger.info("No pending feed deltas to process", { shopId });
      continue;
    }

    // 2. Send delta updates to OpenAI
    const apiKey = decrypt(connection.encryptedApiKey);
    const result = await sendFeedDeltaUpdates(
      apiKey,
      connection.feedId,
      pendingDeltas.map((d) => ({
        shopifyProductId: d.shopifyProductId,
        shopifyVariantId: d.shopifyVariantId,
        priceMinor: d.priceMinor,
        currency: d.currency,
        availability: d.availability,
      }))
    );

    if (result.isFeedAccessDisabled) {
      await db.adsConnection.update({
        where: { shopId },
        data: {
          feedAccessStatus: "DISABLED_403",
          feedAccessMessage: FEED_DISABLED_MESSAGE,
        },
      });

      await db.feedDelta.updateMany({
        where: { id: { in: pendingDeltas.map((d) => d.id) } },
        data: {
          status: "FAILED",
          errorMessage: result.errorMessage,
        },
      });
      continue;
    }

    if (!result.success) {
      await db.feedDelta.updateMany({
        where: { id: { in: pendingDeltas.map((d) => d.id) } },
        data: {
          status: "FAILED",
          errorMessage: result.errorMessage,
        },
      });
      continue;
    }

    // 3. Mark deltas as SYNCED
    await db.feedDelta.updateMany({
      where: { id: { in: pendingDeltas.map((d) => d.id) } },
      data: {
        status: "SYNCED",
        errorMessage: null,
      },
    });

    logger.info("Successfully completed batched delta feed sync", {
      shopId,
      syncedVariants: pendingDeltas.length,
    });
  }
}

/**
 * Registers background workers with pg-boss for feed upload and delta sync.
 */
export async function registerFeedWorkers(): Promise<void> {
  const boss = getBoss();
  await boss.work(QUEUES.FULL_FEED_UPLOAD, handleFullFeedUpload);
  await boss.work(QUEUES.DELTA_FEED_SYNC, handleDeltaFeedSync);
  logger.info("Feed workers registered with pg-boss");
}
