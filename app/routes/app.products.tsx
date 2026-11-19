import { useState, useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import type { Prisma, SyncStatus } from "@prisma/client";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  FEED_DISABLED_MESSAGE,
  OPENAI_ADS_API_BASE_URL,
} from "../services/feed/openai-feed-client.server.ts";
import { enqueueFullFeedUpload } from "../services/jobs/feed-jobs.server.ts";
import { mapOpenAIError } from "../services/feed/error-messages.ts";
import { decrypt } from "../lib/crypto.server.ts";
import { logger } from "../lib/logger.server.ts";

const COOLDOWN_SECONDS = 300; // 5-minute cooldown between manual full resyncs

export interface PriceStockMismatch {
  productId: string;
  variantId: string;
  title: string;
  localPriceMinor: number;
  remotePriceMinor?: number;
  currency: string;
  localAvailability: string;
  remoteAvailability?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // 1. Aggregated Counts
  const [syncedCount, rejectedCount, excludedCount, pendingCount, totalCount] =
    await Promise.all([
      db.product.count({ where: { shopId: shop.id, syncStatus: "SYNCED" } }),
      db.product.count({ where: { shopId: shop.id, syncStatus: "REJECTED" } }),
      db.product.count({ where: { shopId: shop.id, syncStatus: "EXCLUDED" } }),
      db.product.count({ where: { shopId: shop.id, syncStatus: "PENDING" } }),
      db.product.count({ where: { shopId: shop.id } }),
    ]);

  // 2. Query Params for Filtering & Pagination
  const url = new URL(request.url);
  const statusParam = (url.searchParams.get("status") || "ALL").toUpperCase();
  const searchQuery = url.searchParams.get("q")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = 15;

  const where: Prisma.ProductWhereInput = {
    shopId: shop.id,
  };

  if (statusParam !== "ALL") {
    where.syncStatus = statusParam as SyncStatus;
  }

  if (searchQuery) {
    where.title = { contains: searchQuery, mode: "insensitive" };
  }

  const [filteredCount, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));

  // 3. Resync Cooldown Calculation
  let isCooldownActive = false;
  let cooldownRemainingSeconds = 0;
  if (shop.adsConnection?.lastFeedUploadAt) {
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date(shop.adsConnection.lastFeedUploadAt).getTime()) / 1000
    );
    if (elapsedSeconds < COOLDOWN_SECONDS) {
      isCooldownActive = true;
      cooldownRemainingSeconds = COOLDOWN_SECONDS - elapsedSeconds;
    }
  }

  // 4. Price & Stock Discrepancy Check (Querying GET /v1/feeds/{feed_id}/products)
  const isFeedAccessDisabled =
    shop.adsConnection?.feedAccessStatus === "DISABLED_403";
  const feedAccessMessage =
    shop.adsConnection?.feedAccessMessage || FEED_DISABLED_MESSAGE;

  let mismatches: PriceStockMismatch[] | null = null;
  let mismatchCheckStatus: "connected" | "no_feed" | "error" = "no_feed";

  if (
    shop.adsConnection?.feedId &&
    shop.adsConnection?.encryptedApiKey &&
    !isFeedAccessDisabled
  ) {
    try {
      const apiKey = decrypt(shop.adsConnection.encryptedApiKey);
      const feedId = shop.adsConnection.feedId;
      const endpoint = `${OPENAI_ADS_API_BASE_URL}/feeds/${encodeURIComponent(feedId)}/products?limit=50`;

      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        mismatchCheckStatus = "connected";
        const json = (await response.json()) as {
          data?: Array<{
            id: string;
            variants?: Array<{
              id: string;
              price?: { amount: number; currency: string };
              availability?: { status: string };
            }>;
          }>;
        };

        const remoteProducts = json.data || [];
        const detectedMismatches: PriceStockMismatch[] = [];

        // Build a lookup map of remote variants
        const remoteVariantMap = new Map<
          string,
          { priceAmount?: number; availability?: string }
        >();

        for (const rProd of remoteProducts) {
          if (rProd.variants) {
            for (const rVar of rProd.variants) {
              remoteVariantMap.set(rVar.id, {
                priceAmount: rVar.price?.amount,
                availability: rVar.availability?.status,
              });
            }
          }
        }

        // Compare with local products
        for (const localProd of products) {
          const remoteData = remoteVariantMap.get(localProd.shopifyVariantId);
          if (remoteData) {
            const hasPriceDiff =
              remoteData.priceAmount !== undefined &&
              remoteData.priceAmount !== localProd.priceMinor;
            const hasStockDiff =
              remoteData.availability !== undefined &&
              localProd.syncStatus === "EXCLUDED" &&
              remoteData.availability !== "out_of_stock";

            if (hasPriceDiff || hasStockDiff) {
              detectedMismatches.push({
                productId: localProd.shopifyProductId,
                variantId: localProd.shopifyVariantId,
                title: localProd.title,
                localPriceMinor: localProd.priceMinor,
                remotePriceMinor: remoteData.priceAmount,
                currency: localProd.currency,
                localAvailability:
                  localProd.syncStatus === "EXCLUDED" ? "out_of_stock" : "in_stock",
                remoteAvailability: remoteData.availability,
              });
            }
          }
        }

        mismatches = detectedMismatches;
      } else {
        mismatchCheckStatus = "error";
      }
    } catch {
      mismatchCheckStatus = "error";
    }
  }

  return {
    shopDomain: session.shop,
    counts: {
      synced: syncedCount,
      rejected: rejectedCount,
      excluded: excludedCount,
      pending: pendingCount,
      total: totalCount,
    },
    products,
    pagination: {
      page,
      pageSize,
      totalItems: filteredCount,
      totalPages,
    },
    filters: {
      status: statusParam,
      search: searchQuery,
    },
    cooldown: {
      isActive: isCooldownActive,
      remainingSeconds: cooldownRemainingSeconds,
      lastFeedUploadAt: shop.adsConnection?.lastFeedUploadAt?.toISOString() || null,
    },
    isFeedAccessDisabled,
    feedAccessMessage,
    mismatchCheckStatus,
    mismatches,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  if (!shop) {
    return { error: "Shop not found" };
  }

  // 1. Resync Intent
  if (intent === "resync") {
    // Check cooldown safety
    if (shop.adsConnection?.lastFeedUploadAt) {
      const elapsed = Math.floor(
        (Date.now() - new Date(shop.adsConnection.lastFeedUploadAt).getTime()) / 1000
      );
      if (elapsed < COOLDOWN_SECONDS) {
        return {
          error: `Resync cooldown active. Please wait ${COOLDOWN_SECONDS - elapsed} seconds.`,
        };
      }
    }

    try {
      await enqueueFullFeedUpload(shop.id);

      if (shop.adsConnection) {
        await db.adsConnection.update({
          where: { shopId: shop.id },
          data: { lastFeedUploadAt: new Date() },
        });
      }

      logger.info("Manual full feed resync enqueued", { shopDomain: session.shop });
      return { success: true, message: "Full catalog resync queued successfully." };
    } catch (err: unknown) {
      logger.error("Failed to enqueue full feed resync", { error: String(err) });
      return { error: "Failed to queue resync job." };
    }
  }

  // 2. Exclude Product Intent
  if (intent === "exclude") {
    const variantId = String(formData.get("variantId") || "");
    if (!variantId) {
      return { error: "Variant ID is required." };
    }

    await db.product.updateMany({
      where: { shopId: shop.id, shopifyVariantId: variantId },
      data: {
        syncStatus: "EXCLUDED",
        rejectReason: "Manually excluded by merchant from ChatGPT Ads feed",
      },
    });

    logger.info("Product manually excluded by merchant", {
      shopDomain: session.shop,
      variantId,
    });

    return { success: true, message: "Product excluded from ChatGPT Ads feed." };
  }

  return { error: "Invalid intent" };
};

export default function ProductsPage() {
  const {
    shopDomain,
    counts,
    products,
    pagination,
    filters,
    cooldown,
    isFeedAccessDisabled,
    feedAccessMessage,
    mismatchCheckStatus,
    mismatches,
  } = useLoaderData<typeof loader>();

  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  // Live countdown state for the resync button cooldown
  const [secondsLeft, setSecondsLeft] = useState(cooldown.remainingSeconds);

  useEffect(() => {
    setSecondsLeft(cooldown.remainingSeconds);
  }, [cooldown.remainingSeconds]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const interval = setInterval(() => {
      setSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [secondsLeft]);

  const isCooldownDisabled = secondsLeft > 0 || isSubmitting;

  const formatPrice = (priceMinor: number, currency: string) =>
    `$${(priceMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;

  const renderStatusBadge = (status: SyncStatus) => {
    switch (status) {
      case "SYNCED":
        return <s-badge tone="success">Synced</s-badge>;
      case "REJECTED":
        return <s-badge tone="critical">Rejected</s-badge>;
      case "EXCLUDED":
        return <s-badge tone="warning">Excluded</s-badge>;
      case "PENDING":
      default:
        return <s-badge tone="info">Pending</s-badge>;
    }
  };

  return (
    <s-page heading="Products & Feed Doctor">
      {/* 403 Access Disabled Banner */}
      {isFeedAccessDisabled && (
        <s-banner tone="warning" heading="ChatGPT Ads Feed Access Pending">
          <s-paragraph>{feedAccessMessage}</s-paragraph>
        </s-banner>
      )}

      {/* Feed Status Summary Metrics */}
      <s-section heading="Catalog Health Overview">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Total Products: </s-text>
            <s-text><strong>{counts.total}</strong></s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Synced: </s-text>
            <s-badge tone="success">{counts.synced}</s-badge>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Rejected: </s-text>
            <s-badge tone="critical">{counts.rejected}</s-badge>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Excluded: </s-text>
            <s-badge tone="warning">{counts.excluded}</s-badge>
          </s-box>
        </s-stack>

        <s-stack direction="inline" gap="base">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="resync" />
            <s-button
              type="submit"
              variant={isCooldownDisabled ? undefined : "primary"}
              disabled={isCooldownDisabled}
            >
              {secondsLeft > 0
                ? `Resync Cooldown (${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s)`
                : isSubmitting
                ? "Queuing Resync..."
                : "Resync Feed Now"}
            </s-button>
          </fetcher.Form>

          {cooldown.lastFeedUploadAt && (
            <s-paragraph>
              Last synced: {new Date(cooldown.lastFeedUploadAt).toLocaleTimeString()}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* Price & Stock Mismatch Section */}
      <s-section heading="Price & Stock Live Check (ChatGPT Ads vs Shopify)">
        {mismatchCheckStatus === "connected" && mismatches && mismatches.length > 0 ? (
          <>
            <s-banner tone="warning">
              Found {mismatches.length} item(s) with price or stock differences compared to ChatGPT Ads.
              These will be automatically updated during the next scheduled delta or full sync.
            </s-banner>
            <s-table>
              <s-table-header-row>
                <s-table-cell>Product</s-table-cell>
                <s-table-cell>Shopify Price</s-table-cell>
                <s-table-cell>ChatGPT Ads Price</s-table-cell>
                <s-table-cell>Shopify Stock</s-table-cell>
                <s-table-cell>ChatGPT Stock</s-table-cell>
              </s-table-header-row>
              <s-table-body>
                {mismatches.map((m, idx) => (
                  <s-table-row key={idx}>
                    <s-table-cell>{m.title}</s-table-cell>
                    <s-table-cell>{formatPrice(m.localPriceMinor, m.currency)}</s-table-cell>
                    <s-table-cell>
                      {m.remotePriceMinor !== undefined
                        ? formatPrice(m.remotePriceMinor, m.currency)
                        : "N/A"}
                    </s-table-cell>
                    <s-table-cell>{m.localAvailability}</s-table-cell>
                    <s-table-cell>{m.remoteAvailability || "N/A"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        ) : mismatchCheckStatus === "connected" ? (
          <s-banner tone="success">
            All audited product prices and stock availability match ChatGPT Ads.
          </s-banner>
        ) : (
          <s-paragraph>
            Live catalog comparison active once OpenAI SFTP credentials and Feed ID are configured.
          </s-paragraph>
        )}
      </s-section>

      {/* Filterable Products Table */}
      <s-section heading="Product Catalog & Diagnostics">
        {/* Search & Status Filters */}
        <Form method="get">
          <s-stack direction="inline" gap="base">
            <input
              type="text"
              name="q"
              placeholder="Search product title..."
              defaultValue={filters.search}
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid #c9cccf",
                fontSize: "14px",
                width: "260px",
              }}
            />
            <select
              name="status"
              defaultValue={filters.status}
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid #c9cccf",
                fontSize: "14px",
              }}
            >
              <option value="ALL">All Statuses ({counts.total})</option>
              <option value="SYNCED">Synced ({counts.synced})</option>
              <option value="REJECTED">Rejected ({counts.rejected})</option>
              <option value="EXCLUDED">Excluded ({counts.excluded})</option>
              <option value="PENDING">Pending ({counts.pending})</option>
            </select>
            <s-button type="submit">Filter</s-button>
          </s-stack>
        </Form>

        {products.length === 0 ? (
          <s-paragraph>No products found matching the selected filter criteria.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-cell>Product</s-table-cell>
              <s-table-cell>Price</s-table-cell>
              <s-table-cell>Status</s-table-cell>
              <s-table-cell>Diagnostics & Plain-Language Reason</s-table-cell>
              <s-table-cell>Actions</s-table-cell>
            </s-table-header-row>
            <s-table-body>
              {products.map((product) => {
                const resolution = mapOpenAIError(
                  product.rejectReason?.split(" ")[0] || "invalid_value",
                  "price",
                  product.rejectReason || undefined,
                  {
                    shopDomain,
                    shopifyProductId: product.shopifyProductId,
                    shopifyVariantId: product.shopifyVariantId,
                  }
                );

                return (
                  <s-table-row key={product.id}>
                    <s-table-cell>
                      <s-text><strong>{product.title}</strong></s-text>
                    </s-table-cell>

                    <s-table-cell>
                      {formatPrice(product.priceMinor, product.currency)}
                    </s-table-cell>

                    <s-table-cell>
                      {renderStatusBadge(product.syncStatus)}
                    </s-table-cell>

                    <s-table-cell>
                      {product.syncStatus === "REJECTED" ? (
                        <s-text>{product.rejectReason || resolution.plainLanguageReason}</s-text>
                      ) : product.syncStatus === "EXCLUDED" ? (
                        <s-text>{product.rejectReason || "Excluded by store rules"}</s-text>
                      ) : (
                        <s-text>Ready & eligible for ChatGPT Ads</s-text>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-stack direction="inline" gap="base">
                        {resolution.action.url && (
                          <s-link href={resolution.action.url} target="_blank">
                            Shopify Admin
                          </s-link>
                        )}

                        {product.syncStatus === "REJECTED" && (
                          <fetcher.Form method="post">
                            <input type="hidden" name="intent" value="exclude" />
                            <input
                              type="hidden"
                              name="variantId"
                              value={product.shopifyVariantId}
                            />
                            <s-button type="submit" disabled={isSubmitting}>
                              Exclude
                            </s-button>
                          </fetcher.Form>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {/* Pagination Controls */}
        <s-stack direction="inline" gap="base">
          <s-text>
            Page {pagination.page} of {pagination.totalPages} ({pagination.totalItems} items)
          </s-text>

          {pagination.page > 1 && (
            <s-link
              href={`/app/products?status=${filters.status}&q=${encodeURIComponent(
                filters.search
              )}&page=${pagination.page - 1}`}
            >
              Previous
            </s-link>
          )}

          {pagination.page < pagination.totalPages && (
            <s-link
              href={`/app/products?status=${filters.status}&q=${encodeURIComponent(
                filters.search
              )}&page=${pagination.page + 1}`}
            >
              Next
            </s-link>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
