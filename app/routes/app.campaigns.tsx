import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getCampaignsOverview } from "../services/campaigns/openai-campaigns.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const data = await getCampaignsOverview(shop.id);

  return {
    shopDomain: session.shop,
    currency: shop.currency,
    ...data,
  };
};

export default function CampaignsPage() {
  const { campaigns, totals, hasServingIssues, currency } =
    useLoaderData<typeof loader>();

  const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <s-page heading="OpenAI Campaigns Overview">
      {/* 1. Global Performance Metrics */}
      <s-section heading="Performance Summary">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Total Spend: </s-text>
            <s-text><strong>{formatMoney(totals.spendMinor)}</strong></s-text>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Conversions: </s-text>
            <s-text><strong>{totals.conversions}</strong></s-text>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Conversion Value: </s-text>
            <s-text><strong>{formatMoney(totals.conversionValueMinor)}</strong></s-text>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Clicks: </s-text>
            <s-text><strong>{totals.clicks}</strong></s-text>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Active Campaigns: </s-text>
            <s-badge tone="success">{totals.activeCampaignsCount}</s-badge>
          </s-box>
        </s-stack>
      </s-section>

      {/* 2. Serving Issues & Warnings Banner */}
      {hasServingIssues && (
        <s-banner tone="warning" heading="Campaign Serving Alerts & Warnings">
          <s-paragraph>
            One or more campaigns or ad groups have serving restrictions reported by OpenAI:
          </s-paragraph>
          <ul>
            {campaigns
              .flatMap((c) => c.warnings)
              .map((w, i) => (
                <li key={i} style={{ marginTop: "4px" }}>
                  <strong>{w.code}:</strong> {w.plainLanguageMessage}
                </li>
              ))}
          </ul>
        </s-banner>
      )}

      {/* 3. Campaigns List */}
      <s-section heading="Campaigns">
        <s-paragraph>
          Active and scheduled OpenAI advertising campaigns targeting ChatGPT search users.
        </s-paragraph>

        <s-table>
          <s-table-header-row>
            <s-table-cell>Campaign Name</s-table-cell>
            <s-table-cell>Status</s-table-cell>
            <s-table-cell>Daily Budget</s-table-cell>
            <s-table-cell>Bid Strategy & Target</s-table-cell>
            <s-table-cell>Spend</s-table-cell>
            <s-table-cell>Clicks</s-table-cell>
            <s-table-cell>Conversions</s-table-cell>
            <s-table-cell>Serving Status</s-table-cell>
          </s-table-header-row>
          <s-table-body>
            {campaigns.map((c) => (
              <s-table-row key={c.id}>
                <s-table-cell>
                  <s-text><strong>{c.name}</strong></s-text>
                  <p style={{ margin: "2px 0 0 0", fontSize: "11px", color: "#6d7175" }}>
                    ID: {c.id}
                  </p>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>
                    {c.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>
                  {formatMoney(c.dailyBudgetMinor)} / day
                </s-table-cell>
                <s-table-cell>
                  <s-text><strong>{c.bidStrategy}</strong></s-text>
                  {c.targetCpaMinor ? (
                    <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#2c6ecb" }}>
                      Target CPA: {formatMoney(c.targetCpaMinor)}
                    </p>
                  ) : c.targetCpcMinor ? (
                    <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#2c6ecb" }}>
                      Target CPC: {formatMoney(c.targetCpcMinor)}
                    </p>
                  ) : (
                    <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#6d7175" }}>
                      Auto-optimized
                    </p>
                  )}
                </s-table-cell>
                <s-table-cell>{formatMoney(c.metrics.spendMinor)}</s-table-cell>
                <s-table-cell>{c.metrics.clicks}</s-table-cell>
                <s-table-cell>
                  <strong>{c.metrics.conversions}</strong>
                  {c.metrics.conversions > 0 && (
                    <span style={{ fontSize: "11px", color: "#6d7175", marginLeft: "4px" }}>
                      ({formatMoney(c.metrics.conversionValueMinor)})
                    </span>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-badge
                    tone={
                      c.servingStatus === "SERVING"
                        ? "success"
                        : c.servingStatus === "NOT_SERVING"
                        ? "critical"
                        : "warning"
                    }
                  >
                    {c.servingStatus}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      {/* 4. Ad Groups & Ads Breakdown */}
      <s-section heading="Ad Groups & Ad Creatives">
        <s-paragraph>
          Detailed breakdown of ad groups and ad creatives under your active campaigns.
        </s-paragraph>

        {campaigns.map((c) =>
          c.adGroups.map((ag) => (
            <div key={ag.id} style={{ marginBottom: "16px" }}>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base">
                  <s-text>
                    <strong>Ad Group: {ag.name}</strong>
                  </s-text>
                  <s-badge tone={ag.status === "ACTIVE" ? "success" : "neutral"}>
                    {ag.status}
                  </s-badge>
                  {ag.targetCpaMinor && (
                    <s-text>Target CPA: {formatMoney(ag.targetCpaMinor)}</s-text>
                  )}
                </s-stack>

                <s-table>
                  <s-table-header-row>
                    <s-table-cell>Ad Creative</s-table-cell>
                    <s-table-cell>Status</s-table-cell>
                    <s-table-cell>Serving State</s-table-cell>
                    <s-table-cell>Spend</s-table-cell>
                    <s-table-cell>Clicks</s-table-cell>
                    <s-table-cell>Conversions</s-table-cell>
                  </s-table-header-row>
                  <s-table-body>
                    {ag.ads.map((ad) => (
                      <s-table-row key={ad.id}>
                        <s-table-cell>
                          <s-text><strong>{ad.name}</strong></s-text>
                          {ad.headline && (
                            <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#6d7175" }}>
                              Headline: "{ad.headline}"
                            </p>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge tone={ad.status === "ACTIVE" ? "success" : "neutral"}>
                            {ad.status}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={ad.servingStatus === "SERVING" ? "success" : "warning"}
                          >
                            {ad.servingStatus}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>{formatMoney(ad.metrics.spendMinor)}</s-table-cell>
                        <s-table-cell>{ad.metrics.clicks}</s-table-cell>
                        <s-table-cell>{ad.metrics.conversions}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            </s-box>
          </div>
        ))
      )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
