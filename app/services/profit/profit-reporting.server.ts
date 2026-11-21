import db from "../../db.server.ts";
import {
  calculateStoreAttribution,
  formatRoas,
  calcRoasBps,
  calcCpaMinor,
} from "./attribution.server.ts";
import {
  roundHalfAwayFromZero,
  allocateProportional,
} from "./money.server.ts";
import type {
  ProfitSettings,
  AttributedOrderRecord,
  CampaignReportedInput,
  StoreAttributionResult,
} from "./types.ts";
import { DEFAULT_PROFIT_SETTINGS } from "./types.ts";

export interface DateRangeResult {
  range: string;
  startDate: string; // YYYY-MM-DD in shop timezone
  endDate: string;   // YYYY-MM-DD in shop timezone
  startUtc: Date;
  endUtc: Date;
}

/**
 * Returns the local date string (YYYY-MM-DD) for a given UTC Date in a specific IANA time zone.
 */
export function getLocalDateInTimezone(date: Date, timeZone: string = "UTC"): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date); // Output format: YYYY-MM-DD
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export const PROFIT_REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Checks server-side if data refresh cooldown is active for this shop.
 */
export function checkRefreshCooldown(lastSyncAt?: Date | string | null): {
  isCooldownActive: boolean;
  remainingMinutes: number;
} {
  if (!lastSyncAt) {
    return { isCooldownActive: false, remainingMinutes: 0 };
  }
  const lastSyncDate = typeof lastSyncAt === "string" ? new Date(lastSyncAt) : lastSyncAt;
  const elapsedMs = Date.now() - lastSyncDate.getTime();
  if (elapsedMs < PROFIT_REFRESH_COOLDOWN_MS) {
    const remainingMs = PROFIT_REFRESH_COOLDOWN_MS - elapsedMs;
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    return { isCooldownActive: true, remainingMinutes };
  }
  return { isCooldownActive: false, remainingMinutes: 0 };
}

/**
 * Generates static, clearly fake sample preview data for Free plans.
 * ZERO real merchant data is ever queried or returned to the browser for Free plans.
 */
export function getFreePlanSampleData(
  currency: string = "USD",
  timeZone: string = "UTC",
  dateRangePreset: string = "7"
): ProfitReportResponse {
  const dateRange = getShopDayRange(dateRangePreset, null, null, timeZone);

  return {
    currency,
    timeZone,
    lastProfitSyncAt: null,
    dateRange,
    isEstimated: false,
    headline: {
      attributedRevenueMinor: 1250000, // $12,500.00 (clearly fake preview numbers)
      attributedProfitBeforeSpendMinor: 625000, // $6,250.00
      adSpendMinor: 250000, // $2,500.00
      profitAfterAdSpendMinor: 375000, // $3,750.00
      roasBps: 50000,
      roasFormatted: "5.00x",
      cpaMinor: 2500, // $25.00
      openAiReportedConversions: 100,
      matchedOrdersCount: 100,
      isEstimated: false,
      estimatedMarginPercent: "40.0",
    },
    wholeStore: {
      netRevenueMinor: 4500000, // $45,000.00
      profitMinor: 2250000, // $22,500.00
      marginBps: 5000,
      marginFormatted: "50.0%",
      totalOrdersCount: 350,
    },
    dailyChart: [
      { date: "Day 1", attributedRevenueMinor: 180000, adSpendMinor: 35000, netProfitMinor: 55000, isEstimated: false },
      { date: "Day 2", attributedRevenueMinor: 190000, adSpendMinor: 35000, netProfitMinor: 60000, isEstimated: false },
      { date: "Day 3", attributedRevenueMinor: 160000, adSpendMinor: 40000, netProfitMinor: 40000, isEstimated: false },
      { date: "Day 4", attributedRevenueMinor: 210000, adSpendMinor: 35000, netProfitMinor: 70000, isEstimated: false },
      { date: "Day 5", attributedRevenueMinor: 175000, adSpendMinor: 35000, netProfitMinor: 52500, isEstimated: false },
      { date: "Day 6", attributedRevenueMinor: 165000, adSpendMinor: 35000, netProfitMinor: 47500, isEstimated: false },
      { date: "Day 7", attributedRevenueMinor: 170000, adSpendMinor: 35000, netProfitMinor: 50000, isEstimated: false },
    ],
    campaignsTable: {
      items: [
        {
          campaignId: "sample_cmp_1",
          campaignName: "Sample Campaign Alpha (Preview)",
          spendMinor: 150000,
          reportedConversions: 60,
          reportedConversionValueMinor: 750000,
          allocatedProfitBeforeSpendMinor: 375000,
          netAdProfitMinor: 225000,
          roasFormatted: "5.00x",
          cpaMinor: 2500,
          isEstimated: false,
          badgeText: "Real Costs",
        },
        {
          campaignId: "sample_cmp_2",
          campaignName: "Sample Campaign Beta (Preview)",
          spendMinor: 100000,
          reportedConversions: 40,
          reportedConversionValueMinor: 500000,
          allocatedProfitBeforeSpendMinor: 250000,
          netAdProfitMinor: 150000,
          roasFormatted: "5.00x",
          cpaMinor: 2500,
          isEstimated: false,
          badgeText: "Real Costs",
        },
      ],
      totalRow: {
        spendMinor: 250000,
        reportedConversions: 100,
        reportedConversionValueMinor: 1250000,
        allocatedProfitBeforeSpendMinor: 625000,
        netAdProfitMinor: 375000,
        roasFormatted: "5.00x",
        cpaMinor: 2500,
        badgeText: "Real Costs",
      },
      totalCount: 2,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    },
    productsTable: {
      items: [
        {
          productId: "sample_prod_1",
          title: "Sample Product A (Preview)",
          unitsSold: 50,
          netRevenueMinor: 750000,
          cogsMinor: 300000,
          netOverheadMinor: 75000,
          productProfitMinor: 375000,
          marginBps: 5000,
          costSource: "REAL",
          badgeText: "Real COGS",
        },
      ],
      totalCount: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    },
    summaryText: "Sample preview data for Free tier. Upgrade to Pro to view real-time store profit.",
  };
}
export function shopDateToUtcBoundary(
  dateStr: string,
  timeZone: string = "UTC",
  boundary: "start" | "end" = "start"
): Date {
  const [year, month, day] = dateStr.split("-").map(Number);

  try {
    // Probe offset using 12:00:00 UTC (noon) to avoid boundary DST artifacts and sub-second discrepancies
    const probeDate = new Date(`${dateStr}T12:00:00.000Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(probeDate);

    const partMap: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") {
        partMap[p.type] = parseInt(p.value, 10);
      }
    }

    const localNoonMs = Date.UTC(
      partMap.year || year,
      (partMap.month || month) - 1,
      partMap.day || day,
      partMap.hour || 12,
      partMap.minute || 0,
      partMap.second || 0
    );

    // offsetMs = Local Time - UTC Time
    const offsetMs = localNoonMs - probeDate.getTime();

    // Desired local target in ms
    const desiredLocalMs = Date.UTC(
      year,
      month - 1,
      day,
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999
    );

    // UTC = desiredLocal - offsetMs
    return new Date(desiredLocalMs - offsetMs);
  } catch {
    return boundary === "start"
      ? new Date(`${dateStr}T00:00:00.000Z`)
      : new Date(`${dateStr}T23:59:59.999Z`);
  }
}

/**
 * Computes reporting start and end date boundaries in the shop's local time zone.
 * Supported presets: 7 (default), 30, 90, or custom (with customStart and customEnd).
 */
export function getShopDayRange(
  range: string = "7",
  customStart?: string | null,
  customEnd?: string | null,
  timeZone: string = "UTC",
  referenceNow: Date = new Date()
): DateRangeResult {
  const currentShopDateStr = getLocalDateInTimezone(referenceNow, timeZone);
  const [refY, refM, refD] = currentShopDateStr.split("-").map(Number);

  let startDateStr: string;
  let endDateStr: string;

  if (range === "custom" && customStart && customEnd) {
    startDateStr = customStart.slice(0, 10);
    endDateStr = customEnd.slice(0, 10);
    if (startDateStr > endDateStr) {
      [startDateStr, endDateStr] = [endDateStr, startDateStr];
    }
  } else {
    endDateStr = currentShopDateStr;
    const daysBack = range === "90" ? 89 : range === "30" ? 29 : 6; // 7 days inclusive: today + 6 days back

    // Derive past date in UTC arithmetic based on shop local year/month/day
    const pastUtcMs = Date.UTC(refY, refM - 1, refD) - daysBack * 24 * 60 * 60 * 1000;
    const pastDate = new Date(pastUtcMs);
    startDateStr = pastDate.toISOString().slice(0, 10);
  }

  const startUtc = shopDateToUtcBoundary(startDateStr, timeZone, "start");
  const endUtc = shopDateToUtcBoundary(endDateStr, timeZone, "end");

  return {
    range,
    startDate: startDateStr,
    endDate: endDateStr,
    startUtc,
    endUtc,
  };
}

/**
 * Aligns ad interaction timestamps or daily ad metrics from the ad account time zone
 * into the shop's local calendar day.
 *
 * Example: An ad event occurring at 2026-11-20 03:00 IST (UTC 2026-11-19 21:30)
 * falls into shop date 2026-11-19 in America/New_York (UTC-5: 16:30 EST).
 */
export function alignAdTimestampToShopDay(
  utcTimestamp: Date | string,
  shopTimezone: string = "UTC"
): string {
  const d = typeof utcTimestamp === "string" ? new Date(utcTimestamp) : utcTimestamp;
  return getLocalDateInTimezone(d, shopTimezone);
}

export interface DailyProfitPoint {
  date: string; // YYYY-MM-DD
  attributedRevenueMinor: number;
  adSpendMinor: number;
  netProfitMinor: number;
  isEstimated: boolean;
}

export interface ProductProfitRow {
  productId: string;
  title: string;
  unitsSold: number;
  netRevenueMinor: number;
  cogsMinor: number;
  netOverheadMinor: number;
  productProfitMinor: number;
  marginBps: number;
  costSource: "REAL" | "ESTIMATED";
  badgeText: string;
}

export interface ProfitReportResponse {
  currency: string;
  timeZone: string;
  lastProfitSyncAt: string | null;
  dateRange: DateRangeResult;
  isEstimated: boolean;

  // ChatGPT Ads Headline KPIs
  headline: {
    attributedRevenueMinor: number;
    attributedProfitBeforeSpendMinor: number;
    adSpendMinor: number;
    profitAfterAdSpendMinor: number;
    roasBps: number | null;
    roasFormatted: string;
    cpaMinor: number | null;
    openAiReportedConversions: number;
    matchedOrdersCount: number;
    isEstimated: boolean;
    estimatedMarginPercent: string;
  };

  // Whole Store Context (Secondary)
  wholeStore: {
    netRevenueMinor: number;
    profitMinor: number;
    marginBps: number;
    marginFormatted: string;
    totalOrdersCount: number;
  };

  // Daily Chart Data
  dailyChart: DailyProfitPoint[];

  // Campaign Table
  campaignsTable: {
    items: Array<{
      campaignId: string;
      campaignName: string;
      spendMinor: number;
      reportedConversions: number;
      reportedConversionValueMinor: number;
      allocatedProfitBeforeSpendMinor: number;
      netAdProfitMinor: number;
      roasFormatted: string;
      cpaMinor: number | null;
      isEstimated: boolean;
      badgeText: string;
    }>;
    totalRow: {
      spendMinor: number;
      reportedConversions: number;
      reportedConversionValueMinor: number;
      allocatedProfitBeforeSpendMinor: number;
      netAdProfitMinor: number;
      roasFormatted: string;
      cpaMinor: number | null;
      badgeText: string;
    };
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  // Product Table
  productsTable: {
    items: ProductProfitRow[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  summaryText: string;
}

/**
 * Loads profit reporting data strictly from the database (OrderProfitRecord, DailyInsight, Shop).
 * ZERO live external API calls are made during report rendering.
 */
export async function getProfitReportData(
  shopId: string,
  options: {
    range?: string;
    customStart?: string | null;
    customEnd?: string | null;
    campaignPage?: number;
    productPage?: number;
    pageSize?: number;
    settings?: ProfitSettings;
  }
): Promise<ProfitReportResponse> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      shopDomain: true,
      currency: true,
      timezone: true,
      lastProfitSyncAt: true,
    },
  });

  if (!shop) {
    throw new Error(`Shop not found with id: ${shopId}`);
  }

  const timeZone = shop.timezone || "UTC";
  const currency = shop.currency || "USD";
  const settings = options.settings || DEFAULT_PROFIT_SETTINGS;
  const configuredMarginPercent = (settings.defaultMarginBps / 100).toFixed(1);

  // 1. Establish shop local calendar boundaries
  const dateRange = getShopDayRange(
    options.range || "7",
    options.customStart,
    options.customEnd,
    timeZone
  );

  // 2. Fetch OrderProfitRecords for this window from Database
  const orderRecords = await db.orderProfitRecord.findMany({
    where: {
      shopId,
      orderDate: {
        gte: dateRange.startUtc,
        lte: dateRange.endUtc,
      },
    },
    orderBy: { orderDate: "asc" },
  });

  // 3. Fetch DailyInsight records for this window from Database
  const startDayDate = new Date(`${dateRange.startDate}T00:00:00.000Z`);
  const endDayDate = new Date(`${dateRange.endDate}T00:00:00.000Z`);

  const dailyInsights = await db.dailyInsight.findMany({
    where: {
      shopId,
      date: {
        gte: startDayDate,
        lte: endDayDate,
      },
    },
    orderBy: { date: "asc" },
  });

  // 4. Map into AttributedOrderRecords for attribution engine
  const attributedOrders: AttributedOrderRecord[] = orderRecords.map((rec) => ({
    orderId: rec.shopifyOrderId,
    orderDate: rec.orderDate.toISOString(),
    status: (rec.attributionStatus as "MATCHED_CLICK" | "NOT_ATTRIBUTED") || "NOT_ATTRIBUTED",
    clickId: rec.clickId,
    eventId: rec.shopifyOrderId,
    campaignId: rec.campaignId,
    sentConversionValueMinor: rec.totalChargedMinor,
    netRevenueMinor: rec.netRevenueMinor,
    saleProfitMinor: rec.profitMinor,
    isEstimated: rec.isEstimated,
  }));

  // All store orders for blended store margin calculation
  const allStoreOrders = orderRecords.map((rec) => ({
    netRevenueMinor: rec.netRevenueMinor,
    profitMinor: rec.profitMinor,
  }));

  // 5. Aggregate DailyInsight by campaign
  const campaignInsightMap = new Map<
    string,
    {
      spendMinor: number;
      conversions: number;
      conversionValueMinor: number;
    }
  >();

  // Daily spend map by local shop date
  const dailySpendMap = new Map<string, number>();

  for (const insight of dailyInsights) {
    const dayStr = insight.date.toISOString().slice(0, 10);

    if (insight.level === "CAMPAIGN") {
      const existing = campaignInsightMap.get(insight.entityId) || {
        spendMinor: 0,
        conversions: 0,
        conversionValueMinor: 0,
      };
      existing.spendMinor += insight.spendMinor;
      existing.conversions += insight.conversions;
      existing.conversionValueMinor += insight.conversionValueMinor;
      campaignInsightMap.set(insight.entityId, existing);

      // Track daily spend
      const currentDaySpend = dailySpendMap.get(dayStr) || 0;
      dailySpendMap.set(dayStr, currentDaySpend + insight.spendMinor);
    } else if (insight.level === "ACCOUNT") {
      if (campaignInsightMap.size === 0) {
        // Fallback if no campaign-level breakdowns exist
        const currentDaySpend = dailySpendMap.get(dayStr) || 0;
        dailySpendMap.set(dayStr, currentDaySpend + insight.spendMinor);
      }
    }
  }

  // Convert campaign map to CampaignReportedInput array
  const campaignInputs: CampaignReportedInput[] = Array.from(
    campaignInsightMap.entries()
  ).map(([campaignId, metrics]) => ({
    campaignId,
    campaignName: campaignId,
    reportedConversions: metrics.conversions,
    reportedConversionValueMinor: metrics.conversionValueMinor,
    spendMinor: metrics.spendMinor,
  }));

  // 6. Run attribution engine
  const attributionResult: StoreAttributionResult = calculateStoreAttribution({
    orders: attributedOrders,
    allStoreOrders,
    campaigns: campaignInputs,
    settings,
  });

  // 7. Build daily timeseries chart data
  const dailyChartMap = new Map<
    string,
    {
      attributedRevenueMinor: number;
      adSpendMinor: number;
      attributedProfitBeforeSpendMinor: number;
      isEstimated: boolean;
    }
  >();

  // Initialize all days in the date range
  let curDate = new Date(`${dateRange.startDate}T00:00:00Z`);
  const stopDate = new Date(`${dateRange.endDate}T00:00:00Z`);

  while (curDate <= stopDate) {
    const dStr = curDate.toISOString().slice(0, 10);
    dailyChartMap.set(dStr, {
      attributedRevenueMinor: 0,
      adSpendMinor: dailySpendMap.get(dStr) || 0,
      attributedProfitBeforeSpendMinor: 0,
      isEstimated: false,
    });
    curDate = new Date(curDate.getTime() + 24 * 60 * 60 * 1000);
  }

  // Populate order profits by local shop day
  for (const order of orderRecords) {
    const orderLocalDay = getLocalDateInTimezone(order.orderDate, timeZone);
    const dayEntry = dailyChartMap.get(orderLocalDay);
    if (dayEntry && order.attributionStatus === "MATCHED_CLICK") {
      dayEntry.attributedRevenueMinor += order.netRevenueMinor;
      dayEntry.attributedProfitBeforeSpendMinor += order.profitMinor;
      if (order.isEstimated) {
        dayEntry.isEstimated = true;
      }
    }
  }

  // Distribute unmatched estimated profit across days with reported conversion value or spend
  if (attributionResult.unmatchedEstimatedProfitMinor > 0) {
    const days = Array.from(dailyChartMap.keys());
    if (days.length > 0) {
      const weights = days.map((d) => dailyChartMap.get(d)?.adSpendMinor || 1);
      const allocatedUnmatched = allocateProportional(
        attributionResult.unmatchedEstimatedProfitMinor,
        weights
      );
      days.forEach((d, i) => {
        const entry = dailyChartMap.get(d)!;
        entry.attributedProfitBeforeSpendMinor += allocatedUnmatched[i];
        entry.isEstimated = true;
      });
    }
  }

  const dailyChart: DailyProfitPoint[] = Array.from(dailyChartMap.entries()).map(
    ([date, metrics]) => ({
      date,
      attributedRevenueMinor: metrics.attributedRevenueMinor,
      adSpendMinor: metrics.adSpendMinor,
      netProfitMinor:
        metrics.attributedProfitBeforeSpendMinor - metrics.adSpendMinor,
      isEstimated: metrics.isEstimated || attributionResult.isEstimated,
    })
  );

  // 8. Build Campaign Table with Pagination & Total Row
  const campaignPage = Math.max(1, options.campaignPage || 1);
  const pageSize = options.pageSize || 10;

  // Rule: Campaign rows are "Real" only when profit is directly tracked or there is exactly one campaign with spend in the range; otherwise "Estimated".
  const campaignsWithSpend = attributionResult.campaigns.filter((c) => c.spendMinor > 0);
  const singleCampaignWithSpend = campaignsWithSpend.length === 1;

  const campaignRows = attributionResult.campaigns.map((c) => {
    const isDirectTracked = false; // Backlog macro cl_cid direct tracking
    const isSingleActive = singleCampaignWithSpend && c.spendMinor > 0;
    const isReal = (isDirectTracked || isSingleActive) && !attributionResult.isEstimated;
    const isEstimated = !isReal;

    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      spendMinor: c.spendMinor,
      reportedConversions: c.reportedConversions,
      reportedConversionValueMinor: c.reportedConversionValueMinor,
      allocatedProfitBeforeSpendMinor: c.allocatedProfitBeforeSpendMinor,
      netAdProfitMinor: c.netAdProfitMinor,
      roasFormatted: c.roasFormatted,
      cpaMinor: c.cpaMinor,
      isEstimated,
      badgeText: isEstimated ? "Estimated (Allocated)" : "Real Costs",
    };
  });

  const totalCampaigns = campaignRows.length;
  const totalCampaignPages = Math.max(1, Math.ceil(totalCampaigns / pageSize));
  const pagedCampaigns = campaignRows.slice(
    (campaignPage - 1) * pageSize,
    campaignPage * pageSize
  );

  const campaignTotalRow = {
    spendMinor: attributionResult.totalSpendMinor,
    reportedConversions: attributionResult.openAiReportedConversions,
    reportedConversionValueMinor: attributionResult.openAiReportedConversionValueMinor,
    allocatedProfitBeforeSpendMinor: attributionResult.storeAttributedProfitBeforeSpendMinor,
    netAdProfitMinor: attributionResult.storeAttributedProfitAfterSpendMinor,
    roasFormatted: attributionResult.roasFormatted,
    cpaMinor: attributionResult.cpaMinor,
    badgeText: attributionResult.isEstimated
      ? `Estimated (${configuredMarginPercent}% margin)`
      : "Real Costs",
  };

  // 9. Build Product Table with Pagination
  const productAggMap = new Map<
    string,
    {
      title: string;
      unitsSold: number;
      netRevenueMinor: number;
      cogsMinor: number;
      netOverheadMinor: number;
      productProfitMinor: number;
      hasEstimated: boolean;
    }
  >();

  for (const order of orderRecords) {
    const lineItems = (order.lineItemsJson as Array<{
      productId: string;
      title?: string;
      quantity: number;
      priceMinor: number;
      cogsMinor?: number;
      allocatedNetOverheadMinor?: number;
      profitMinor?: number;
      costSource?: string;
    }>) || [];

    for (const item of lineItems) {
      const pid = item.productId || "unknown";
      const existing = productAggMap.get(pid) || {
        title: item.title || `Product ${pid}`,
        unitsSold: 0,
        netRevenueMinor: 0,
        cogsMinor: 0,
        netOverheadMinor: 0,
        productProfitMinor: 0,
        hasEstimated: false,
      };

      existing.unitsSold += item.quantity || 1;
      existing.netRevenueMinor += item.priceMinor || 0;
      existing.cogsMinor += item.cogsMinor || 0;
      existing.netOverheadMinor += item.allocatedNetOverheadMinor || 0;
      existing.productProfitMinor += item.profitMinor || 0;
      if (item.costSource === "ESTIMATED") {
        existing.hasEstimated = true;
      }
      productAggMap.set(pid, existing);
    }
  }

  const productRows: ProductProfitRow[] = Array.from(productAggMap.entries()).map(
    ([productId, data]) => {
      let marginBps = 0;
      if (data.netRevenueMinor > 0) {
        marginBps = Number(
          roundHalfAwayFromZero(
            BigInt(data.productProfitMinor) * 10000n,
            BigInt(data.netRevenueMinor)
          )
        );
      }
      return {
        productId,
        title: data.title,
        unitsSold: data.unitsSold,
        netRevenueMinor: data.netRevenueMinor,
        cogsMinor: data.cogsMinor,
        netOverheadMinor: data.netOverheadMinor,
        productProfitMinor: data.productProfitMinor,
        marginBps,
        costSource: data.hasEstimated ? "ESTIMATED" : "REAL",
        badgeText: data.hasEstimated
          ? `Estimated (${configuredMarginPercent}% margin)`
          : "Real COGS",
      };
    }
  );

  const productPage = Math.max(1, options.productPage || 1);
  const totalProducts = productRows.length;
  const totalProductPages = Math.max(1, Math.ceil(totalProducts / pageSize));
  const pagedProducts = productRows.slice(
    (productPage - 1) * pageSize,
    productPage * pageSize
  );

  // 10. Whole Store Totals (Secondary Section)
  const wholeStoreNetRevenueMinor = allStoreOrders.reduce(
    (sum, o) => sum + o.netRevenueMinor,
    0
  );
  const wholeStoreProfitMinor = allStoreOrders.reduce(
    (sum, o) => sum + o.profitMinor,
    0
  );
  let wholeStoreMarginBps = 0;
  if (wholeStoreNetRevenueMinor > 0) {
    wholeStoreMarginBps = Number(
      roundHalfAwayFromZero(
        BigInt(wholeStoreProfitMinor) * 10000n,
        BigInt(wholeStoreNetRevenueMinor)
      )
    );
  }

  // 11. Attributed Net Revenue (Matched Net Revenue + Unmatched Net Revenue)
  const attributedNetRevenueMinor =
    attributionResult.matchedOrdersNetRevenueMinor +
    attributionResult.unmatchedNetRevenueMinor;

  return {
    currency,
    timeZone,
    lastProfitSyncAt: shop.lastProfitSyncAt?.toISOString() || null,
    dateRange,
    isEstimated: attributionResult.isEstimated,

    headline: {
      attributedRevenueMinor: attributedNetRevenueMinor,
      attributedProfitBeforeSpendMinor:
        attributionResult.storeAttributedProfitBeforeSpendMinor,
      adSpendMinor: attributionResult.totalSpendMinor,
      profitAfterAdSpendMinor:
        attributionResult.storeAttributedProfitAfterSpendMinor,
      roasBps: attributionResult.roasBps,
      roasFormatted: attributionResult.roasFormatted,
      cpaMinor: attributionResult.cpaMinor,
      openAiReportedConversions: attributionResult.openAiReportedConversions,
      matchedOrdersCount: attributionResult.matchedOrdersCount,
      isEstimated: attributionResult.isEstimated,
      estimatedMarginPercent: configuredMarginPercent,
    },

    wholeStore: {
      netRevenueMinor: wholeStoreNetRevenueMinor,
      profitMinor: wholeStoreProfitMinor,
      marginBps: wholeStoreMarginBps,
      marginFormatted: `${(wholeStoreMarginBps / 100).toFixed(1)}%`,
      totalOrdersCount: orderRecords.length,
    },

    dailyChart,

    campaignsTable: {
      items: pagedCampaigns,
      totalRow: campaignTotalRow,
      totalCount: totalCampaigns,
      page: campaignPage,
      pageSize,
      totalPages: totalCampaignPages,
    },

    productsTable: {
      items: pagedProducts,
      totalCount: totalProducts,
      page: productPage,
      pageSize,
      totalPages: totalProductPages,
    },

    summaryText: attributionResult.summaryText,
  };
}

/**
 * Core loader handler for Profit Report page.
 * Enforces Free-plan paywall security: Free plans strictly receive static fake preview data.
 * ZERO real merchant data is ever returned to the client browser on Free plans.
 */
export async function handleProfitLoader(
  shopDomain: string,
  isPaidPlan: boolean,
  url: URL
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const range = url.searchParams.get("range") || "7";
  const customStart = url.searchParams.get("startDate");
  const customEnd = url.searchParams.get("endDate");
  const campaignPage = parseInt(url.searchParams.get("cPage") || "1", 10);
  const productPage = parseInt(url.searchParams.get("pPage") || "1", 10);

  const cooldown = checkRefreshCooldown(shop.lastProfitSyncAt);

  // SECURITY: Free plan MUST NEVER receive real store data over the wire.
  if (!isPaidPlan) {
    const fakePreviewData = getFreePlanSampleData(shop.currency, shop.timezone, range);
    return {
      shopDomain,
      isPaidPlan: false,
      range,
      customStart,
      customEnd,
      campaignPage,
      productPage,
      cooldown,
      ...fakePreviewData,
    };
  }

  // 2. Load Real Profit Report Data from Database for Paid Plans
  const reportData = await getProfitReportData(shop.id, {
    range,
    customStart,
    customEnd,
    campaignPage,
    productPage,
    pageSize: 10,
  });

  return {
    shopDomain,
    isPaidPlan: true,
    range,
    customStart,
    customEnd,
    campaignPage,
    productPage,
    cooldown,
    ...reportData,
  };
}
