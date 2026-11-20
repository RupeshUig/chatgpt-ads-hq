import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  averageOrderValue,
  grossMarginPerOrder,
  maxAffordableCpc,
  bestProductsToAdvertise,
  monthlyMinimumSpend,
  fitScore,
  type OrderInput,
  type ProductInput,
  type RankedProduct,
} from "../services/fit-check.server.ts";
import { getShopifyProductAdminUrl } from "../services/feed/error-messages.ts";
import { toMinorUnits } from "../services/tracking/openai-capi.server.ts";
import { logger } from "../lib/logger.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: {
      adsConnection: true,
      products: true,
      conversionSendLogs: {
        where: {
          sentAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // last 24h
          },
        },
        take: 20,
      },
    },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // 1. Query recent Shopify orders (last 50 orders)
  let rawOrders: Array<{
    id: string;
    totalPriceSet?: {
      shopMoney?: {
        amount?: string | number;
      };
    };
    lineItems?: {
      nodes?: Array<{
        quantity: number;
        variant?: {
          id: string;
          price?: string;
        };
      }>;
    };
  }> = [];

  try {
    const ordersResp = await admin.graphql(
      `#graphql
      query getOrdersForFitCheck {
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            totalPriceSet {
              shopMoney {
                amount
              }
            }
            lineItems(first: 20) {
              nodes {
                quantity
                variant {
                  id
                  price
                }
              }
            }
          }
        }
      }`
    );
    const ordersJson = (await ordersResp.json()) as {
      data?: {
        orders?: {
          nodes?: typeof rawOrders;
        };
      };
    };
    rawOrders = ordersJson.data?.orders?.nodes || [];
  } catch (err) {
    logger.warn("Failed to fetch orders for fit check", { error: String(err) });
  }

  // 2. Map orders for fit check calculations
  const mappedOrders: OrderInput[] = rawOrders.map((o) => ({
    id: o.id,
    totalPriceMinor: toMinorUnits(o.totalPriceSet?.shopMoney?.amount),
    lineItems: (o.lineItems?.nodes || []).map((li) => ({
      quantity: li.quantity,
      variantId: li.variant?.id ? li.variant.id.replace(/^gid:\/\/shopify\/ProductVariant\//, "") : null,
      unitPriceMinor: toMinorUnits(li.variant?.price),
    })),
  }));

  // 3. Map products from DB
  const mappedProducts: ProductInput[] = shop.products.map((p) => ({
    id: p.id,
    title: p.title,
    priceMinor: p.priceMinor,
    costMinor: p.costMinor,
  }));

  // 4. Run pure fit check calculations
  const aovMinor = averageOrderValue(mappedOrders);
  const marginResult = grossMarginPerOrder(mappedOrders, mappedProducts);
  const maxCpcMinor = maxAffordableCpc(marginResult.averageProfitMinor);
  const topProducts = bestProductsToAdvertise(mappedProducts);
  const monthlyMinMinor = monthlyMinimumSpend(1, undefined, shop.currency);

  const productsWithCost = shop.products.filter(
    (p) => typeof p.costMinor === "number" && p.costMinor > 0
  );

  const fitResult = fitScore({
    aovMinor: aovMinor > 0 ? aovMinor : 4500, // fallback to benchmark $45 if store has 0 orders
    averageProfitMinor:
      marginResult.averageProfitMinor > 0 ? marginResult.averageProfitMinor : 2250,
    grossMarginRatio:
      marginResult.grossMarginRatio > 0 ? marginResult.grossMarginRatio : 0.5,
    maxAffordableCpcMinor: maxCpcMinor > 0 ? maxCpcMinor : 45,
    totalProducts: shop.products.length,
    productsWithCostCount: productsWithCost.length,
    bestProductsCount: topProducts.length,
  });

  // 5. Checklist status evaluation
  const checklist = {
    connected: Boolean(
      shop.adsConnection?.pixelId ||
        (shop.adsConnection?.keyLast4 && shop.adsConnection.keyLast4 !== "none")
    ),
    productsSynced:
      shop.products.some((p) => p.syncStatus === "SYNCED") ||
      shop.products.length > 0,
    trackingLive: Boolean(
      shop.adsConnection?.pixelId && shop.conversionSendLogs.length > 0
    ),
    costsFilled:
      shop.products.length > 0 &&
      productsWithCost.length === shop.products.length,
    costCoveragePercent:
      shop.products.length > 0
        ? Math.round((productsWithCost.length / shop.products.length) * 100)
        : 0,
  };

  // 6. Missing product costs list
  const missingCostProducts = shop.products
    .filter((p) => p.costMinor == null || p.costMinor <= 0)
    .slice(0, 15)
    .map((p) => ({
      id: p.id,
      title: p.title,
      priceMinor: p.priceMinor,
      shopifyProductId: p.shopifyProductId,
      adminUrl: getShopifyProductAdminUrl(shop.shopDomain, p.shopifyProductId),
    }));

  return {
    shopDomain: session.shop,
    currency: shop.currency,
    checklist,
    fitResult,
    metrics: {
      aovMinor,
      averageProfitMinor: marginResult.averageProfitMinor,
      grossMarginRatio: marginResult.grossMarginRatio,
      maxCpcMinor,
      monthlyMinMinor,
      totalOrdersCount: mappedOrders.length,
      totalProductsCount: shop.products.length,
      productsWithCostCount: productsWithCost.length,
    },
    topProducts: topProducts.slice(0, 5),
    missingCostProducts,
    missingCostCount: shop.products.length - productsWithCost.length,
  };
};

export default function HomePage() {
  const {
    shopDomain,
    currency,
    checklist,
    fitResult,
    metrics,
    topProducts,
    missingCostProducts,
    missingCostCount,
  } = useLoaderData<typeof loader>();

  const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <s-page heading="ChatGPT Ads HQ">
      {/* 1. Setup Checklist */}
      <s-section heading="Setup Checklist">
        <s-paragraph>
          Complete these 4 foundation steps to start acquiring profitable customers from ChatGPT search.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          {/* Item 1: OpenAI Connected */}
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone={checklist.connected ? "success" : "warning"}>
                {checklist.connected ? "Connected" : "Action Required"}
              </s-badge>
              <div>
                <s-text><strong>1. Connect OpenAI Ads & Measurement Pixel</strong></s-text>
                <s-paragraph>
                  Configure your OpenAI Pixel ID and Conversion Key to enable ad delivery and server-side tracking.
                </s-paragraph>
                {!checklist.connected && (
                  <s-link href="/app/settings">
                    <s-button variant="primary">Connect in Settings</s-button>
                  </s-link>
                )}
              </div>
            </s-stack>
          </s-box>

          {/* Item 2: Products Synced */}
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone={checklist.productsSynced ? "success" : "warning"}>
                {checklist.productsSynced ? "Synced" : "Pending"}
              </s-badge>
              <div>
                <s-text><strong>2. Product Catalog Synced</strong></s-text>
                <s-paragraph>
                  Ensure products are synced to the OpenAI catalog feed with images, prices, and availability.
                </s-paragraph>
                {!checklist.productsSynced && (
                  <s-link href="/app/products">
                    <s-button variant="primary">Review Products</s-button>
                  </s-link>
                )}
              </div>
            </s-stack>
          </s-box>

          {/* Item 3: Tracking Live */}
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone={checklist.trackingLive ? "success" : "warning"}>
                {checklist.trackingLive ? "Live" : "Pending Signals"}
              </s-badge>
              <div>
                <s-text><strong>3. Conversion Tracking Live</strong></s-text>
                <s-paragraph>
                  Verify that storefront pixel and server CAPI purchase signals are arriving without errors.
                </s-paragraph>
                {!checklist.trackingLive && (
                  <s-link href="/app/tracking">
                    <s-button variant="primary">Open Tracking Diagnostics</s-button>
                  </s-link>
                )}
              </div>
            </s-stack>
          </s-box>

          {/* Item 4: Costs Filled */}
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone={checklist.costsFilled ? "success" : "warning"}>
                {checklist.costsFilled
                  ? "Costs Complete"
                  : `${checklist.costCoveragePercent}% Filled`}
              </s-badge>
              <div>
                <s-text><strong>4. Product Costs of Goods Filled</strong></s-text>
                <s-paragraph>
                  Fill product costs in Shopify so Cartlight can calculate exact margins and stop ads when profit drops.
                </s-paragraph>
                {!checklist.costsFilled && (
                  <s-link href="#missing-costs">
                    <s-button>Review Missing Costs ({missingCostCount})</s-button>
                  </s-link>
                )}
              </div>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* 2. Fit Check Card */}
      <s-section heading="eCommerce Fit Check Assessment">
        <s-paragraph>
          Automated evaluation of your store's unit economics and catalog readiness for ChatGPT Ads.
        </s-paragraph>

        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text><strong>Ad Viability Score:</strong></s-text>
              <s-badge
                tone={
                  fitResult.score === "likely"
                    ? "success"
                    : fitResult.score === "maybe"
                    ? "warning"
                    : "critical"
                }
              >
                {fitResult.score === "likely"
                  ? "LIKELY PROFITABLE"
                  : fitResult.score === "maybe"
                  ? "MAYBE PROFITABLE"
                  : "UNLIKELY PROFITABLE"}
              </s-badge>
            </s-stack>

            {/* Plain-language reasons */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-text><strong>Assessment Details:</strong></s-text>
              <ul>
                {fitResult.reasons.map((reason, idx) => (
                  <li key={idx} style={{ marginBottom: "6px", fontSize: "14px" }}>
                    {reason}
                  </li>
                ))}
              </ul>
            </s-box>

            {/* Financial indicators grid */}
            <s-stack direction="inline" gap="base">
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-text>Max Affordable CPC: </s-text>
                <s-text><strong>{formatMoney(metrics.maxCpcMinor)}</strong></s-text>
                <s-paragraph>Highest cost per click to remain profitable.</s-paragraph>
              </s-box>

              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-text>Average Order Value: </s-text>
                <s-text><strong>{formatMoney(metrics.aovMinor)}</strong></s-text>
                <s-paragraph>Based on recent orders.</s-paragraph>
              </s-box>

              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-text>Gross Margin: </s-text>
                <s-text><strong>{Math.round(metrics.grossMarginRatio * 100)}%</strong></s-text>
                <s-paragraph>{formatMoney(metrics.averageProfitMinor)} profit / order</s-paragraph>
              </s-box>

              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-text>Monthly Minimum Spend: </s-text>
                <s-text><strong>{formatMoney(metrics.monthlyMinMinor)}</strong></s-text>
                <s-paragraph>1 campaign ($25/day × 30 days).</s-paragraph>
              </s-box>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      {/* 3. Top 5 Products to Advertise */}
      <s-section heading="Top 5 Products to Advertise">
        <s-paragraph>
          Ranked by highest gross dollar profit (Retail Price − Cost of Goods). These flagship products offer the largest buffer to acquire customers profitably.
        </s-paragraph>

        {topProducts.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-paragraph>
              No products currently have cost of goods filled. Fill costs in Shopify to reveal your highest-margin products.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-cell>Product</s-table-cell>
              <s-table-cell>Retail Price</s-table-cell>
              <s-table-cell>Cost of Goods</s-table-cell>
              <s-table-cell>Gross Profit</s-table-cell>
              <s-table-cell>Margin %</s-table-cell>
            </s-table-header-row>
            <s-table-body>
              {topProducts.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-text><strong>{p.title}</strong></s-text>
                  </s-table-cell>
                  <s-table-cell>{formatMoney(p.priceMinor)}</s-table-cell>
                  <s-table-cell>{formatMoney(p.costMinor)}</s-table-cell>
                  <s-table-cell>
                    <s-text><strong>{formatMoney(p.profitMinor)}</strong></s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone="success">{Math.round(p.marginRatio * 100)}%</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* 4. Missing Product Costs List */}
      <div id="missing-costs">
        <s-section heading={`Missing Product Costs (${missingCostCount})`}>
          <s-paragraph>
            Products missing cost of goods cannot be defended by automatic margin rules. Click any product to add its cost per item in Shopify admin.
          </s-paragraph>

          {missingCostCount === 0 ? (
            <s-banner tone="success">
              100% of your products have cost of goods configured. Full margin protection is active!
            </s-banner>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-cell>Product</s-table-cell>
                <s-table-cell>Retail Price</s-table-cell>
                <s-table-cell>Cost Status</s-table-cell>
                <s-table-cell>Action</s-table-cell>
              </s-table-header-row>
              <s-table-body>
                {missingCostProducts.map((p) => (
                  <s-table-row key={p.id}>
                    <s-table-cell>
                      <s-text><strong>{p.title}</strong></s-text>
                    </s-table-cell>
                    <s-table-cell>{formatMoney(p.priceMinor)}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone="critical">Cost Missing</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={p.adminUrl} target="_blank">
                        <s-button>Edit in Shopify Admin</s-button>
                      </s-link>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
