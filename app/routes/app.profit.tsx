import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSubmit, Form } from "react-router";
import { authenticate } from "../shopify.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server.ts";
import { getStoreBillingStatus } from "../services/billing.server.ts";
import {
  handleProfitLoader,
  checkRefreshCooldown,
} from "../services/profit/profit-reporting.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { plan: true },
  });

  // 1. Check Billing Tier (Pro required for real data, Free sees static fake sample preview)
  const billingStatus = await getStoreBillingStatus(request);
  const isPaidPlan =
    billingStatus.plan === "PRO" ||
    billingStatus.plan === "SCALE" ||
    shop?.plan === "PRO" ||
    shop?.plan === "SCALE";

  return handleProfitLoader(session.shop, Boolean(isPaidPlan), url);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return { ok: false, error: "Shop not found" };
  }

  // Server-side enforcement of 5-minute refresh cooldown
  const cooldown = checkRefreshCooldown(shop.lastProfitSyncAt);
  if (cooldown.isCooldownActive) {
    const minText = cooldown.remainingMinutes === 1 ? "minute" : "minutes";
    return {
      ok: false,
      isBlocked: true,
      remainingMinutes: cooldown.remainingMinutes,
      error: `You can refresh again in ${cooldown.remainingMinutes} ${minText}`,
    };
  }

  // Update lastProfitSyncAt timestamp
  await db.shop.update({
    where: { id: shop.id },
    data: { lastProfitSyncAt: new Date() },
  });

  return { ok: true, syncedAt: new Date().toISOString() };
};

export default function ProfitPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const isRefreshing = navigation.state === "submitting";

  const formatMoney = (minorUnits: number) => {
    const isNegative = minorUnits < 0;
    const absCents = Math.abs(minorUnits);
    const major = (absCents / 100).toFixed(2);
    return isNegative ? `-$${major}` : `$${major}`;
  };

  const handleRangeChange = (newRange: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("range", newRange);
    params.delete("startDate");
    params.delete("endDate");
    params.set("cPage", "1");
    params.set("pPage", "1");
    submit(params, { method: "get" });
  };

  // Preview overlay styles for Free plan
  const previewContainerStyle: React.CSSProperties = !data.isPaidPlan
    ? {
        filter: "blur(4.5px)",
        pointerEvents: "none",
        userSelect: "none",
        opacity: 0.6,
      }
    : {};

  return (
    <s-page heading="ChatGPT Ads Profit & Attribution">
      {/* 1. Free Plan Banner / Paywall */}
      {!data.isPaidPlan && (
        <s-section>
          <s-banner tone="info" heading="Upgrade to Pro to see your real ChatGPT Ads profit">
            <s-paragraph>
              Unlock true net profit reporting (revenue minus product COGS, fulfillment shipping expenses,
              payment gateway fees, and ChatGPT ad spend).
            </s-paragraph>
            <s-button variant="primary" href="/app/plans">
              Upgrade to Pro
            </s-button>
          </s-banner>
        </s-section>
      )}

      {/* 2. Controls Bar: Date Range Picker & Refresh Data Button */}
      <s-section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <s-text><strong>Range:</strong></s-text>
            <s-button
              variant={data.range === "7" ? "primary" : "secondary"}
              onClick={() => handleRangeChange("7")}
            >
              Last 7 Days
            </s-button>
            <s-button
              variant={data.range === "30" ? "primary" : "secondary"}
              onClick={() => handleRangeChange("30")}
            >
              Last 30 Days
            </s-button>
            <s-button
              variant={data.range === "90" ? "primary" : "secondary"}
              onClick={() => handleRangeChange("90")}
            >
              Last 90 Days
            </s-button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {data.lastProfitSyncAt && (
              <s-text color="subdued">
                Last updated: {new Date(data.lastProfitSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </s-text>
            )}
            {data.cooldown?.isCooldownActive && (
              <s-text color="subdued">
                You can refresh again in {data.cooldown.remainingMinutes}{" "}
                {data.cooldown.remainingMinutes === 1 ? "minute" : "minutes"}
              </s-text>
            )}
            <Form method="post">
              <s-button
                type="submit"
                variant="secondary"
                disabled={isRefreshing || !data.isPaidPlan || data.cooldown?.isCooldownActive}
              >
                {isRefreshing ? "Refreshing..." : "Refresh Data"}
              </s-button>
            </Form>
          </div>
        </div>
      </s-section>

      {/* 3. Main Reporting Content (Blurred for Free Tier) */}
      <div style={previewContainerStyle}>
        {/* Headline KPIs (ChatGPT Ads Only) */}
        <s-section heading="ChatGPT Ads Performance">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px" }}>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Attributed Revenue</p>
              <h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "600" }}>
                {formatMoney(data.headline.attributedRevenueMinor)}
              </h2>
              <p style={{ margin: 0, color: "#6D7175", fontSize: "11px" }}>Net of tax & tips</p>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Profit Before Spend</p>
              <h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "600" }}>
                {formatMoney(data.headline.attributedProfitBeforeSpendMinor)}
              </h2>
              {data.headline.isEstimated ? (
                <s-badge tone="warning">Estimated</s-badge>
              ) : (
                <s-badge tone="success">Real Costs</s-badge>
              )}
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>ChatGPT Ad Spend</p>
              <h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "600" }}>
                {formatMoney(data.headline.adSpendMinor)}
              </h2>
              <p style={{ margin: 0, color: "#6D7175", fontSize: "11px" }}>{data.currency} Invoiced</p>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Profit After Ad Spend</p>
              <h2
                style={{
                  margin: "0 0 4px 0",
                  fontSize: "20px",
                  fontWeight: "600",
                  color: data.headline.profitAfterAdSpendMinor >= 0 ? "#10B981" : "#EF4444",
                }}
              >
                {formatMoney(data.headline.profitAfterAdSpendMinor)}
              </h2>
              {data.headline.isEstimated ? (
                <s-badge tone="warning">Estimated</s-badge>
              ) : (
                <s-badge tone="success">Real Costs</s-badge>
              )}
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>ROAS</p>
              <h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "600" }}>
                {data.headline.roasFormatted}
              </h2>
              <p style={{ margin: 0, color: "#6D7175", fontSize: "11px" }}>
                Uses ChatGPT Ads' reported value (includes tax and shipping).
              </p>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Cost Per Sale</p>
              <h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "600" }}>
                {data.headline.cpaMinor !== null ? formatMoney(data.headline.cpaMinor) : "—"}
              </h2>
              <p style={{ margin: 0, color: "#6D7175", fontSize: "11px" }}>
                {data.headline.openAiReportedConversions} conversion(s)
              </p>
            </s-box>
          </div>

          {data.summaryText && (
            <div style={{ marginTop: "12px", padding: "8px 0" }}>
              <s-paragraph color="subdued">{data.summaryText}</s-paragraph>
            </div>
          )}
        </s-section>

        {/* 4. Daily Profit Trend Chart (Zero-Dependency SVG) */}
        <s-section heading="Daily Net Profit Trend">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            {data.dailyChart.length === 0 ? (
              <s-text color="subdued">No activity recorded for this period.</s-text>
            ) : (
              <div>
                <svg
                  viewBox={`0 0 ${Math.max(600, data.dailyChart.length * 60)} 180`}
                  style={{ width: "100%", height: "180px", display: "block" }}
                >
                  {/* Zero line */}
                  <line
                    x1="0"
                    y1="90"
                    x2={Math.max(600, data.dailyChart.length * 60)}
                    y2="90"
                    stroke="#D4D4D8"
                    strokeDasharray="4 4"
                    strokeWidth="1"
                  />
                  {data.dailyChart.map((d, i) => {
                    const colWidth = Math.max(600, data.dailyChart.length * 60) / data.dailyChart.length;
                    const x = i * colWidth + colWidth / 4;

                    const maxScale = 50000; // $500 scale
                    const profitHeight = Math.min(80, Math.abs(d.netProfitMinor) / maxScale * 75);
                    const isProfit = d.netProfitMinor >= 0;
                    const y = isProfit ? 90 - profitHeight : 90;
                    const barColor = isProfit ? "#10B981" : "#EF4444";

                    return (
                      <g key={d.date}>
                        <rect
                          x={x}
                          y={y}
                          width={colWidth / 2}
                          height={Math.max(3, profitHeight)}
                          fill={barColor}
                          rx="3"
                        />
                        <text
                          x={x + colWidth / 4}
                          y="170"
                          fontSize="10"
                          textAnchor="middle"
                          fill="#71717A"
                        >
                          {d.date.slice(5)}
                        </text>
                      </g>
                    );
                  })}
                </svg>

                <div style={{ display: "flex", gap: "16px", justifyContent: "center", marginTop: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: 12, height: 12, backgroundColor: "#10B981", borderRadius: 2 }} />
                    <s-text>Net Profit</s-text>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: 12, height: 12, backgroundColor: "#EF4444", borderRadius: 2 }} />
                    <s-text>Net Loss</s-text>
                  </div>
                </div>
              </div>
            )}
          </s-box>
        </s-section>

        {/* 5. Campaign Performance Table (With Total Row Matching KPIs) */}
        <s-section heading="Profit by Campaign">
          <s-table>
            <s-table-header-row>
              <s-table-cell>Campaign Name</s-table-cell>
              <s-table-cell>Spend</s-table-cell>
              <s-table-cell>Conversions</s-table-cell>
              <s-table-cell>Reported Value</s-table-cell>
              <s-table-cell>Allocated Profit</s-table-cell>
              <s-table-cell>Net Ad Profit</s-table-cell>
              <s-table-cell>ROAS</s-table-cell>
              <s-table-cell>Cost Per Sale</s-table-cell>
              <s-table-cell>Accuracy</s-table-cell>
            </s-table-header-row>
            <s-table-body>
              {data.campaignsTable.items.map((camp) => (
                <s-table-row key={camp.campaignId}>
                  <s-table-cell><strong>{camp.campaignName}</strong></s-table-cell>
                  <s-table-cell>{formatMoney(camp.spendMinor)}</s-table-cell>
                  <s-table-cell>{camp.reportedConversions}</s-table-cell>
                  <s-table-cell>{formatMoney(camp.reportedConversionValueMinor)}</s-table-cell>
                  <s-table-cell>{formatMoney(camp.allocatedProfitBeforeSpendMinor)}</s-table-cell>
                  <s-table-cell>
                    <strong style={{ color: camp.netAdProfitMinor >= 0 ? "#10B981" : "#EF4444" }}>
                      {formatMoney(camp.netAdProfitMinor)}
                    </strong>
                  </s-table-cell>
                  <s-table-cell>{camp.roasFormatted}</s-table-cell>
                  <s-table-cell>{camp.cpaMinor !== null ? formatMoney(camp.cpaMinor) : "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={camp.isEstimated ? "neutral" : "success"}>
                      {camp.badgeText}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}

              {/* Total Row (Strictly Matching Headline KPIs) */}
              <s-table-row>
                <s-table-cell><strong>Total (All Campaigns)</strong></s-table-cell>
                <s-table-cell><strong>{formatMoney(data.campaignsTable.totalRow.spendMinor)}</strong></s-table-cell>
                <s-table-cell><strong>{data.campaignsTable.totalRow.reportedConversions}</strong></s-table-cell>
                <s-table-cell><strong>{formatMoney(data.campaignsTable.totalRow.reportedConversionValueMinor)}</strong></s-table-cell>
                <s-table-cell><strong>{formatMoney(data.campaignsTable.totalRow.allocatedProfitBeforeSpendMinor)}</strong></s-table-cell>
                <s-table-cell>
                  <strong style={{ color: data.campaignsTable.totalRow.netAdProfitMinor >= 0 ? "#10B981" : "#EF4444" }}>
                    {formatMoney(data.campaignsTable.totalRow.netAdProfitMinor)}
                  </strong>
                </s-table-cell>
                <s-table-cell><strong>{data.campaignsTable.totalRow.roasFormatted}</strong></s-table-cell>
                <s-table-cell>
                  <strong>
                    {data.campaignsTable.totalRow.cpaMinor !== null
                      ? formatMoney(data.campaignsTable.totalRow.cpaMinor)
                      : "—"}
                  </strong>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={data.headline.isEstimated ? "warning" : "success"}>
                    {data.campaignsTable.totalRow.badgeText}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            </s-table-body>
          </s-table>
        </s-section>

        {/* 6. Product Performance Table */}
        <s-section heading="Profit by Product">
          <s-table>
            <s-table-header-row>
              <s-table-cell>Product</s-table-cell>
              <s-table-cell>Units Sold</s-table-cell>
              <s-table-cell>Net Revenue</s-table-cell>
              <s-table-cell>COGS</s-table-cell>
              <s-table-cell>Net Overhead</s-table-cell>
              <s-table-cell>Product Profit</s-table-cell>
              <s-table-cell>Margin</s-table-cell>
              <s-table-cell>Cost Accuracy</s-table-cell>
            </s-table-header-row>
            <s-table-body>
              {data.productsTable.items.length === 0 ? (
                <s-table-row>
                  <s-table-cell>
                    <s-text color="subdued">No product sales recorded in this date range.</s-text>
                  </s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                  <s-table-cell>-</s-table-cell>
                </s-table-row>
              ) : (
                data.productsTable.items.map((prod) => (
                  <s-table-row key={prod.productId}>
                    <s-table-cell><strong>{prod.title}</strong></s-table-cell>
                    <s-table-cell>{prod.unitsSold}</s-table-cell>
                    <s-table-cell>{formatMoney(prod.netRevenueMinor)}</s-table-cell>
                    <s-table-cell>{formatMoney(prod.cogsMinor)}</s-table-cell>
                    <s-table-cell>{formatMoney(prod.netOverheadMinor)}</s-table-cell>
                    <s-table-cell>
                      <strong style={{ color: prod.productProfitMinor >= 0 ? "#10B981" : "#EF4444" }}>
                        {formatMoney(prod.productProfitMinor)}
                      </strong>
                    </s-table-cell>
                    <s-table-cell>{(prod.marginBps / 100).toFixed(1)}%</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={prod.costSource === "REAL" ? "success" : "neutral"}>
                        {prod.badgeText}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                ))
              )}
            </s-table-body>
          </s-table>
        </s-section>

        {/* 7. Whole Store Context (Secondary Section) */}
        <s-section heading="Whole Store Context">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
              <div>
                <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Total Store Net Revenue</p>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>{formatMoney(data.wholeStore.netRevenueMinor)}</h3>
              </div>

              <div>
                <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Total Store Profit</p>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>{formatMoney(data.wholeStore.profitMinor)}</h3>
              </div>

              <div>
                <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Blended Store Margin</p>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>{data.wholeStore.marginFormatted}</h3>
              </div>

              <div>
                <p style={{ margin: "0 0 4px 0", color: "#6D7175", fontSize: "12px" }}>Total Orders</p>
                <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>{data.wholeStore.totalOrdersCount}</h3>
              </div>
            </div>
          </s-box>
        </s-section>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
