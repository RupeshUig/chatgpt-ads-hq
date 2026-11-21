import {
  roundHalfAwayFromZero,
  roundHalfAwayFromZeroInt,
  allocateProportional,
} from "./money.server.ts";
import type {
  ProfitOrderInput,
  OrderProfitResult,
  ProfitSettings,
  OrderAttributionStatus,
  AttributedOrderRecord,
  CampaignReportedInput,
  CampaignProfitReconciled,
  StoreAttributionResult,
} from "./types.ts";
import { DEFAULT_PROFIT_SETTINGS } from "./types.ts";

/**
 * Formats basis-points scaled ROAS into standard multiplier string (e.g., 32500 -> "3.25x").
 */
export function formatRoas(roasBps: number | null): string {
  if (roasBps == null) return "—";
  return `${(roasBps / 10000).toFixed(2)}x`;
}

/**
 * Calculates Return on Ad Spend (ROAS) in basis points (10000 = 1.00x).
 * Strictly returns null if ad spend is zero (never Infinity or NaN).
 */
export function calcRoasBps(
  reportedConversionValueMinor: number,
  spendMinor: number
): number | null {
  if (spendMinor <= 0) return null;
  const num = BigInt(reportedConversionValueMinor) * 10000n;
  const den = BigInt(spendMinor);
  return Number(roundHalfAwayFromZero(num, den));
}

/**
 * Calculates Cost Per Acquisition / Sale (CPA) in integer minor units.
 * Strictly returns null if conversion count is zero (never Infinity or NaN).
 */
export function calcCpaMinor(
  spendMinor: number,
  conversions: number
): number | null {
  if (conversions <= 0) return null;
  return Number(roundHalfAwayFromZero(BigInt(spendMinor), BigInt(conversions)));
}

/**
 * Extracts campaign identifier from order URL or attributes if present.
 * ONLY accepts candidate if it exactly matches a known OpenAI campaign ID for this shop.
 */
export function extractCampaignFromLandingUrl(
  url?: string | null,
  knownCampaignIds?: Set<string> | string[]
): string | null {
  if (!url || typeof url !== "string") return null;

  let candidate: string | null = null;

  try {
    const parsed = new URL(
      url.includes("://") ? url : `https://example.com${url.startsWith("/") ? "" : "/"}${url}`
    );
    const clCid = parsed.searchParams.get("cl_cid");
    const utmCampaign = parsed.searchParams.get("utm_campaign");
    const campaignId = parsed.searchParams.get("campaign_id");

    candidate = (clCid || utmCampaign || campaignId)?.trim() || null;
  } catch {
    // If URL parsing fails, regex fallback
    const match = url.match(/[?&](?:cl_cid|utm_campaign|campaign_id)=([^&#]+)/);
    if (match) {
      try {
        candidate = decodeURIComponent(match[1]).trim();
      } catch {
        candidate = match[1].trim();
      }
    }
  }

  if (!candidate) return null;

  // Strictly validate candidate against known synced OpenAI campaign IDs
  if (knownCampaignIds) {
    const isKnown =
      knownCampaignIds instanceof Set
        ? knownCampaignIds.has(candidate)
        : knownCampaignIds.includes(candidate);
    return isKnown ? candidate : null;
  }

  return candidate;
}

/**
 * Classifies an individual Shopify order's attribution status:
 * - MATCHED_CLICK: has oppref click ID or matching CAPI event_id
 * - NOT_ATTRIBUTED: no OpenAI ad interaction signal
 *
 * Captures sentConversionValueMinor (the exact gross totalCharged value sent to Pixel/CAPI)
 * and stamps refund attribution inheritance.
 */
export function classifyOrderAttribution(
  order: ProfitOrderInput,
  profitResult: OrderProfitResult,
  options?: {
    knownCapiEventIds?: Set<string>;
    knownCampaignIds?: Set<string> | string[];
    landingUrl?: string | null;
  }
): AttributedOrderRecord {
  const directClickId = order.attribution?.clickId?.trim() || null;
  const isCapiMatched = Boolean(
    options?.knownCapiEventIds && options.knownCapiEventIds.has(order.orderId)
  );

  const isMatched = Boolean(directClickId || isCapiMatched);
  const status: OrderAttributionStatus = isMatched
    ? "MATCHED_CLICK"
    : "NOT_ATTRIBUTED";

  let extractedCampaign: string | null = null;
  if (order.attribution?.campaignId) {
    const direct = order.attribution.campaignId.trim();
    if (!options?.knownCampaignIds) {
      extractedCampaign = direct;
    } else {
      const isKnown =
        options.knownCampaignIds instanceof Set
          ? options.knownCampaignIds.has(direct)
          : options.knownCampaignIds.includes(direct);
      extractedCampaign = isKnown ? direct : null;
    }
  }

  if (!extractedCampaign) {
    extractedCampaign = extractCampaignFromLandingUrl(
      options?.landingUrl,
      options?.knownCampaignIds
    );
  }

  // Refund events inherit parent order's attribution status strictly
  const refunds = (profitResult.refundImpacts || []).map((refund) => ({
    refundId: refund.refundId,
    refundDate: refund.refundDate,
    refundImpactMinor: refund.netImpactMinor,
    inheritedStatus: status,
  }));

  return {
    orderId: order.orderId,
    orderDate: typeof order.orderDate === "string" ? order.orderDate : order.orderDate.toISOString(),
    status,
    clickId: directClickId,
    eventId: isCapiMatched ? order.orderId : null,
    campaignId: extractedCampaign,
    sentConversionValueMinor: order.totalChargedMinor,
    netRevenueMinor: profitResult.netRevenueMinor,
    saleProfitMinor: profitResult.saleEventProfitMinor,
    isEstimated: profitResult.isEstimated,
    refunds,
  };
}

/**
 * Calculates store-level profit attribution and reconciles campaigns:
 *
 * 1. Store Attributed Profit Before Spend = matchedProfit + unmatchedEstimatedProfit
 * 2. Unmatched Reported Value = max(0, reportedConversionValue - sum of sent values for matched orders)
 * 3. Ratio of net revenue to sent value on matched orders converts unmatched gross value to net revenue
 * 4. Blended store profit margin across all orders over the same reporting window estimates profit
 * 5. Reconciles across campaigns using allocateProportional so campaign profits sum to the exact cent
 */
export function calculateStoreAttribution(options: {
  orders: AttributedOrderRecord[];
  allStoreOrders: Array<{ netRevenueMinor: number; profitMinor: number }>;
  campaigns: CampaignReportedInput[];
  settings?: ProfitSettings;
}): StoreAttributionResult {
  const settings = options.settings || DEFAULT_PROFIT_SETTINGS;

  const matchedOrders = options.orders.filter(
    (o) => o.status === "MATCHED_CLICK"
  );
  const matchedOrdersCount = matchedOrders.length;

  const matchedOrdersSentValueMinor = matchedOrders.reduce(
    (sum, o) => sum + o.sentConversionValueMinor,
    0
  );
  const matchedOrdersNetRevenueMinor = matchedOrders.reduce(
    (sum, o) => sum + o.netRevenueMinor,
    0
  );
  const matchedProfitMinor = matchedOrders.reduce(
    (sum, o) => sum + o.saleProfitMinor,
    0
  );

  // OpenAI Insights reported totals
  const openAiReportedConversions = options.campaigns.reduce(
    (sum, c) => sum + c.reportedConversions,
    0
  );
  const openAiReportedConversionValueMinor = options.campaigns.reduce(
    (sum, c) => sum + c.reportedConversionValueMinor,
    0
  );
  const totalSpendMinor = options.campaigns.reduce(
    (sum, c) => sum + c.spendMinor,
    0
  );

  // Unmatched reported value on the SAME basis (gross sent conversion value)
  const unmatchedReportedValueMinor = Math.max(
    0,
    openAiReportedConversionValueMinor - matchedOrdersSentValueMinor
  );

  // Convert unmatched gross value to net revenue using matched orders' net/sent ratio
  let sentToNetRatioBps: number;
  if (matchedOrdersSentValueMinor > 0) {
    sentToNetRatioBps = Number(
      roundHalfAwayFromZero(
        BigInt(matchedOrdersNetRevenueMinor) * 10000n,
        BigInt(matchedOrdersSentValueMinor)
      )
    );
  } else {
    sentToNetRatioBps = 10000; // Fallback 1.0 (10000 bps)
  }

  const unmatchedNetRevenueMinor = Number(
    roundHalfAwayFromZero(
      BigInt(unmatchedReportedValueMinor) * BigInt(sentToNetRatioBps),
      10000n
    )
  );

  // Store blended profit margin across ALL orders over the same reporting window
  const totalStoreNetRevenue = options.allStoreOrders.reduce(
    (sum, o) => sum + o.netRevenueMinor,
    0
  );
  const totalStoreProfit = options.allStoreOrders.reduce(
    (sum, o) => sum + o.profitMinor,
    0
  );

  let storeMarginBps: number;
  if (totalStoreNetRevenue > 0) {
    storeMarginBps = Number(
      roundHalfAwayFromZero(
        BigInt(totalStoreProfit) * 10000n,
        BigInt(totalStoreNetRevenue)
      )
    );
  } else {
    storeMarginBps = settings.defaultMarginBps;
  }

  // Estimated profit on unmatched revenue
  const unmatchedEstimatedProfitMinor = Number(
    roundHalfAwayFromZero(
      BigInt(unmatchedNetRevenueMinor) * BigInt(storeMarginBps),
      10000n
    )
  );

  const isEstimated =
    unmatchedReportedValueMinor > 0 ||
    matchedOrders.some((o) => o.isEstimated);

  const storeAttributedProfitBeforeSpendMinor =
    matchedProfitMinor + unmatchedEstimatedProfitMinor;
  const storeAttributedProfitAfterSpendMinor =
    storeAttributedProfitBeforeSpendMinor - totalSpendMinor;

  // Reconcile across campaigns using allocateProportional so cents sum exactly
  const campaignCount = options.campaigns.length;
  let allocatedProfitsBeforeSpend: number[] = [];

  if (campaignCount > 0) {
    const weights = options.campaigns.map((c) => c.reportedConversionValueMinor);
    const sumWeights = weights.reduce((sum, w) => sum + w, 0);

    if (sumWeights > 0) {
      allocatedProfitsBeforeSpend = allocateProportional(
        storeAttributedProfitBeforeSpendMinor,
        weights
      );
    } else {
      // Even allocation if all campaigns have 0 reported conversion value
      allocatedProfitsBeforeSpend = allocateProportional(
        storeAttributedProfitBeforeSpendMinor,
        Array(campaignCount).fill(1)
      );
    }
  }

  const reconciledCampaigns: CampaignProfitReconciled[] = options.campaigns.map(
    (campaign, idx) => {
      const allocatedProfitBeforeSpendMinor = allocatedProfitsBeforeSpend[idx] || 0;
      const netAdProfitMinor =
        allocatedProfitBeforeSpendMinor - campaign.spendMinor;

      const roasBps = calcRoasBps(
        campaign.reportedConversionValueMinor,
        campaign.spendMinor
      );
      const cpaMinor = calcCpaMinor(
        campaign.spendMinor,
        campaign.reportedConversions
      );

      return {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName || campaign.campaignId,
        reportedConversions: campaign.reportedConversions,
        reportedConversionValueMinor: campaign.reportedConversionValueMinor,
        spendMinor: campaign.spendMinor,
        allocatedProfitBeforeSpendMinor,
        netAdProfitMinor,
        roasBps,
        roasFormatted: formatRoas(roasBps),
        cpaMinor,
        isEstimated: isEstimated || campaign.reportedConversionValueMinor > 0,
      };
    }
  );

  // Store-level ROAS & CPA strictly using OpenAI's reported totals
  const roasBps = calcRoasBps(
    openAiReportedConversionValueMinor,
    totalSpendMinor
  );
  const roasFormatted = formatRoas(roasBps);
  const cpaMinor = calcCpaMinor(totalSpendMinor, openAiReportedConversions);

  // Plain-language summary text
  let summaryText: string;
  if (matchedOrdersCount !== openAiReportedConversions) {
    summaryText = `ChatGPT Ads reported ${openAiReportedConversions} conversions, while Cartlight matched ${matchedOrdersCount} orders. Differences can happen because of attribution rules or event deduplication. Official ROAS and cost per sale use ChatGPT Ads' reported numbers.`;
  } else {
    summaryText = `All ${matchedOrdersCount} orders perfectly matched ChatGPT Ads' reported conversions. Official ROAS and cost per sale use ChatGPT Ads' reported numbers.`;
  }

  return {
    matchedOrdersCount,
    matchedOrdersSentValueMinor,
    matchedOrdersNetRevenueMinor,
    matchedProfitMinor,

    openAiReportedConversions,
    openAiReportedConversionValueMinor,
    totalSpendMinor,

    unmatchedReportedValueMinor,
    sentToNetRatioBps,
    unmatchedNetRevenueMinor,
    storeMarginBps,
    unmatchedEstimatedProfitMinor,
    isEstimated,

    storeAttributedProfitBeforeSpendMinor,
    storeAttributedProfitAfterSpendMinor,

    roasBps,
    roasFormatted,
    cpaMinor,

    campaigns: reconciledCampaigns,
    summaryText,
  };
}
