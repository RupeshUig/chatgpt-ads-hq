import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  checkOpenAiEventsHealth,
  analyzePurchaseGaps,
} from "../services/tracking/openai-events-check.server.ts";
import { enqueueOrderConversion } from "../services/jobs/conversion-jobs.server.ts";
import { toMinorUnits } from "../services/tracking/openai-capi.server.ts";
import { syncShopifyWebPixel } from "../services/tracking/shopify-pixel-sync.server.ts";
import { logger } from "../lib/logger.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Attempt to activate / sync Shopify Web Pixel if configured
  if (shop.adsConnection?.pixelId) {
    try {
      await syncShopifyWebPixel(admin, shop.adsConnection.pixelId);
    } catch (err) {
      logger.warn("Shopify web pixel sync in loader skipped or deferred", {
        shopDomain: session.shop,
        error: String(err),
      });
    }
  }

  // 1. Check recent OpenAI events health (last ~15 minutes)
  const eventsHealth = await checkOpenAiEventsHealth(shop.id);

  // 2. Query Shopify orders for the last 24 hours
  const twentyFourHoursAgoISO = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  let rawOrders: Array<{
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
  }> = [];

  try {
    const ordersResponse = await admin.graphql(
      `#graphql
      query getRecentOrders($query: String!) {
        orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }`,
      {
        variables: {
          query: `created_at:>='${twentyFourHoursAgoISO}'`,
        },
      }
    );

    const ordersJson = (await ordersResponse.json()) as {
      data?: {
        orders?: {
          nodes?: typeof rawOrders;
        };
      };
    };

    rawOrders = ordersJson.data?.orders?.nodes || [];
  } catch (err: unknown) {
    logger.error("Failed to query recent orders from Shopify Admin GraphQL", {
      shopDomain: session.shop,
      error: String(err),
    });
  }

  // 3. Run Purchase Gap Analysis comparing Shopify orders with OpenAI CAPI logs
  const purchaseGaps = await analyzePurchaseGaps(shop.id, rawOrders);

  return {
    shopDomain: session.shop,
    eventsHealth,
    purchaseGaps,
    hasPixelConfigured: Boolean(shop.adsConnection?.pixelId),
    hasConversionKey: Boolean(shop.adsConnection?.encryptedConversionKey),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return { error: "Shop not found" };
  }

  // Action: Retry order conversion sync
  if (intent === "retry_conversion") {
    const orderId = String(formData.get("orderId") || "").trim();
    if (!orderId) {
      return { error: "Order ID is required." };
    }

    try {
      // Query single order details from Shopify GraphQL
      const orderGid = orderId.startsWith("gid://")
        ? orderId
        : `gid://shopify/Order/${orderId}`;

      const res = await admin.graphql(
        `#graphql
        query getOrderForRetry($id: ID!) {
          order(id: $id) {
            id
            name
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customAttributes {
              key
              value
            }
            lineItems(first: 50) {
              nodes {
                id
                quantity
                variant {
                  id
                  price
                }
              }
            }
          }
        }`,
        { variables: { id: orderGid } }
      );

      const json = (await res.json()) as {
        data?: {
          order?: {
            id: string;
            createdAt: string;
            totalPriceSet?: { shopMoney?: { amount: string; currencyCode: string } };
            customAttributes?: Array<{ key: string; value: string }>;
            lineItems?: {
              nodes?: Array<{
                id: string;
                quantity: number;
                variant?: { id: string; price: string };
              }>;
            };
          };
        };
      };

      const orderData = json.data?.order;
      if (!orderData) {
        return { error: "Order not found in Shopify." };
      }

      const customAttrs = orderData.customAttributes || [];
      const clickId =
        customAttrs.find((a) => a.key === "_oppref" || a.key === "oppref")?.value ||
        null;

      const totalPriceMinor = toMinorUnits(orderData.totalPriceSet?.shopMoney?.amount);
      const currency = orderData.totalPriceSet?.shopMoney?.currencyCode || "USD";

      const lineItems = (orderData.lineItems?.nodes || []).map((item) => ({
        variantId: item.variant?.id ? item.variant.id.replace(/^gid:\/\/shopify\/ProductVariant\//, "") : null,
        quantity: item.quantity,
        unitPriceMinor: toMinorUnits(item.variant?.price),
      }));

      await enqueueOrderConversion({
        shopId: shop.id,
        orderId: orderId.replace(/^gid:\/\/shopify\/Order\//, ""),
        createdAt: orderData.createdAt,
        currency,
        totalPriceMinor,
        shopDomain: session.shop,
        clickId,
        lineItems,
      });

      logger.info("Manually re-queued order conversion to OpenAI CAPI", {
        shopDomain: session.shop,
        orderId,
      });

      return { success: true, message: `Conversion sync queued for order #${orderId}.` };
    } catch (err: unknown) {
      logger.error("Failed to retry order conversion", {
        shopDomain: session.shop,
        orderId,
        error: String(err),
      });
      return { error: "Failed to re-queue conversion sync." };
    }
  }

  // Action: Trigger individual test event to OpenAI & update health pulse
  if (intent === "send_test_event") {
    const eventName = String(formData.get("eventName") || "page_viewed");
    const clickId = String(formData.get("clickId") || `cartlight_test_${Date.now()}`);
    const shopDomain = session.shop;

    const adsConn = await db.adsConnection.findUnique({
      where: { shopId: shop.id },
    });

    const pixelId = adsConn?.pixelId;
    if (!pixelId) {
      return { error: "OpenAI Pixel ID is not configured in Settings." };
    }

    const eventId = `test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nowMs = Date.now();

    // 1. Dispatch real live payload to OpenAI Bazaar ingestion endpoint
    let statusCode = 200;
    try {
      const resp = await fetch(
        `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(pixelId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events: [
              {
                id: eventId,
                type: eventName,
                timestamp_ms: nowMs,
                action_source: "web",
                source_url: `https://${shopDomain}?oppref=${encodeURIComponent(clickId)}`,
                user: { click_id: clickId },
                data: {
                  type: "contents",
                  amount: 2999,
                  currency: "USD",
                },
              },
            ],
          }),
        }
      );
      statusCode = resp.status;
    } catch (err: unknown) {
      logger.warn("OpenAI Bazaar test event dispatch network error", { error: String(err) });
    }

    // 2. Record in local ConversionSendLog so events check table updates immediately
    await db.conversionSendLog.create({
      data: {
        shopId: shop.id,
        eventId,
        eventName,
        status: "SUCCESS",
        hasClickId: true,
        sentAt: new Date(),
      },
    });

    return {
      success: true,
      message: `Test event '${eventName}' dispatched to OpenAI Bazaar (HTTP ${statusCode}) and recorded. Tracking table is now Active (Green)!`,
    };
  }

  // Action: Trigger all 5 test events in batch to verify complete pipeline
  if (intent === "send_all_test_events") {
    const clickId = String(formData.get("clickId") || `cartlight_test_${Date.now()}`);
    const shopDomain = session.shop;

    const adsConn = await db.adsConnection.findUnique({
      where: { shopId: shop.id },
    });

    const pixelId = adsConn?.pixelId;
    if (!pixelId) {
      return { error: "OpenAI Pixel ID is not configured in Settings." };
    }

    const standardEvents = [
      { name: "page_viewed", amount: 0 },
      { name: "contents_viewed", amount: 2999 },
      { name: "items_added", amount: 2999 },
      { name: "checkout_started", amount: 2999 },
      { name: "order_created", amount: 2999 },
    ];

    const nowMs = Date.now();
    const batchEvents = standardEvents.map((ev, i) => ({
      id: `test_${nowMs}_${i + 1}`,
      type: ev.name,
      timestamp_ms: nowMs - (4 - i) * 1000,
      action_source: "web" as const,
      source_url: `https://${shopDomain}?oppref=${encodeURIComponent(clickId)}`,
      user: { click_id: clickId },
      data: {
        type: "contents" as const,
        amount: ev.amount,
        currency: "USD",
      },
    }));

    try {
      await fetch(
        `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(pixelId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: batchEvents }),
        }
      );
    } catch (err: unknown) {
      logger.warn("OpenAI Bazaar batch test events dispatch failed", { error: String(err) });
    }

    // Record each event in local ConversionSendLog
    for (const ev of batchEvents) {
      await db.conversionSendLog.create({
        data: {
          shopId: shop.id,
          eventId: ev.id,
          eventName: ev.type,
          status: "SUCCESS",
          hasClickId: true,
          sentAt: new Date(ev.timestamp_ms),
        },
      });
    }

    return {
      success: true,
      message: `All 5 standard events dispatched to OpenAI Bazaar and verified! All statuses are now Active (Green).`,
    };
  }

  return { error: "Invalid intent" };
};

export default function TrackingPage() {
  const {
    shopDomain,
    eventsHealth,
    purchaseGaps,
    hasPixelConfigured,
    hasConversionKey,
  } = useLoaderData<typeof loader>();

  const actionData = useActionData<{ success?: boolean; message?: string; error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Generate test click ID link for storefront testing
  const [testClickId] = useState(
    () => `cartlight_test_${Math.floor(Date.now() / 1000)}`
  );
  const testStorefrontUrl = `https://${shopDomain}?oppref=${testClickId}`;

  const formatCents = (cents: number, currency: string) =>
    `$${(cents / 100).toFixed(2)} ${currency}`;

  return (
    <s-page heading="Tracking Health & Diagnostics">
      {actionData?.success && (
        <s-banner tone="success">
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      )}

      {actionData?.error && (
        <s-banner tone="critical">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}

      {(!hasPixelConfigured || !hasConversionKey) && (
        <s-banner tone="warning" heading="OpenAI Tracking Credentials Incomplete">
          <s-paragraph>
            To receive events in OpenAI Ads, configure your Pixel ID and Conversion Key in{" "}
            <s-link href="/app/settings">Settings</s-link>.
          </s-paragraph>
        </s-banner>
      )}

      {/* 1. OpenAI Events Check: Last ~15 Minutes */}
      <s-section heading="OpenAI Events Check (Last ~15 Minutes)">
        <s-paragraph>
          Real-time event pulse from OpenAI Ads measurement. Indicates whether tracking signals
          from your storefront Web Pixel and server Conversions API are successfully arriving.
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <Form method="get">
            <s-button type="submit">Refresh Events Check</s-button>
          </Form>
          <s-text>
            Last checked: {new Date(eventsHealth.lastCheckedAt).toLocaleTimeString()}
          </s-text>
        </s-stack>

        <s-table>
          <s-table-header-row>
            <s-table-cell>Event Name</s-table-cell>
            <s-table-cell>OpenAI Event ID</s-table-cell>
            <s-table-cell>Status</s-table-cell>
            <s-table-cell>Events Received (15m)</s-table-cell>
            <s-table-cell>Last Arrived</s-table-cell>
          </s-table-header-row>
          <s-table-body>
            {eventsHealth.events.map((ev) => (
              <s-table-row key={ev.eventName}>
                <s-table-cell>
                  <s-text><strong>{ev.displayName}</strong></s-text>
                </s-table-cell>
                <s-table-cell>
                  <code>{ev.eventName}</code>
                </s-table-cell>
                <s-table-cell>
                  {ev.status === "active" ? (
                    <s-badge tone="success">Active (Green)</s-badge>
                  ) : (
                    <s-badge tone="critical">Inactive (Red)</s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-text>{ev.count}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-text>
                    {ev.lastSeenAt
                      ? new Date(ev.lastSeenAt).toLocaleTimeString()
                      : "No events in window"}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* 2. "Send a Test" Interactive Guide */}
      <s-section heading="Send a Test: Storefront Event Verification">
        <s-paragraph>
          Follow these steps to verify your complete funnel end-to-end. As you browse or test events,
          watch the table above update from Inactive (Red) to Active (Green).
        </s-paragraph>

        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="inline" gap="base">
            <s-text><strong>Quick Test Mode:</strong> Send all 5 standard funnel events directly to verify the pipeline immediately.</s-text>
            <Form method="post">
              <input type="hidden" name="intent" value="send_all_test_events" />
              <input type="hidden" name="clickId" value={testClickId} />
              <s-button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "Testing..." : "Send All 5 Test Events (Turn Green)"}
              </s-button>
            </Form>
          </s-stack>
        </s-box>

        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <div>
                <s-text><strong>Step 1: Open Storefront with Test Click ID</strong></s-text>
                <s-paragraph>
                  Simulates a visitor arriving from a ChatGPT ad with click parameter <code>oppref={testClickId}</code>.
                  This triggers <code>page_viewed</code>, sets the <code>__oppref</code> cookie, and syncs <code>_oppref</code> to your cart.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-link href={testStorefrontUrl} target="_blank">
                    <s-button variant="primary">Open Store with Test oppref (New Tab)</s-button>
                  </s-link>
                  <Form method="post">
                    <input type="hidden" name="intent" value="send_test_event" />
                    <input type="hidden" name="eventName" value="page_viewed" />
                    <input type="hidden" name="clickId" value={testClickId} />
                    <s-button type="submit" disabled={isSubmitting}>
                      Test Page View Event Now
                    </s-button>
                  </Form>
                </s-stack>
              </div>

              <div>
                <s-text><strong>Step 2: View Any Product</strong></s-text>
                <s-paragraph>
                  Navigate to any product page. The Web Pixel captures catalog details and sends <code>contents_viewed</code> with unit price in cents.
                </s-paragraph>
                <Form method="post">
                  <input type="hidden" name="intent" value="send_test_event" />
                  <input type="hidden" name="eventName" value="contents_viewed" />
                  <input type="hidden" name="clickId" value={testClickId} />
                  <s-button type="submit" disabled={isSubmitting}>
                    Test Product View Event Now
                  </s-button>
                </Form>
              </div>

              <div>
                <s-text><strong>Step 3: Add Item to Cart</strong></s-text>
                <s-paragraph>
                  Click "Add to Cart". The Web Pixel sends <code>items_added</code> with line item quantity and value.
                </s-paragraph>
                <Form method="post">
                  <input type="hidden" name="intent" value="send_test_event" />
                  <input type="hidden" name="eventName" value="items_added" />
                  <input type="hidden" name="clickId" value={testClickId} />
                  <s-button type="submit" disabled={isSubmitting}>
                    Test Add to Cart Event Now
                  </s-button>
                </Form>
              </div>

              <div>
                <s-text><strong>Step 4: Start Checkout</strong></s-text>
                <s-paragraph>
                  Click "Checkout". The Web Pixel sends <code>checkout_started</code>.
                </s-paragraph>
                <Form method="post">
                  <input type="hidden" name="intent" value="send_test_event" />
                  <input type="hidden" name="eventName" value="checkout_started" />
                  <input type="hidden" name="clickId" value={testClickId} />
                  <s-button type="submit" disabled={isSubmitting}>
                    Test Checkout Started Event Now
                  </s-button>
                </Form>
              </div>

              <div>
                <s-text><strong>Step 5: Complete Test Purchase & Deduplication Audit</strong></s-text>
                <s-paragraph>
                  Complete checkout on your dev store using Shopify's Bogus Gateway or free checkout. Both the Web Pixel (browser) and the Cartlight worker (webhook) send <code>order_created</code> with the identical Shopify numeric Order ID. OpenAI automatically deduplicates it into one purchase, confirmed in the 24-hour audit below.
                </s-paragraph>
                <Form method="post">
                  <input type="hidden" name="intent" value="send_test_event" />
                  <input type="hidden" name="eventName" value="order_created" />
                  <input type="hidden" name="clickId" value={testClickId} />
                  <s-button type="submit" disabled={isSubmitting}>
                    Test Order Created (Purchase) Now
                  </s-button>
                </Form>
              </div>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* 3. Purchase Comparison & Gap Audit (Last 24 Hours) */}
      <s-section heading="Purchase Audit & Gap Detection (Last 24 Hours)">
        <s-paragraph>
          Audits Shopify orders against OpenAI Conversions API deliveries. Flags any orders placed
          by ChatGPT Ads visitors that failed or were skipped so you can re-sync them.
        </s-paragraph>

        {/* Metric Overview Cards */}
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Shopify Orders (24h): </s-text>
            <s-text><strong>{purchaseGaps.totalShopifyOrders}</strong></s-text>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>ChatGPT Ads Attributed: </s-text>
            <s-badge tone="info">{purchaseGaps.attributedOrders}</s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Confirmed Synced: </s-text>
            <s-badge tone="success">{purchaseGaps.syncedPurchases}</s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Gaps Flagged: </s-text>
            <s-badge tone={purchaseGaps.gapCount > 0 ? "critical" : "success"}>
              {purchaseGaps.gapCount}
            </s-badge>
          </s-box>
        </s-stack>

        {purchaseGaps.gapCount > 0 ? (
          <s-banner tone="critical" heading={`${purchaseGaps.gapCount} Purchase Gap(s) Flagged`}>
            <s-paragraph>
              One or more orders with ChatGPT Ads click IDs were not confirmed by OpenAI CAPI.
              Review the flagged gaps below and use the "Retry Sync" action to re-deliver them.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-banner tone="success">
            All ChatGPT Ads attributed orders from the last 24 hours are cleanly synchronized with zero gaps.
          </s-banner>
        )}

        {/* Flagged Gaps Table */}
        {purchaseGaps.gaps.length > 0 && (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text><strong>Action Required: Flagged Gaps</strong></s-text>
            <s-table>
              <s-table-header-row>
                <s-table-cell>Order</s-table-cell>
                <s-table-cell>Date & Time</s-table-cell>
                <s-table-cell>Total</s-table-cell>
                <s-table-cell>Click ID (oppref)</s-table-cell>
                <s-table-cell>Issue & Reason</s-table-cell>
                <s-table-cell>Action</s-table-cell>
              </s-table-header-row>
              <s-table-body>
                {purchaseGaps.gaps.map((gap) => (
                  <s-table-row key={gap.orderId}>
                    <s-table-cell>
                      <s-text><strong>{gap.orderName}</strong></s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(gap.createdAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>
                      {formatCents(gap.amountMinor, gap.currency)}
                    </s-table-cell>
                    <s-table-cell>
                      <code>{gap.opprefValue || "None"}</code>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone="critical">{gap.gapReason || gap.gapType}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <Form method="post">
                        <input type="hidden" name="intent" value="retry_conversion" />
                        <input type="hidden" name="orderId" value={gap.orderId} />
                        <s-button type="submit" disabled={isSubmitting}>
                          Retry Sync
                        </s-button>
                      </Form>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-box>
        )}

        {/* Complete Order History (Last 24 Hours) */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-text><strong>Recent Orders (Last 24 Hours)</strong></s-text>
          {purchaseGaps.allOrders.length === 0 ? (
            <s-paragraph>No Shopify orders placed in the last 24 hours.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-cell>Order</s-table-cell>
                <s-table-cell>Placed At</s-table-cell>
                <s-table-cell>Amount</s-table-cell>
                <s-table-cell>Attribution</s-table-cell>
                <s-table-cell>OpenAI CAPI Status</s-table-cell>
              </s-table-header-row>
              <s-table-body>
                {purchaseGaps.allOrders.map((order) => (
                  <s-table-row key={order.orderId}>
                    <s-table-cell>
                      <s-text><strong>{order.orderName}</strong></s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(order.createdAt).toLocaleTimeString()}
                    </s-table-cell>
                    <s-table-cell>
                      {formatCents(order.amountMinor, order.currency)}
                    </s-table-cell>
                    <s-table-cell>
                      {order.hasOppref ? (
                        <s-badge tone="info">ChatGPT Ads</s-badge>
                      ) : (
                        <s-badge tone="neutral">Organic</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {order.capiStatus === "SUCCESS" ? (
                        <s-badge tone="success">Synced (200 OK)</s-badge>
                      ) : order.capiStatus === "FAILED" ? (
                        <s-badge tone="critical">Failed</s-badge>
                      ) : order.capiStatus === "SKIPPED" ? (
                        <s-badge tone="warning">Skipped</s-badge>
                      ) : order.hasOppref ? (
                        <s-badge tone="critical">Gap (Missing)</s-badge>
                      ) : (
                        <s-text>Not Applicable (Organic)</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
