import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLocalDateInTimezone,
  shopDateToUtcBoundary,
  getShopDayRange,
  alignAdTimestampToShopDay,
  getProfitReportData,
  getFreePlanSampleData,
  checkRefreshCooldown,
  handleProfitLoader,
} from "./profit-reporting.server.ts";
import db from "../../db.server.ts";

describe("Profit Reporting Service (Prompt 6.3)", () => {
  describe("Timezone Alignment & Day Boundaries", () => {
    it("converts dates into local day string in specified IANA time zone", () => {
      // 2026-11-20T03:00:00Z -> In New York (UTC-5) it is 2026-11-19 22:00
      const d1 = new Date("2026-11-20T03:00:00.000Z");
      assert.equal(getLocalDateInTimezone(d1, "America/New_York"), "2026-11-19");

      // In Asia/Kolkata (UTC+5:30) it is 2026-11-20 08:30
      assert.equal(getLocalDateInTimezone(d1, "Asia/Kolkata"), "2026-11-20");

      // 2026-11-20T14:00:00Z -> In New York it is 2026-11-20 09:00
      const d2 = new Date("2026-11-20T14:00:00.000Z");
      assert.equal(getLocalDateInTimezone(d2, "America/New_York"), "2026-11-20");
    });

    it("aligns ad account in Asia/Kolkata with shop in America/New_York accurately", () => {
      // Scenario required by user: Shop in America/New_York, Ad Account in Asia/Kolkata.
      // An ad event occurred in Kolkata at 03:00 AM IST on Nov 20 (which is 21:30 UTC on Nov 19).
      const kolkataEarlyMorningUtc = new Date("2026-11-19T21:30:00.000Z");
      // In New York (EST, UTC-5), 21:30 UTC is 16:30 (4:30 PM) on Nov 19
      const alignedDay1 = alignAdTimestampToShopDay(
        kolkataEarlyMorningUtc,
        "America/New_York"
      );
      assert.equal(alignedDay1, "2026-11-19");

      // An ad event occurred in Kolkata at 14:00 PM IST on Nov 20 (which is 08:30 UTC on Nov 20).
      const kolkataAfternoonUtc = new Date("2026-11-20T08:30:00.000Z");
      // In New York (EST, UTC-5), 08:30 UTC is 03:30 (3:30 AM) on Nov 20
      const alignedDay2 = alignAdTimestampToShopDay(
        kolkataAfternoonUtc,
        "America/New_York"
      );
      assert.equal(alignedDay2, "2026-11-20");
    });

    it("computes start and end UTC boundaries for shop local date range", () => {
      // For date 2026-11-20 in America/New_York (UTC-5):
      // Start of day 00:00:00 EST -> 05:00:00 UTC
      const startUtc = shopDateToUtcBoundary("2026-11-20", "America/New_York", "start");
      assert.equal(startUtc.toISOString(), "2026-11-20T05:00:00.000Z");

      // End of day 23:59:59.999 EST -> next day 04:59:59.999 UTC
      const endUtc = shopDateToUtcBoundary("2026-11-20", "America/New_York", "end");
      assert.equal(endUtc.toISOString(), "2026-11-21T04:59:59.999Z");
    });

    it("generates correct presets for 7, 30, 90 days and custom ranges", () => {
      const refNow = new Date("2026-11-20T12:00:00.000Z");

      const range7 = getShopDayRange("7", null, null, "UTC", refNow);
      assert.equal(range7.endDate, "2026-11-20");
      assert.equal(range7.startDate, "2026-11-14");

      const range30 = getShopDayRange("30", null, null, "UTC", refNow);
      assert.equal(range30.endDate, "2026-11-20");
      assert.equal(range30.startDate, "2026-10-22");

      const rangeCustom = getShopDayRange(
        "custom",
        "2026-11-01",
        "2026-11-10",
        "UTC",
        refNow
      );
      assert.equal(rangeCustom.startDate, "2026-11-01");
      assert.equal(rangeCustom.endDate, "2026-11-10");
    });
  });

  describe("getProfitReportData() Database Aggregation", () => {
    it("loads headline KPIs, campaign table with Total row, product table, and daily chart strictly from database", async () => {
      const testDomain = `test-profit-${Date.now()}.myshopify.com`;
      const testShop = await db.shop.create({
        data: {
          shopDomain: testDomain,
          currency: "USD",
          timezone: "America/New_York",
          plan: "PRO",
        },
      });

      try {
        const orderDateUtc = new Date("2026-11-15T15:00:00.000Z"); // Fits Nov 15 in New York

        // 1. Matched Order Record in Database
        await db.orderProfitRecord.create({
          data: {
            shopId: testShop.id,
            shopifyOrderId: "ord_db_101",
            orderDate: orderDateUtc,
            totalChargedMinor: 11000, // $110.00 sent value (includes tax)
            netRevenueMinor: 10000,   // $100.00 net revenue
            cogsMinor: 4000,          // $40.00 COGS
            shippingCostMinor: 500,   // $5.00 shipping expense
            paymentFeeMinor: 349,     // $3.49 payment fee
            profitMinor: 5151,        // $51.51 profit
            isEstimated: false,
            costSource: "REAL",
            clickId: "oppref_test_db",
            attributionStatus: "MATCHED_CLICK",
            lineItemsJson: [
              {
                productId: "prod_hat_1",
                title: "Fedora Hat",
                quantity: 2,
                priceMinor: 10000,
                cogsMinor: 4000,
                allocatedNetOverheadMinor: 849,
                profitMinor: 5151,
                costSource: "REAL",
              },
            ],
          },
        });

        // 2. Unattributed Order Record in Database (for Whole Store context & store margin)
        await db.orderProfitRecord.create({
          data: {
            shopId: testShop.id,
            shopifyOrderId: "ord_db_102",
            orderDate: orderDateUtc,
            totalChargedMinor: 5000,
            netRevenueMinor: 5000,
            cogsMinor: 2000,
            shippingCostMinor: 500,
            paymentFeeMinor: 175,
            profitMinor: 2325,
            isEstimated: false,
            costSource: "REAL",
            attributionStatus: "NOT_ATTRIBUTED",
            lineItemsJson: [
              {
                productId: "prod_shirt_2",
                title: "Cotton Shirt",
                quantity: 1,
                priceMinor: 5000,
                cogsMinor: 2000,
                allocatedNetOverheadMinor: 675,
                profitMinor: 2325,
                costSource: "REAL",
              },
            ],
          },
        });

        // 3. DailyInsight in Database (Campaign performance)
        await db.dailyInsight.create({
          data: {
            shopId: testShop.id,
            date: new Date("2026-11-15T00:00:00.000Z"),
            level: "CAMPAIGN",
            entityId: "cmp_winter_launch",
            impressions: 1200,
            clicks: 80,
            spendMinor: 3000, // $30.00 spend
            conversions: 1,
            conversionValueMinor: 11000, // Matches $110.00 sent value
          },
        });

        // Query Profit Report Data for 7-day range
        const report = await getProfitReportData(testShop.id, {
          range: "7",
          settings: {
            defaultMarginBps: 3500, // 35.0% configured margin test
            shippingCostPerOrderMinor: 500,
            paymentFeeBps: 290,
            paymentFeeFixedMinor: 30,
            feesRefundedOnRefund: false,
          },
        });

        // 4. Verify Headline KPIs (ChatGPT Ads only)
        assert.equal(report.currency, "USD");
        assert.equal(report.timeZone, "America/New_York");
        assert.equal(report.headline.adSpendMinor, 3000); // $30.00
        assert.equal(report.headline.attributedRevenueMinor, 10000); // $100.00 net revenue
        assert.equal(report.headline.attributedProfitBeforeSpendMinor, 5151); // $51.51
        assert.equal(report.headline.profitAfterAdSpendMinor, 2151); // $51.51 - $30.00 = $21.51
        assert.equal(report.headline.openAiReportedConversions, 1);
        assert.equal(report.headline.matchedOrdersCount, 1);
        assert.equal(report.headline.roasFormatted, "3.67x"); // 11,000 / 3,000 = 3.67x
        assert.equal(report.headline.cpaMinor, 3000); // $30.00 CPA
        assert.equal(report.headline.estimatedMarginPercent, "35.0"); // Uses merchant's configured margin

        // 5. Verify Campaign Table & Total Row matches Headline
        assert.equal(report.campaignsTable.items.length, 1);
        const campRow = report.campaignsTable.items[0];
        assert.equal(campRow.campaignId, "cmp_winter_launch");
        assert.equal(campRow.spendMinor, 3000);
        assert.equal(campRow.netAdProfitMinor, 2151);
        assert.equal(campRow.roasFormatted, "3.67x");

        // Total Row strictly matches Headline KPIs
        assert.equal(report.campaignsTable.totalRow.spendMinor, report.headline.adSpendMinor);
        assert.equal(
          report.campaignsTable.totalRow.allocatedProfitBeforeSpendMinor,
          report.headline.attributedProfitBeforeSpendMinor
        );
        assert.equal(
          report.campaignsTable.totalRow.netAdProfitMinor,
          report.headline.profitAfterAdSpendMinor
        );
        assert.equal(report.campaignsTable.totalRow.roasFormatted, report.headline.roasFormatted);
        assert.equal(report.campaignsTable.totalRow.cpaMinor, report.headline.cpaMinor);

        // 6. Verify Product Table Aggregation & Badge
        assert.equal(report.productsTable.items.length, 2);
        const fedoraProduct = report.productsTable.items.find(
          (p) => p.productId === "prod_hat_1"
        );
        assert.ok(fedoraProduct);
        assert.equal(fedoraProduct.unitsSold, 2);
        assert.equal(fedoraProduct.netRevenueMinor, 10000);
        assert.equal(fedoraProduct.cogsMinor, 4000);
        assert.equal(fedoraProduct.productProfitMinor, 5151);
        assert.equal(fedoraProduct.badgeText, "Real COGS");

        // 7. Verify Whole Store Context
        assert.equal(report.wholeStore.totalOrdersCount, 2);
        assert.equal(report.wholeStore.netRevenueMinor, 15000); // 10,000 + 5,000
        assert.equal(report.wholeStore.profitMinor, 7476); // 5,151 + 2,325
        assert.equal(report.wholeStore.marginFormatted, "49.8%"); // 7,476 / 15,000 = 49.8%

        // 8. Verify Daily Chart Points Exist
        assert.ok(report.dailyChart.length >= 7);
      } finally {
        await db.orderProfitRecord.deleteMany({ where: { shopId: testShop.id } });
        await db.dailyInsight.deleteMany({ where: { shopId: testShop.id } });
        await db.shop.deleteMany({ where: { id: testShop.id } });
      }
    });
  });

  describe("Free-Plan Security & Data Masking", () => {
    it("loader output for a Free shop contains static sample preview data and NO real KPI values", async () => {
      const testDomain = `free-security-${Date.now()}.myshopify.com`;
      const testShop = await db.shop.create({
        data: {
          shopDomain: testDomain,
          currency: "USD",
          timezone: "America/New_York",
          plan: "FREE",
        },
      });

      try {
        const orderDateUtc = new Date("2026-11-15T15:00:00.000Z");

        // Real confidential merchant order in database
        await db.orderProfitRecord.create({
          data: {
            shopId: testShop.id,
            shopifyOrderId: "real_secret_order_999",
            orderDate: orderDateUtc,
            totalChargedMinor: 9999900, // $99,999.00
            netRevenueMinor: 9999900,
            cogsMinor: 4444400,
            shippingCostMinor: 0,
            paymentFeeMinor: 0,
            profitMinor: 5555500, // $55,555.00
            isEstimated: false,
            costSource: "REAL",
            clickId: "oppref_secret_click",
            attributionStatus: "MATCHED_CLICK",
            lineItemsJson: [
              {
                productId: "secret_luxury_item",
                title: "Confidential Diamond Ring",
                quantity: 1,
                priceMinor: 9999900,
                cogsMinor: 4444400,
                allocatedNetOverheadMinor: 0,
                profitMinor: 5555500,
                costSource: "REAL",
              },
            ],
          },
        });

        // Daily insight with real spend
        await db.dailyInsight.create({
          data: {
            shopId: testShop.id,
            date: new Date("2026-11-15T00:00:00.000Z"),
            level: "CAMPAIGN",
            entityId: "secret_cmp_xyz",
            impressions: 50000,
            clicks: 1000,
            spendMinor: 8888800, // $88,888.00
            conversions: 10,
            conversionValueMinor: 9999900,
          },
        });

        // Call handleProfitLoader with isPaidPlan = false
        const url = new URL("https://example.com/app/profit?range=7");
        const loaderOutput = await handleProfitLoader(testDomain, false, url);

        // 1. Assert isPaidPlan is false
        assert.equal(loaderOutput.isPaidPlan, false);

        // 2. Assert NO real KPI values are leaked
        assert.notEqual(loaderOutput.headline.attributedRevenueMinor, 9999900);
        assert.notEqual(loaderOutput.headline.attributedProfitBeforeSpendMinor, 5555500);
        assert.notEqual(loaderOutput.headline.adSpendMinor, 8888800);

        // 3. Assert strictly static preview numbers are returned
        assert.equal(loaderOutput.headline.attributedRevenueMinor, 1250000); // $12,500.00 preview
        assert.equal(loaderOutput.headline.attributedProfitBeforeSpendMinor, 625000); // $6,250.00 preview
        assert.equal(loaderOutput.headline.adSpendMinor, 250000); // $2,500.00 preview
        assert.equal(loaderOutput.headline.profitAfterAdSpendMinor, 375000); // $3,750.00 preview

        // 4. Assert full JSON output contains zero confidential order/product/campaign IDs
        const serialized = JSON.stringify(loaderOutput);
        assert.ok(!serialized.includes("real_secret_order_999"));
        assert.ok(!serialized.includes("secret_luxury_item"));
        assert.ok(!serialized.includes("Confidential Diamond Ring"));
        assert.ok(!serialized.includes("secret_cmp_xyz"));
        assert.ok(!serialized.includes("9999900"));
        assert.ok(!serialized.includes("5555500"));
        assert.ok(!serialized.includes("8888800"));
      } finally {
        await db.orderProfitRecord.deleteMany({ where: { shopId: testShop.id } });
        await db.dailyInsight.deleteMany({ where: { shopId: testShop.id } });
        await db.shop.deleteMany({ where: { id: testShop.id } });
      }
    });
  });

  describe("Estimated Badge Consistency Rules", () => {
    it("assigns 'Real Costs' badge when there is exactly one campaign with spend and real costs", async () => {
      const testDomain = `badge-single-${Date.now()}.myshopify.com`;
      const testShop = await db.shop.create({
        data: {
          shopDomain: testDomain,
          currency: "USD",
          timezone: "America/New_York",
          plan: "PRO",
        },
      });

      try {
        const orderDateUtc = new Date("2026-11-15T15:00:00.000Z");

        // Matched order with real cost
        await db.orderProfitRecord.create({
          data: {
            shopId: testShop.id,
            shopifyOrderId: "ord_single_1",
            orderDate: orderDateUtc,
            totalChargedMinor: 10000,
            netRevenueMinor: 10000,
            cogsMinor: 4000,
            shippingCostMinor: 500,
            paymentFeeMinor: 320,
            profitMinor: 5180,
            isEstimated: false,
            costSource: "REAL",
            clickId: "oppref_single_camp",
            attributionStatus: "MATCHED_CLICK",
            lineItemsJson: [
              {
                productId: "prod_1",
                title: "Product 1",
                quantity: 1,
                priceMinor: 10000,
                cogsMinor: 4000,
                allocatedNetOverheadMinor: 820,
                profitMinor: 5180,
                costSource: "REAL",
              },
            ],
          },
        });

        // Exactly one campaign with spend
        await db.dailyInsight.create({
          data: {
            shopId: testShop.id,
            date: new Date("2026-11-15T00:00:00.000Z"),
            level: "CAMPAIGN",
            entityId: "cmp_solo",
            impressions: 1000,
            clicks: 50,
            spendMinor: 2000,
            conversions: 1,
            conversionValueMinor: 10000,
          },
        });

        const report = await getProfitReportData(testShop.id, { range: "7" });

        // Headline badges: Profit Before Spend and Profit After Spend share the same badge
        assert.equal(report.headline.isEstimated, false);

        // Exactly one campaign with spend -> badge is "Real Costs"
        assert.equal(report.campaignsTable.items.length, 1);
        const campRow = report.campaignsTable.items[0];
        assert.equal(campRow.isEstimated, false);
        assert.equal(campRow.badgeText, "Real Costs");

        // Product row follows cost source
        assert.equal(report.productsTable.items[0].badgeText, "Real COGS");
      } finally {
        await db.orderProfitRecord.deleteMany({ where: { shopId: testShop.id } });
        await db.dailyInsight.deleteMany({ where: { shopId: testShop.id } });
        await db.shop.deleteMany({ where: { id: testShop.id } });
      }
    });

    it("assigns 'Estimated (Allocated)' badge to campaigns when there are two campaigns without direct tracking", async () => {
      const testDomain = `badge-multi-${Date.now()}.myshopify.com`;
      const testShop = await db.shop.create({
        data: {
          shopDomain: testDomain,
          currency: "USD",
          timezone: "America/New_York",
          plan: "PRO",
        },
      });

      try {
        const orderDateUtc = new Date("2026-11-15T15:00:00.000Z");

        // Order without direct campaign tracking
        await db.orderProfitRecord.create({
          data: {
            shopId: testShop.id,
            shopifyOrderId: "ord_multi_1",
            orderDate: orderDateUtc,
            totalChargedMinor: 20000,
            netRevenueMinor: 20000,
            cogsMinor: 8000,
            shippingCostMinor: 1000,
            paymentFeeMinor: 640,
            profitMinor: 10360,
            isEstimated: false,
            costSource: "REAL",
            clickId: "oppref_multi_camp",
            attributionStatus: "MATCHED_CLICK",
            lineItemsJson: [
              {
                productId: "prod_2",
                title: "Product 2",
                quantity: 2,
                priceMinor: 20000,
                cogsMinor: 8000,
                allocatedNetOverheadMinor: 1640,
                profitMinor: 10360,
                costSource: "REAL",
              },
            ],
          },
        });

        // Two campaigns with spend in the range
        await db.dailyInsight.create({
          data: {
            shopId: testShop.id,
            date: new Date("2026-11-15T00:00:00.000Z"),
            level: "CAMPAIGN",
            entityId: "cmp_alpha",
            impressions: 1000,
            clicks: 50,
            spendMinor: 3000,
            conversions: 1,
            conversionValueMinor: 12000, // 60% share
          },
        });
        await db.dailyInsight.create({
          data: {
            shopId: testShop.id,
            date: new Date("2026-11-15T00:00:00.000Z"),
            level: "CAMPAIGN",
            entityId: "cmp_beta",
            impressions: 800,
            clicks: 40,
            spendMinor: 2000,
            conversions: 1,
            conversionValueMinor: 8000, // 40% share
          },
        });

        const report = await getProfitReportData(testShop.id, { range: "7" });

        // Two campaigns without direct tracking -> both campaign rows must be "Estimated (Allocated)"
        assert.equal(report.campaignsTable.items.length, 2);
        for (const campRow of report.campaignsTable.items) {
          assert.equal(campRow.isEstimated, true);
          assert.equal(campRow.badgeText, "Estimated (Allocated)");
        }

        // Headline Profit Before Spend and Profit After Spend share the exact same badge state
        assert.equal(typeof report.headline.isEstimated, "boolean");
        assert.equal(report.headline.isEstimated, false); // Real costs used in order, but campaigns are allocated
      } finally {
        await db.orderProfitRecord.deleteMany({ where: { shopId: testShop.id } });
        await db.dailyInsight.deleteMany({ where: { shopId: testShop.id } });
        await db.shop.deleteMany({ where: { id: testShop.id } });
      }
    });
  });

  describe("Server-Side Refresh Data Cooldown (5 Minutes)", () => {
    it("enforces 5-minute cooldown and computes remaining minutes accurately", () => {
      const now = Date.now();

      // Case 1: Fresh sync 1 minute ago (4 minutes remaining)
      const sync1MinAgo = new Date(now - 1 * 60 * 1000);
      const res1 = checkRefreshCooldown(sync1MinAgo);
      assert.equal(res1.isCooldownActive, true);
      assert.equal(res1.remainingMinutes, 4);

      // Case 2: Sync 4 minutes 30 seconds ago (1 minute remaining)
      const sync4m30sAgo = new Date(now - 4.5 * 60 * 1000);
      const res2 = checkRefreshCooldown(sync4m30sAgo);
      assert.equal(res2.isCooldownActive, true);
      assert.equal(res2.remainingMinutes, 1);

      // Case 3: Sync 5 minutes 1 second ago (cooldown expired)
      const syncExpired = new Date(now - (5 * 60 * 1000 + 1000));
      const res3 = checkRefreshCooldown(syncExpired);
      assert.equal(res3.isCooldownActive, false);
      assert.equal(res3.remainingMinutes, 0);

      // Case 4: Never synced (null / undefined)
      const resNull = checkRefreshCooldown(null);
      assert.equal(resNull.isCooldownActive, false);
      assert.equal(resNull.remainingMinutes, 0);
    });
  });
});
