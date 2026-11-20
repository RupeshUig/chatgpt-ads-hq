import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  averageOrderValue,
  grossMarginPerOrder,
  maxAffordableCpc,
  bestProductsToAdvertise,
  monthlyMinimumSpend,
  fitScore,
  DEFAULT_FIT_CHECK_CONFIG,
  type ProductInput,
  type OrderInput,
} from "./fit-check.server.ts";

describe("Fit Check Calculations: Pure Functions", () => {
  describe("averageOrderValue(orders)", () => {
    it("returns 0 for empty orders array", () => {
      assert.equal(averageOrderValue([]), 0);
    });

    it("calculates accurate AOV in integer minor units (cents)", () => {
      const orders: OrderInput[] = [
        { totalPriceMinor: 5000 }, // $50.00
        { totalPriceMinor: 7500 }, // $75.00
        { totalPriceMinor: 2500 }, // $25.00
      ];
      // (5000 + 7500 + 2500) / 3 = 15000 / 3 = 5000 cents ($50.00)
      assert.equal(averageOrderValue(orders), 5000);
    });

    it("rounds to nearest integer cent", () => {
      const orders: OrderInput[] = [
        { totalPriceMinor: 1000 },
        { totalPriceMinor: 2000 },
      ];
      // 3000 / 2 = 1500
      assert.equal(averageOrderValue(orders), 1500);

      const orders2: OrderInput[] = [
        { totalPriceMinor: 1000 },
        { totalPriceMinor: 2001 },
      ];
      // 3001 / 2 = 1500.5 -> 1501
      assert.equal(averageOrderValue(orders2), 1501);
    });

    it("filters out zero or negative order values", () => {
      const orders: OrderInput[] = [
        { totalPriceMinor: 6000 },
        { totalPriceMinor: 0 },
      ];
      assert.equal(averageOrderValue(orders), 6000);
    });
  });

  describe("grossMarginPerOrder(orders, products)", () => {
    it("returns zeros when orders array is empty", () => {
      const result = grossMarginPerOrder([]);
      assert.equal(result.averageProfitMinor, 0);
      assert.equal(result.grossMarginRatio, 0);
      assert.equal(result.ordersEvaluated, 0);
    });

    it("calculates gross margin using explicit line item costs", () => {
      const orders: OrderInput[] = [
        {
          totalPriceMinor: 10000, // $100.00
          lineItems: [
            {
              quantity: 2,
              unitPriceMinor: 5000,
              costMinor: 2000, // 2 * $20 = $40 cost
            },
          ],
        },
      ];
      const result = grossMarginPerOrder(orders);
      // Total Revenue: 10,000, Total Cost: 4,000 -> Profit: 6,000 ($60.00)
      assert.equal(result.totalRevenueMinor, 10000);
      assert.equal(result.totalCostMinor, 4000);
      assert.equal(result.totalProfitMinor, 6000);
      assert.equal(result.averageProfitMinor, 6000);
      assert.equal(result.grossMarginRatio, 0.6); // 60%
    });

    it("matches line items with product catalog when line items lack explicit cost", () => {
      const products: ProductInput[] = [
        {
          id: "prod_1",
          title: "Premium Matcha",
          priceMinor: 4000,
          costMinor: 1500, // $15 cost
          variants: [
            { id: "var_1", priceMinor: 4000, costMinor: 1500 },
          ],
        },
      ];

      const orders: OrderInput[] = [
        {
          totalPriceMinor: 8000, // $80.00
          lineItems: [
            {
              variantId: "var_1",
              productId: "prod_1",
              quantity: 2,
              unitPriceMinor: 4000,
            },
          ],
        },
      ];

      const result = grossMarginPerOrder(orders, products);
      // Cost: 2 * 1500 = 3000 cents ($30.00)
      // Profit: 8000 - 3000 = 5000 cents ($50.00)
      assert.equal(result.totalCostMinor, 3000);
      assert.equal(result.totalProfitMinor, 5000);
      assert.equal(result.averageProfitMinor, 5000);
      assert.equal(result.grossMarginRatio, 0.625); // 62.5%
    });

    it("falls back gracefully when catalog costs are missing", () => {
      const orders: OrderInput[] = [{ totalPriceMinor: 5000 }];
      const result = grossMarginPerOrder(orders, []);
      // Fallback 50% margin
      assert.equal(result.totalRevenueMinor, 5000);
      assert.equal(result.totalCostMinor, 2500);
      assert.equal(result.averageProfitMinor, 2500);
      assert.equal(result.grossMarginRatio, 0.5);
    });
  });

  describe("maxAffordableCpc(profitPerOrder, assumedConversionRate)", () => {
    it("calculates accurate Max CPC in integer minor units (cents)", () => {
      // $30 profit per order * 2% conversion rate = $0.60 (60 cents)
      const cpc = maxAffordableCpc(3000, 0.02);
      assert.equal(cpc, 60);
    });

    it("handles higher margin AOV case", () => {
      // $75 profit per order * 2.5% conversion rate = $1.875 -> 188 cents ($1.88)
      const cpc = maxAffordableCpc(7500, 0.025);
      assert.equal(cpc, 188);
    });

    it("returns 0 for zero or negative profit or conversion rate", () => {
      assert.equal(maxAffordableCpc(0, 0.02), 0);
      assert.equal(maxAffordableCpc(-1000, 0.02), 0);
      assert.equal(maxAffordableCpc(5000, 0), 0);
      assert.equal(maxAffordableCpc(5000, -0.05), 0);
    });
  });

  describe("bestProductsToAdvertise(products)", () => {
    it("returns empty array for empty input", () => {
      assert.deepEqual(bestProductsToAdvertise([]), []);
    });

    it("excludes products with missing, null, or zero cost", () => {
      const products: ProductInput[] = [
        { id: "1", title: "No Cost", priceMinor: 5000, costMinor: null },
        { id: "2", title: "Zero Cost", priceMinor: 5000, costMinor: 0 },
        { id: "3", title: "Undefined Cost", priceMinor: 5000 },
        { id: "4", title: "Valid Item", priceMinor: 5000, costMinor: 2000 },
      ];
      const ranked = bestProductsToAdvertise(products);
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].id, "4");
      assert.equal(ranked[0].profitMinor, 3000); // 5000 - 2000
    });

    it("ranks products primarily by gross dollar profit descending", () => {
      const products: ProductInput[] = [
        { id: "low", title: "Low Profit", priceMinor: 2000, costMinor: 1500 }, // Profit: $5 (500c)
        { id: "high", title: "High Profit", priceMinor: 10000, costMinor: 4000 }, // Profit: $60 (6000c)
        { id: "mid", title: "Mid Profit", priceMinor: 5000, costMinor: 2000 }, // Profit: $30 (3000c)
      ];
      const ranked = bestProductsToAdvertise(products);
      assert.equal(ranked.length, 3);
      assert.equal(ranked[0].id, "high");
      assert.equal(ranked[1].id, "mid");
      assert.equal(ranked[2].id, "low");
    });
  });

  describe("monthlyMinimumSpend(campaignCount, dailyMinimum)", () => {
    it("calculates default US minimum spend: 1 campaign * $25/day * 30 days = $750", () => {
      const spend = monthlyMinimumSpend(1);
      assert.equal(spend, 75000); // $750.00 (75,000 cents)
    });

    it("scales with multiple campaigns", () => {
      // 3 campaigns * $25/day * 30 days = $2,250 (225,000 cents)
      const spend = monthlyMinimumSpend(3);
      assert.equal(spend, 225000);
    });

    it("accepts custom daily minimum override", () => {
      // 2 campaigns * $50/day (5000 cents) * 30 days = $3,000 (300,000 cents)
      const spend = monthlyMinimumSpend(2, 5000);
      assert.equal(spend, 300000);
    });

    it("handles country-specific daily minimums", () => {
      // CA daily min = 3500 cents ($35 CAD) -> 1 * 3500 * 30 = 105,000 cents
      const spend = monthlyMinimumSpend(1, undefined, "CA");
      assert.equal(spend, 105000);
    });
  });

  describe("fitScore(): Evaluation & Plain Language Reasons", () => {
    it("returns 'likely' with 2 to 4 plain reasons when unit economics are strong", () => {
      const result = fitScore({
        aovMinor: 6500, // $65 AOV (well above $40)
        averageProfitMinor: 4000, // $40 profit/order
        grossMarginRatio: 0.615, // 61.5% margin (well above 35%)
        maxAffordableCpcMinor: 80, // $0.80 max CPC (above $0.75)
        totalProducts: 10,
        productsWithCostCount: 9, // 90% cost coverage
        bestProductsCount: 5,
      });

      assert.equal(result.score, "likely");
      assert.ok(result.reasons.length >= 2 && result.reasons.length <= 4);
      assert.ok(result.reasons.some((r) => r.includes("Healthy maximum affordable CPC")));
      assert.ok(result.reasons.some((r) => r.includes("Strong unit economics")));
    });

    it("returns 'maybe' when metrics are moderate", () => {
      const result = fitScore({
        aovMinor: 3000, // $30 AOV ($25 - $40)
        averageProfitMinor: 1000, // $10 profit
        grossMarginRatio: 0.33, // 33%
        maxAffordableCpcMinor: 45, // $0.45 max CPC (between $0.40 and $0.75)
        totalProducts: 10,
        productsWithCostCount: 4, // 40%
        bestProductsCount: 2,
      });

      assert.equal(result.score, "maybe");
      assert.ok(result.reasons.length >= 2 && result.reasons.length <= 4);
    });

    it("returns 'unlikely' when margins and AOV are too thin", () => {
      const result = fitScore({
        aovMinor: 1500, // $15 AOV (below $25)
        averageProfitMinor: 300, // $3 profit
        grossMarginRatio: 0.15, // 15% margin (below 20%)
        maxAffordableCpcMinor: 15, // $0.15 max CPC (below $0.40)
        totalProducts: 5,
        productsWithCostCount: 1,
        bestProductsCount: 0,
      });

      assert.equal(result.score, "unlikely");
      assert.ok(result.reasons.length >= 2 && result.reasons.length <= 4);
      assert.ok(result.reasons.some((r) => r.includes("Tight maximum affordable CPC")));
    });

    it("allows tuning thresholds via config object", () => {
      const customConfig = {
        ...DEFAULT_FIT_CHECK_CONFIG,
        thresholds: {
          ...DEFAULT_FIT_CHECK_CONFIG.thresholds,
          maxCpcLikelyMinor: 30, // Lower threshold to $0.30
          aovLikelyMinor: 2000,
          marginLikelyRatio: 0.15,
        },
      };

      const result = fitScore(
        {
          aovMinor: 2500,
          averageProfitMinor: 1500,
          grossMarginRatio: 0.25,
          maxAffordableCpcMinor: 35,
          totalProducts: 10,
          productsWithCostCount: 8,
          bestProductsCount: 4,
        },
        customConfig
      );

      assert.equal(result.score, "likely");
    });
  });
});
