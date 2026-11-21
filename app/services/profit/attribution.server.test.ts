import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatRoas,
  calcRoasBps,
  calcCpaMinor,
  extractCampaignFromLandingUrl,
  classifyOrderAttribution,
  calculateStoreAttribution,
} from "./attribution.server.ts";
import type {
  ProfitOrderInput,
  OrderProfitResult,
  CampaignReportedInput,
} from "./types.ts";
import { DEFAULT_PROFIT_SETTINGS } from "./types.ts";

describe("Cartlight Attribution Engine (Prompt 6.2)", () => {
  it("formats basis-points scaled ROAS correctly and handles null safely", () => {
    assert.equal(formatRoas(32500), "3.25x");
    assert.equal(formatRoas(10000), "1.00x");
    assert.equal(formatRoas(500), "0.05x");
    assert.equal(formatRoas(0), "0.00x");
    assert.equal(formatRoas(null), "—");
  });

  it("calculates ROAS and CPA with BigInt rounding and division-by-zero protection", () => {
    // $100.00 revenue on $30.00 spend -> 10,000 * 10,000 / 3,000 = 33,333 bps (3.33x)
    assert.equal(calcRoasBps(10000, 3000), 33333);
    // $30.00 spend on 4 conversions -> 3000 / 4 = 750¢ ($7.50 CPA)
    assert.equal(calcCpaMinor(3000, 4), 750);

    // Division by zero returns null, never NaN or Infinity
    assert.equal(calcRoasBps(10000, 0), null);
    assert.equal(calcRoasBps(10000, -500), null);
    assert.equal(calcCpaMinor(3000, 0), null);
    assert.equal(calcCpaMinor(3000, -1), null);
  });

  it("extracts campaign ID accurately from landing URL macros (cl_cid, utm_campaign, campaign_id)", () => {
    assert.equal(
      extractCampaignFromLandingUrl("https://example.com/products/t-shirt?oppref=click_1&cl_cid=cmp_launch_2026"),
      "cmp_launch_2026"
    );
    assert.equal(
      extractCampaignFromLandingUrl("/products/shoes?utm_campaign=summer_promo&oppref=click_2"),
      "summer_promo"
    );
    assert.equal(
      extractCampaignFromLandingUrl("https://example.com?campaign_id=cmp_direct_99"),
      "cmp_direct_99"
    );
    assert.equal(extractCampaignFromLandingUrl("https://example.com/no-params"), null);
    assert.equal(extractCampaignFromLandingUrl(null), null);
  });

  it("strictly validates extracted campaign ID against known OpenAI campaign IDs", () => {
    const knownCampaigns = new Set(["cmp_spring_2026", "cmp_retargeting_usa"]);

    // Real OpenAI campaign ID in utm_campaign -> matched
    assert.equal(
      extractCampaignFromLandingUrl(
        "https://example.com/products/hat?utm_campaign=cmp_spring_2026",
        knownCampaigns
      ),
      "cmp_spring_2026"
    );

    // Arbitrary UTM tag (e.g. 'black-friday-sale') not in synced campaigns -> ignored (null)
    assert.equal(
      extractCampaignFromLandingUrl(
        "https://example.com/products/hat?utm_campaign=black-friday-sale",
        knownCampaigns
      ),
      null
    );

    // cl_cid with matching campaign -> matched
    assert.equal(
      extractCampaignFromLandingUrl(
        "https://example.com/?cl_cid=cmp_retargeting_usa",
        knownCampaigns
      ),
      "cmp_retargeting_usa"
    );

    // cl_cid with unknown campaign -> ignored
    assert.equal(
      extractCampaignFromLandingUrl(
        "https://example.com/?cl_cid=cmp_unknown_random",
        knownCampaigns
      ),
      null
    );
  });

  it("classifies order attribution: stamps gross sent value and enforces refund attribution inheritance", () => {
    const mockOrder: ProfitOrderInput = {
      orderId: "ord_101",
      orderDate: "2026-11-01T12:00:00Z",
      totalChargedMinor: 11000, // Gross charged (sent to Pixel/CAPI)
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod_1",
          quantity: 1,
          priceMinor: 10000,
          snapshotUnitCostMinor: 4000,
          costSource: "REAL",
        },
      ],
      attribution: {
        clickId: "oppref_test_abc123",
      },
    };

    const mockProfitResult: OrderProfitResult = {
      orderId: "ord_101",
      orderDate: "2026-11-01T12:00:00Z",
      netRevenueMinor: 10000,
      cogsMinor: 4000,
      realCogsMinor: 4000,
      estimatedCogsMinor: 0,
      shippingExpenseMinor: 500,
      paymentFeeMinor: 349,
      saleEventProfitMinor: 5151,
      refundImpactMinor: -2000,
      lifetimeProfitMinor: 3151,
      isEstimated: false,
      estimationReasons: [],
      lineItemProfits: [],
      refundImpacts: [
        {
          refundId: "ref_101_1",
          refundDate: "2026-11-15T10:00:00Z",
          refundAmountMinor: 2000,
          restockedCreditMinor: 0,
          refundedFeeMinor: 0,
          netImpactMinor: -2000,
        },
      ],
    };

    const classified = classifyOrderAttribution(mockOrder, mockProfitResult);

    assert.equal(classified.status, "MATCHED_CLICK");
    assert.equal(classified.clickId, "oppref_test_abc123");
    assert.equal(classified.sentConversionValueMinor, 11000); // Gross value sent to OpenAI
    assert.equal(classified.netRevenueMinor, 10000);
    assert.equal(classified.saleProfitMinor, 5151);

    // Refund strictly inherits parent order attribution status
    assert.equal(classified.refunds?.length, 1);
    assert.equal(classified.refunds?.[0].inheritedStatus, "MATCHED_CLICK");
    assert.equal(classified.refunds?.[0].refundImpactMinor, -2000);

    // Unattributed order inherits NOT_ATTRIBUTED
    const unattributedOrder: ProfitOrderInput = {
      ...mockOrder,
      orderId: "ord_102",
      attribution: null,
    };
    const unattributedClassified = classifyOrderAttribution(
      unattributedOrder,
      mockProfitResult
    );
    assert.equal(unattributedClassified.status, "NOT_ATTRIBUTED");
    assert.equal(unattributedClassified.refunds?.[0].inheritedStatus, "NOT_ATTRIBUTED");
  });

  it("handles exact 1:1 match: zero unmatched value, 100% matched profit", () => {
    // 3 matched orders, each with $100 sent value, $100 net revenue, $50 profit
    const matchedOrders = [1, 2, 3].map((i) => ({
      orderId: `ord_${i}`,
      orderDate: "2026-11-01",
      status: "MATCHED_CLICK" as const,
      clickId: `oppref_${i}`,
      eventId: null,
      campaignId: `cmp_${i}`,
      sentConversionValueMinor: 10000,
      netRevenueMinor: 10000,
      saleProfitMinor: 5000,
      isEstimated: false,
    }));

    const campaigns: CampaignReportedInput[] = [
      {
        campaignId: "cmp_all",
        reportedConversions: 3,
        reportedConversionValueMinor: 30000, // 30,000¢ matches 3 * 10,000¢ exactly
        spendMinor: 6000, // $60.00
      },
    ];

    const result = calculateStoreAttribution({
      orders: matchedOrders,
      allStoreOrders: [{ netRevenueMinor: 30000, profitMinor: 15000 }],
      campaigns,
    });

    assert.equal(result.matchedOrdersCount, 3);
    assert.equal(result.openAiReportedConversions, 3);
    assert.equal(result.unmatchedReportedValueMinor, 0);
    assert.equal(result.unmatchedEstimatedProfitMinor, 0);
    assert.equal(result.matchedProfitMinor, 15000);
    assert.equal(result.storeAttributedProfitBeforeSpendMinor, 15000);
    assert.equal(result.storeAttributedProfitAfterSpendMinor, 9000); // 15,000 - 6,000 spend
    assert.equal(result.isEstimated, false);

    // ROAS = 30,000 / 6,000 = 50,000 bps -> 5.00x
    assert.equal(result.roasBps, 50000);
    assert.equal(result.roasFormatted, "5.00x");
    // CPA = 6,000 / 3 = 2,000¢ ($20.00)
    assert.equal(result.cpaMinor, 2000);

    assert.match(
      result.summaryText,
      /All 3 orders perfectly matched ChatGPT Ads' reported conversions/
    );
  });

  it("calculates unmatched reported conversions where sent value includes tax (Value Basis Requirement)", () => {
    // Matched order: customer charged $110.00 (11,000¢, includes $10 tax).
    // Sent value to Pixel/CAPI = 11,000¢.
    // Net revenue = 10,000¢ (excluding tax).
    // Matched profit = 5,151¢.
    const matchedOrder = {
      orderId: "ord_tax_1",
      orderDate: "2026-11-01",
      status: "MATCHED_CLICK" as const,
      clickId: "oppref_tax",
      eventId: null,
      campaignId: null,
      sentConversionValueMinor: 11000,
      netRevenueMinor: 10000,
      saleProfitMinor: 5151,
      isEstimated: false,
    };

    // Store has other non-attributed orders: total store net revenue $20,000, total store profit $10,302
    // Blended store margin = 10,302 / 20,000 = 5,151 bps (51.51%)
    const allStoreOrders = [
      { netRevenueMinor: 10000, profitMinor: 5151 },
      { netRevenueMinor: 10000, profitMinor: 5151 },
    ];

    // OpenAI reported conversions: $220.00 (22,000¢) on the SAME gross sent basis
    const campaigns: CampaignReportedInput[] = [
      {
        campaignId: "cmp_main",
        reportedConversions: 2,
        reportedConversionValueMinor: 22000,
        spendMinor: 5000,
      },
    ];

    const result = calculateStoreAttribution({
      orders: [matchedOrder],
      allStoreOrders,
      campaigns,
    });

    // 1. Unmatched gross value = 22,000 - 11,000 = 11,000¢
    assert.equal(result.unmatchedReportedValueMinor, 11000);

    // 2. Sent-to-net ratio = 10,000 / 11,000 = 9,091 bps
    assert.equal(result.sentToNetRatioBps, 9091);

    // 3. Unmatched net revenue = round(11,000 * 9,091 / 10,000) = 10,000¢
    assert.equal(result.unmatchedNetRevenueMinor, 10000);

    // 4. Store margin = 10,302 / 20,000 = 5,151 bps
    assert.equal(result.storeMarginBps, 5151);

    // 5. Unmatched estimated profit = round(10,000 * 5,151 / 10,000) = 5,151¢
    assert.equal(result.unmatchedEstimatedProfitMinor, 5151);

    // 6. Store attributed profit before spend = matched (5,151) + unmatched (5,151) = 10,302¢
    assert.equal(result.storeAttributedProfitBeforeSpendMinor, 10302);
    // After spend: 10,302 - 5,000 = 5,302¢
    assert.equal(result.storeAttributedProfitAfterSpendMinor, 5302);

    assert.equal(result.isEstimated, true);
  });

  it("reconciles campaign profits with store total down to the exact cent (Cent-for-Cent Reconciliation)", () => {
    // Store has $56.80 attributed profit before spend (5,680¢)
    const matchedOrder = {
      orderId: "ord_rec_1",
      orderDate: "2026-11-01",
      status: "MATCHED_CLICK" as const,
      clickId: "oppref_rec",
      eventId: null,
      campaignId: null,
      sentConversionValueMinor: 10000,
      netRevenueMinor: 10000,
      saleProfitMinor: 5680,
      isEstimated: false,
    };

    // 3 campaigns with uneven conversion values and different spends
    const campaigns: CampaignReportedInput[] = [
      {
        campaignId: "cmp_A",
        campaignName: "Campaign Alpha",
        reportedConversions: 5,
        reportedConversionValueMinor: 5000, // 50%
        spendMinor: 1500, // $15.00
      },
      {
        campaignId: "cmp_B",
        campaignName: "Campaign Beta",
        reportedConversions: 3,
        reportedConversionValueMinor: 3000, // 30%
        spendMinor: 1000, // $10.00
      },
      {
        campaignId: "cmp_C",
        campaignName: "Campaign Gamma",
        reportedConversions: 2,
        reportedConversionValueMinor: 2000, // 20%
        spendMinor: 500, // $5.00
      },
    ];

    const result = calculateStoreAttribution({
      orders: [matchedOrder],
      allStoreOrders: [{ netRevenueMinor: 10000, profitMinor: 5680 }],
      campaigns,
    });

    assert.equal(result.storeAttributedProfitBeforeSpendMinor, 5680);
    const totalSpend = 1500 + 1000 + 500; // 3000¢
    assert.equal(result.totalSpendMinor, 3000);
    assert.equal(result.storeAttributedProfitAfterSpendMinor, 2680); // 5680 - 3000

    // Sum of allocated profits before spend MUST equal storeAttributedProfitBeforeSpendMinor exactly
    const sumAllocatedBeforeSpend = result.campaigns.reduce(
      (sum, c) => sum + c.allocatedProfitBeforeSpendMinor,
      0
    );
    assert.equal(sumAllocatedBeforeSpend, 5680);

    // Sum of campaign net ad profits MUST equal storeAttributedProfitAfterSpendMinor to the exact cent
    const sumCampaignNetAdProfits = result.campaigns.reduce(
      (sum, c) => sum + c.netAdProfitMinor,
      0
    );
    assert.equal(sumCampaignNetAdProfits, 2680);
    assert.equal(sumCampaignNetAdProfits, result.storeAttributedProfitAfterSpendMinor);

    // Verify per-campaign allocations:
    // Alpha: 5680 * 50% = 2840¢ before spend -> 2840 - 1500 = 1340¢ net profit
    assert.equal(result.campaigns[0].allocatedProfitBeforeSpendMinor, 2840);
    assert.equal(result.campaigns[0].netAdProfitMinor, 1340);
    assert.equal(result.campaigns[0].roasFormatted, "3.33x"); // 5000 / 1500 = 3.33x

    // Beta: 5680 * 30% = 1704¢ before spend -> 1704 - 1000 = 704¢ net profit
    assert.equal(result.campaigns[1].allocatedProfitBeforeSpendMinor, 1704);
    assert.equal(result.campaigns[1].netAdProfitMinor, 704);
    assert.equal(result.campaigns[1].roasFormatted, "3.00x"); // 3000 / 1000 = 3.00x

    // Gamma: 5680 * 20% = 1136¢ before spend -> 1136 - 500 = 636¢ net profit
    assert.equal(result.campaigns[2].allocatedProfitBeforeSpendMinor, 1136);
    assert.equal(result.campaigns[2].netAdProfitMinor, 636);
    assert.equal(result.campaigns[2].roasFormatted, "4.00x"); // 2000 / 500 = 4.00x
  });

  it("handles over-match discrepancy honestly and outputs approved reconciliation text", () => {
    // 5 matched orders ($500.00 sent value), but OpenAI reported 4 conversions ($400.00 value)
    const matchedOrders = [1, 2, 3, 4, 5].map((i) => ({
      orderId: `ord_over_${i}`,
      orderDate: "2026-11-01",
      status: "MATCHED_CLICK" as const,
      clickId: `oppref_over_${i}`,
      eventId: null,
      campaignId: null,
      sentConversionValueMinor: 10000,
      netRevenueMinor: 10000,
      saleProfitMinor: 4000,
      isEstimated: false,
    }));

    const campaigns: CampaignReportedInput[] = [
      {
        campaignId: "cmp_single",
        reportedConversions: 4,
        reportedConversionValueMinor: 40000,
        spendMinor: 10000, // $100.00
      },
    ];

    const result = calculateStoreAttribution({
      orders: matchedOrders,
      allStoreOrders: [{ netRevenueMinor: 50000, profitMinor: 20000 }],
      campaigns,
    });

    // Both counts are displayed honestly side-by-side
    assert.equal(result.matchedOrdersCount, 5);
    assert.equal(result.openAiReportedConversions, 4);

    // ROAS strictly uses OpenAI's reported numbers: 40,000 / 10,000 = 40,000 bps (4.00x)
    assert.equal(result.roasBps, 40000);
    assert.equal(result.roasFormatted, "4.00x");

    // CPA strictly uses OpenAI's reported conversions: 10,000 / 4 = 2,500¢ ($25.00)
    assert.equal(result.cpaMinor, 2500);

    // Approved reconciliation explanation text
    assert.equal(
      result.summaryText,
      "ChatGPT Ads reported 4 conversions, while Cartlight matched 5 orders. Differences can happen because of attribution rules or event deduplication. Official ROAS and cost per sale use ChatGPT Ads' reported numbers."
    );
  });

  it("safely falls back to default margin when total store net revenue is zero", () => {
    const campaigns: CampaignReportedInput[] = [
      {
        campaignId: "cmp_fallback",
        reportedConversions: 1,
        reportedConversionValueMinor: 10000,
        spendMinor: 2000,
      },
    ];

    const result = calculateStoreAttribution({
      orders: [],
      allStoreOrders: [], // 0 store revenue
      campaigns,
      settings: DEFAULT_PROFIT_SETTINGS, // defaultMarginBps: 4000
    });

    assert.equal(result.storeMarginBps, 4000); // 40% default margin fallback
    assert.equal(result.unmatchedReportedValueMinor, 10000);
    // Unmatched estimated profit: 10,000 * 4,000 / 10,000 = 4,000¢
    assert.equal(result.unmatchedEstimatedProfitMinor, 4000);
    assert.equal(result.storeAttributedProfitBeforeSpendMinor, 4000);
    assert.equal(result.storeAttributedProfitAfterSpendMinor, 2000); // 4,000 - 2,000 spend
  });
});
