import { describe, it } from "node:test";
import assert from "node:assert";
import { orderProfit, calculateAdProfit } from "./profit-engine.server.ts";
import { DEFAULT_PROFIT_SETTINGS, type ProfitOrderInput } from "./types.ts";
import { convertCurrency } from "../fx.server.ts";
import { roundHalfAwayFromZero, calcPaymentFee } from "./money.server.ts";

describe("Cartlight Profit Engine (Step c Verification)", () => {
  // Test 1: Standard Order (100% Real Costs, Customer Shipping = $0)
  it("Test 1: Standard Order (100% Real Costs, Customer Shipping = $0)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-1",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000, // $100.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500, // $5.00 actual shipping
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 10000, // $100.00
          snapshotUnitCostMinor: 4000, // $40.00 real cost
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Payment fee: round(10,000 * 290 / 10,000) + 30 = 290 + 30 = 320¢
    // Expected Profit: 10,000 - 4,000 - 500 - 320 = 5,180¢ ($51.80)
    assert.strictEqual(res.paymentFeeMinor, 320);
    assert.strictEqual(res.cogsMinor, 4000);
    assert.strictEqual(res.shippingExpenseMinor, 500);
    assert.strictEqual(res.saleEventProfitMinor, 5180);
    assert.strictEqual(res.lifetimeProfitMinor, 5180);
    assert.strictEqual(res.isEstimated, false);
  });

  // Test 2: Order with Sales Tax Excluded from Revenue, Included in Fee
  it("Test 2: Order with Sales Tax Excluded from Revenue, Included in Fee", () => {
    const order: ProfitOrderInput = {
      orderId: "order-2",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 11000, // $110.00 charged ($100 items + $10 sales tax)
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 10000, // $100.00 net revenue (tax excluded)
          snapshotUnitCostMinor: 4000,
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Payment fee on $110: round(11,000 * 290 / 10,000) + 30 = 319 + 30 = 349¢
    // Expected Profit: 10,000 - 4,000 - 500 - 349 = 5,151¢ ($51.51)
    assert.strictEqual(res.netRevenueMinor, 10000);
    assert.strictEqual(res.paymentFeeMinor, 349);
    assert.strictEqual(res.saleEventProfitMinor, 5151);
    assert.strictEqual(res.lifetimeProfitMinor, 5151);
  });

  // Test 3: Missing Product Cost (Fallback to 40% Default Margin)
  it("Test 3: Missing Product Cost (Fallback to 40% Default Margin)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-3",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 8000, // $80.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-missing",
          quantity: 1,
          priceMinor: 8000, // $80.00
          snapshotUnitCostMinor: null, // missing cost
          costSource: "ESTIMATED",
        },
      ],
    };

    const res = orderProfit(order);

    // Payment fee: round(8,000 * 290 / 10,000) + 30 = 232 + 30 = 262¢
    // 40% default margin => 60% cost ratio => 8,000 * 0.60 = 4,800¢
    // Expected Profit: 8,000 - 4,800 - 500 - 262 = 2,438¢ ($24.38)
    assert.strictEqual(res.paymentFeeMinor, 262);
    assert.strictEqual(res.cogsMinor, 4800);
    assert.strictEqual(res.saleEventProfitMinor, 2438);
    assert.strictEqual(res.isEstimated, true);
    assert.ok(res.estimationReasons.includes("DEFAULT_PRODUCT_MARGIN_USED"));
  });

  // Test 4: Mixed Real and Missing Product Costs
  it("Test 4: Mixed Real and Missing Product Costs", () => {
    const order: ProfitOrderInput = {
      orderId: "order-4",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000, // $100.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-real",
          quantity: 1,
          priceMinor: 5000, // $50.00
          snapshotUnitCostMinor: 2000, // $20.00 real cost
          costSource: "REAL",
        },
        {
          productId: "prod-estimated",
          quantity: 1,
          priceMinor: 5000, // $50.00
          snapshotUnitCostMinor: null, // missing cost => 60% of 5,000 = 3,000¢
          costSource: "ESTIMATED",
        },
      ],
    };

    const res = orderProfit(order);

    // Item A COGS: 2,000¢ (real). Item B COGS: 3,000¢ (estimated). Total COGS: 5,000¢
    // Payment fee: 320¢. Shipping: 500¢
    // Expected Profit: 10,000 - 5,000 - 500 - 320 = 4,180¢ ($41.80)
    assert.strictEqual(res.realCogsMinor, 2000);
    assert.strictEqual(res.estimatedCogsMinor, 3000);
    assert.strictEqual(res.cogsMinor, 5000);
    assert.strictEqual(res.saleEventProfitMinor, 4180);
    assert.strictEqual(res.isEstimated, true);
  });

  // Test 5: Zero Product Cost (100% Margin Digital Item)
  it("Test 5: Zero Product Cost (100% Margin Digital Item)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-5",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 3000, // $30.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 0, // digital good has $0 shipping
      lineItems: [
        {
          productId: "prod-digital",
          quantity: 1,
          priceMinor: 3000,
          snapshotUnitCostMinor: 0, // $0 cost
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Payment fee: round(3,000 * 290 / 10,000) + 30 = 87 + 30 = 117¢
    // Expected Profit: 3,000 - 0 - 0 - 117 = 2,883¢ ($28.83)
    assert.strictEqual(res.cogsMinor, 0);
    assert.strictEqual(res.shippingExpenseMinor, 0);
    assert.strictEqual(res.paymentFeeMinor, 117);
    assert.strictEqual(res.saleEventProfitMinor, 2883);
  });

  // Test 6: 100% Discounted Promo Order ($0 Total Charged = $0 Fee)
  it("Test 6: 100% Discounted Promo Order ($0 Total Charged = $0 Fee)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-6",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 0, // $0 charged
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-promo",
          quantity: 1,
          priceMinor: 0, // 100% discount
          snapshotUnitCostMinor: 1500, // $15.00 cost
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Total charged is 0 => payment fee strictly 0¢ (no percentage, no fixed fee)
    // Expected Profit: 0 - 1,500 - 500 - 0 = -2,000¢ (-$20.00)
    assert.strictEqual(res.paymentFeeMinor, 0);
    assert.strictEqual(res.saleEventProfitMinor, -2000);
  });

  // Test 7: $0-Revenue Overhead Allocation (Even Split + Remainder to First Item)
  it("Test 7: $0-Revenue Overhead Allocation (Even Split + Remainder to First Item)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-7",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 0,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500, // $5.00 overhead
      lineItems: [
        {
          productId: "prod-free-1",
          quantity: 1,
          priceMinor: 0,
          snapshotUnitCostMinor: 1000,
          costSource: "REAL",
        },
        {
          productId: "prod-free-2",
          quantity: 1,
          priceMinor: 0,
          snapshotUnitCostMinor: 1000,
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Total overhead = 500¢, split evenly across 2 items = 250¢ each
    assert.strictEqual(res.lineItemProfits.length, 2);
    assert.strictEqual(res.lineItemProfits[0].allocatedNetOverheadMinor, 250);
    assert.strictEqual(res.lineItemProfits[1].allocatedNetOverheadMinor, 250);
    const sumItemProfits = res.lineItemProfits.reduce((acc, li) => acc + li.profitMinor, 0);
    assert.strictEqual(sumItemProfits, res.saleEventProfitMinor);
  });

  // Test 8: Partial Refund on Order Date (With Restocked Inventory)
  it("Test 8: Partial Refund on Order Date (With Restocked Inventory)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-8",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000, // $100.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 2,
          priceMinor: 10000,
          snapshotUnitCostMinor: 2000, // 2 x 2,000 = 4,000¢ COGS
          costSource: "REAL",
        },
      ],
      refunds: [
        {
          refundId: "ref-1",
          refundDate: "2026-03-01T14:00:00Z",
          refundAmountMinor: 5000, // 1 item refunded ($50.00)
          restockedItems: [
            {
              productId: "prod-1",
              quantity: 1,
              snapshotUnitCostMinor: 2000, // 2,000¢ COGS credited back
            },
          ],
        },
      ],
    };

    const res = orderProfit(order);

    // Initial sale profit: 10,000 - 4,000 - 500 - 320 = 5,180¢
    // Net refund deduction: 5,000 - 2,000 = 3,000¢ (refund impact = -3,000¢)
    // Expected Lifetime Profit: 5,180 - 3,000 = 2,180¢ ($21.80)
    assert.strictEqual(res.saleEventProfitMinor, 5180);
    assert.strictEqual(res.refundImpactMinor, -3000);
    assert.strictEqual(res.lifetimeProfitMinor, 2180);
  });

  // Test 9: Full Refund with Payment Fees Retained (feesRefundedOnRefund: false)
  it("Test 9: Full Refund with Payment Fees Retained (feesRefundedOnRefund: false)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-9",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 10000,
          snapshotUnitCostMinor: 4000,
          costSource: "REAL",
        },
      ],
      refunds: [
        {
          refundId: "ref-full",
          refundDate: "2026-03-01T15:00:00Z",
          refundAmountMinor: 10000,
          restockedItems: [
            {
              productId: "prod-1",
              quantity: 1,
              snapshotUnitCostMinor: 4000,
            },
          ],
        },
      ],
    };

    const res = orderProfit(order, {}, { ...DEFAULT_PROFIT_SETTINGS, feesRefundedOnRefund: false });

    // Initial sale profit: 5,180¢
    // Net refund deduction: 10,000 - 4,000 - 0 = 6,000¢ (refund impact = -6,000¢)
    // Expected Lifetime Profit: 5,180 - 6,000 = -820¢ (-$8.20)
    // Exactly represents merchant losing the unrefunded 320¢ payment fee + 500¢ shipping expense
    assert.strictEqual(res.saleEventProfitMinor, 5180);
    assert.strictEqual(res.refundImpactMinor, -6000);
    assert.strictEqual(res.lifetimeProfitMinor, -820);
  });

  // Test 10: Event-Based Reporting Across Period Boundary (Month 1 vs Month 2)
  it("Test 10: Event-Based Reporting Across Period Boundary (Month 1 vs Month 2)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-cross-period",
      orderDate: "2026-01-15T12:00:00Z", // Month 1 (January)
      totalChargedMinor: 10000,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 10000,
          snapshotUnitCostMinor: 4000,
          costSource: "REAL",
        },
      ],
      refunds: [
        {
          refundId: "ref-m2",
          refundDate: "2026-02-10T14:00:00Z", // Month 2 (February)
          refundAmountMinor: 10000,
          restockedItems: [
            {
              productId: "prod-1",
              quantity: 1,
              snapshotUnitCostMinor: 4000,
            },
          ],
        },
      ],
    };

    // Month 1 aggregation (Jan 1 - Jan 31): order created, no refunds yet
    const month1Report = calculateAdProfit({
      key: "campaign-1",
      level: "CAMPAIGN",
      orders: [order],
      adSpendMinor: 0,
      adSpendCurrency: "USD",
      shopCurrency: "USD",
      dateRange: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-31T23:59:59Z",
      },
    });

    // Month 2 aggregation (Feb 1 - Feb 28): refund event occurred, no new orders
    const month2Report = calculateAdProfit({
      key: "campaign-1",
      level: "CAMPAIGN",
      orders: [order],
      adSpendMinor: 0,
      adSpendCurrency: "USD",
      shopCurrency: "USD",
      dateRange: {
        start: "2026-02-01T00:00:00Z",
        end: "2026-02-28T23:59:59Z",
      },
    });

    // Month 1 Campaign Profit remains unchanged at +5,180¢
    assert.strictEqual(month1Report.attributedOrderProfitMinor, 5180);
    assert.strictEqual(month1Report.attributedOrdersCount, 1);

    // Month 2 Campaign Profit captures the refund impact of -6,000¢
    assert.strictEqual(month2Report.attributedOrderProfitMinor, -6000);
    assert.strictEqual(month2Report.attributedOrdersCount, 0);
  });

  // Test 11: Snapshot Unit Cost Protection (Catalog Cost Changes After Sale)
  it("Test 11: Snapshot Unit Cost Protection (Catalog Cost Changes After Sale)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-snapshot",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-cost-change",
          quantity: 2,
          priceMinor: 10000,
          snapshotUnitCostMinor: 2000, // permanently stamped snapshot: $20.00
          costSource: "REAL",
        },
      ],
      refunds: [
        {
          refundId: "ref-snap",
          refundDate: "2026-03-02T12:00:00Z",
          refundAmountMinor: 5000,
          restockedItems: [
            {
              productId: "prod-cost-change",
              quantity: 1,
              snapshotUnitCostMinor: 2000, // snapshot restock credit
            },
          ],
        },
      ],
    };

    // Later catalog price in Shopify increased to $35.00 (3,500¢)
    const catalogCosts = {
      "prod-cost-change": 3500,
    };

    const res = orderProfit(order, catalogCosts);

    // Must use snapshot unit cost 2,000¢, NOT the catalog 3,500¢
    assert.strictEqual(res.cogsMinor, 4000); // 2 x 2,000
    assert.strictEqual(res.refundImpactMinor, -3000); // -(5,000 - 2,000)
    assert.strictEqual(res.lifetimeProfitMinor, 2180);
  });

  // Test 12: Mixed Basket Attribution Allocation ($0 Customer Shipping)
  it("Test 12: Mixed Basket Attribution Allocation ($0 Customer Shipping)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-12",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-a",
          quantity: 1,
          priceMinor: 6000, // $60.00 (60% share)
          snapshotUnitCostMinor: 2400, // $24.00 cost
          costSource: "REAL",
          isAttributed: true,
        },
        {
          productId: "prod-b",
          quantity: 1,
          priceMinor: 4000, // $40.00 (40% share)
          snapshotUnitCostMinor: 1600, // $16.00 cost
          costSource: "REAL",
          isAttributed: false,
        },
      ],
    };

    const res = orderProfit(order);

    // Total overhead = 500 + 320 = 820¢
    // Item A overhead: round(820 * 6,000 / 10,000) = 492¢ => Profit: 6,000 - 2,400 - 492 = 3,108¢
    // Item B overhead: 820 - 492 = 328¢ => Profit: 4,000 - 1,600 - 328 = 2,072¢
    // Exact sum check: 3,108 + 2,072 = 5,180¢
    assert.strictEqual(res.lineItemProfits[0].allocatedNetOverheadMinor, 492);
    assert.strictEqual(res.lineItemProfits[0].profitMinor, 3108);

    assert.strictEqual(res.lineItemProfits[1].allocatedNetOverheadMinor, 328);
    assert.strictEqual(res.lineItemProfits[1].profitMinor, 2072);

    const sumProfits = res.lineItemProfits[0].profitMinor + res.lineItemProfits[1].profitMinor;
    assert.strictEqual(sumProfits, 5180);
    assert.strictEqual(sumProfits, res.saleEventProfitMinor);
  });

  // Extra Test: Mixed Basket Allocation with $5.00 Customer Shipping
  it("Extra Test: Mixed Basket Allocation with $5.00 Customer Shipping (Net Overhead 320¢)", () => {
    const order: ProfitOrderInput = {
      orderId: "order-12-shipping",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 10000, // $100.00 charged for fee calc
      shippingChargedToCustomerMinor: 500, // $5.00 customer paid shipping
      shippingCostExpenseMinor: 500, // $5.00 actual carrier shipping expense
      lineItems: [
        {
          productId: "prod-a",
          quantity: 1,
          priceMinor: 6000, // $60.00 (60% share)
          snapshotUnitCostMinor: 2400,
          costSource: "REAL",
        },
        {
          productId: "prod-b",
          quantity: 1,
          priceMinor: 4000, // $40.00 (40% share)
          snapshotUnitCostMinor: 1600,
          costSource: "REAL",
        },
      ],
    };

    const res = orderProfit(order);

    // Net overhead = shipping expense (500) + payment fee (320) - shipping charged (500) = 320¢
    // Order Profit: Net Revenue (10,500) - COGS (4,000) - Shipping (500) - Fee (320) = 5,680¢
    // Item A overhead: round(320 * 6,000 / 10,000) = 192¢ => Profit: 6,000 - 2,400 - 192 = 3,408¢
    // Item B overhead: 320 - 192 = 128¢ => Profit: 4,000 - 1,600 - 128 = 2,272¢
    // Item profits sum: 3,408 + 2,272 = 5,680¢ exactly
    assert.strictEqual(res.saleEventProfitMinor, 5680);
    assert.strictEqual(res.lineItemProfits[0].allocatedNetOverheadMinor, 192);
    assert.strictEqual(res.lineItemProfits[0].profitMinor, 3408);

    assert.strictEqual(res.lineItemProfits[1].allocatedNetOverheadMinor, 128);
    assert.strictEqual(res.lineItemProfits[1].profitMinor, 2272);

    const sumProfits = res.lineItemProfits[0].profitMinor + res.lineItemProfits[1].profitMinor;
    assert.strictEqual(sumProfits, 5680);
    assert.strictEqual(sumProfits, res.saleEventProfitMinor);
  });

  // Extra Test: Proportional Payment Fee Recovery when feesRefundedOnRefund = true
  it("Extra Test: Proportional Payment Fee Recovery when feesRefundedOnRefund = true", () => {
    const order: ProfitOrderInput = {
      orderId: "order-fee-refund",
      orderDate: "2026-03-01T12:00:00Z",
      totalChargedMinor: 11000, // $110.00 charged ($100 items + $10 tax) -> fee = 349¢
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 500,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 10000,
          snapshotUnitCostMinor: 4000,
          costSource: "REAL",
        },
      ],
      refunds: [
        {
          refundId: "ref-partial-fee",
          refundDate: "2026-03-01T16:00:00Z",
          refundAmountMinor: 5000, // $50 net items refunded
          refundTotalChargedMinor: 5500, // $55 total charged refunded (50% of 11,000)
          restockedItems: [
            {
              productId: "prod-1",
              quantity: 1,
              snapshotUnitCostMinor: 2000,
            },
          ],
        },
      ],
    };

    const res = orderProfit(order, {}, { ...DEFAULT_PROFIT_SETTINGS, feesRefundedOnRefund: true });

    // Initial sale profit: 10,000 - 4,000 - 500 - 349 = 5,151¢
    // Proportional fee refunded: roundHalfAwayFromZero(349 * 5,500, 11,000) = round(174.5) = 175¢
    // Net refund deduction: 5,000 (net refund) - 2,000 (restock) - 175 (fee refund) = 2,825¢
    // Refund impact = -2,825¢
    // Expected Lifetime Profit: 5,151 - 2,825 = 2,326¢
    assert.strictEqual(res.saleEventProfitMinor, 5151);
    assert.strictEqual(res.refundImpactMinor, -2825);
    assert.strictEqual(res.lifetimeProfitMinor, 2326);
  });

  // Test 13: Ad Profit: Campaign-Level Profitable Day
  it("Test 13: Ad Profit: Campaign-Level Profitable Day", () => {
    const orderA: ProfitOrderInput = {
      orderId: "order-a",
      orderDate: "2026-03-01T10:00:00Z",
      totalChargedMinor: 120000, // $1,200.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 0,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 120000,
          snapshotUnitCostMinor: 0,
          costSource: "REAL",
        },
      ],
    };

    // Setting payment fee to 0 to isolate pure profit calculation
    const settings = {
      ...DEFAULT_PROFIT_SETTINGS,
      paymentFeeBps: 0,
      paymentFeeFixedMinor: 0,
      shippingCostPerOrderMinor: 0,
    };

    const res = calculateAdProfit({
      key: "camp-profitable",
      level: "CAMPAIGN",
      orders: [orderA],
      adSpendMinor: 40000, // $400.00 ad spend
      adSpendCurrency: "USD",
      shopCurrency: "USD",
      settings,
    });

    // Net Ad Profit: 120,000 - 40,000 = 80,000¢ ($800.00)
    assert.strictEqual(res.attributedOrderProfitMinor, 120000);
    assert.strictEqual(res.adSpendMinor, 40000);
    assert.strictEqual(res.netAdProfitMinor, 80000);
    assert.strictEqual(res.roas, 3); // 120,000 / 40,000 = 3.0
  });

  // Test 14: Ad Profit: Unprofitable Campaign (Loss)
  it("Test 14: Ad Profit: Unprofitable Campaign (Loss)", () => {
    const orderLoss: ProfitOrderInput = {
      orderId: "order-loss",
      orderDate: "2026-03-01T10:00:00Z",
      totalChargedMinor: 30000, // $300.00
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 0,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 30000,
          snapshotUnitCostMinor: 0,
          costSource: "REAL",
        },
      ],
    };

    const settings = {
      ...DEFAULT_PROFIT_SETTINGS,
      paymentFeeBps: 0,
      paymentFeeFixedMinor: 0,
      shippingCostPerOrderMinor: 0,
    };

    const res = calculateAdProfit({
      key: "camp-loss",
      level: "CAMPAIGN",
      orders: [orderLoss],
      adSpendMinor: 70000, // $700.00 ad spend
      adSpendCurrency: "USD",
      shopCurrency: "USD",
      settings,
    });

    // Net Ad Profit: 30,000 - 70,000 = -40,000¢ (-$400.00)
    assert.strictEqual(res.netAdProfitMinor, -40000);
    assert.strictEqual(res.roas, 0.43);
  });

  // Test 15: Division-by-Zero Safety: ROAS and CPA Null Handling
  it("Test 15: Division-by-Zero Safety: ROAS and CPA Null Handling", () => {
    const order: ProfitOrderInput = {
      orderId: "order-zero",
      orderDate: "2026-03-01T10:00:00Z",
      totalChargedMinor: 50000,
      shippingChargedToCustomerMinor: 0,
      shippingCostExpenseMinor: 0,
      lineItems: [
        {
          productId: "prod-1",
          quantity: 1,
          priceMinor: 50000,
          snapshotUnitCostMinor: 0,
          costSource: "REAL",
        },
      ],
    };

    // Case A: Ad spend is $0 => roas: null
    const resA = calculateAdProfit({
      key: "camp-zero-spend",
      level: "CAMPAIGN",
      orders: [order],
      adSpendMinor: 0,
      adSpendCurrency: "USD",
      shopCurrency: "USD",
    });
    assert.strictEqual(resA.roas, null);

    // Case B: Attributed orders is 0 => cpaMinor: null
    const resB = calculateAdProfit({
      key: "camp-zero-orders",
      level: "CAMPAIGN",
      orders: [],
      adSpendMinor: 20000,
      adSpendCurrency: "USD",
      shopCurrency: "USD",
    });
    assert.strictEqual(resB.cpaMinor, null);
    assert.strictEqual(resB.netAdProfitMinor, -20000);
  });

  // Test 16: FX Currency Conversion: EUR to USD
  it("Test 16: FX Currency Conversion: EUR to USD", () => {
    const res = convertCurrency({
      amountMinor: 10000, // €100.00
      fromCurrency: "EUR",
      toCurrency: "USD",
      rates: {
        USD: "1.085000",
      },
    });

    // 10,000 * 1.085000 = 10,850 USD cents ($108.50)
    assert.strictEqual(res.convertedMinor, 10850);
    assert.strictEqual(res.isConverted, true);
  });

  // Test 17: FX Currency Conversion: JPY to USD (Cross-Rate Path)
  it("Test 17: FX Currency Conversion: JPY to USD (Cross-Rate Path)", () => {
    const res = convertCurrency({
      amountMinor: 15545, // ¥15,545 JPY (exponent 0)
      fromCurrency: "JPY",
      toCurrency: "USD",
      rates: {
        USD: "1.085000",
        JPY: "168.650000",
      },
    });

    // 15,545 * (1.085000 / 168.650000) * 10^2 = 10,000.785... => 10,001 USD cents ($100.01)
    assert.strictEqual(res.convertedMinor, 10001);
    assert.strictEqual(res.isConverted, true);
  });

  // Test 18: BigInt Round Half Away From Zero Float Trap Test
  it("Test 18: BigInt Round Half Away From Zero Float Trap Test", () => {
    // Exact .5 boundary: 10005 / 10 = 1000.5 => 1001
    const positive = roundHalfAwayFromZero(10005n, 10n);
    assert.strictEqual(positive, 1001n);

    // Negative exact .5 boundary: -10005 / 10 = -1000.5 => -1001
    const negative = roundHalfAwayFromZero(-10005n, 10n);
    assert.strictEqual(negative, -1001n);

    // IEEE 754 float trap on fee: 3000 * 0.0045 = 13.499999999999998 in JS float (rounds to 13)
    // BigInt arithmetic: 3000 * 45 / 10000 = 135000 / 10000 = 13.5 => rounds to 14
    const feeTrap = calcPaymentFee(3000, 45, 0);
    assert.strictEqual(feeTrap, 14);
  });

  // Test 19: FX Unsupported Currency Graceful Fallback
  it("Test 19: FX Unsupported Currency Graceful Fallback", () => {
    const res = convertCurrency({
      amountMinor: 50000,
      fromCurrency: "XYZ",
      toCurrency: "USD",
      rates: {
        USD: "1.085000",
      },
    });

    assert.strictEqual(res.convertedMinor, 50000);
    assert.strictEqual(res.isConverted, false);
    assert.strictEqual(res.reason, "UNSUPPORTED_CURRENCY");
  });
});
