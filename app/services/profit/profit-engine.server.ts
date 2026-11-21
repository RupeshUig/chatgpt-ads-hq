import {
  calcBasisPoints,
  calcPaymentFee,
  allocateProportional,
  roundHalfAwayFromZero,
} from "./money.server.ts";
import { convertCurrency } from "../fx.server.ts";
import {
  DEFAULT_PROFIT_SETTINGS,
  type ProfitSettings,
  type ProfitOrderInput,
  type OrderProfitResult,
  type LineItemProfitResult,
  type OrderRefundImpact,
  type AdProfitAggregate,
} from "./types.ts";

function isDateInRange(
  dateStrOrObj: string | Date,
  range?: { start: string | Date; end: string | Date }
): boolean {
  if (!range) return true;
  const d = new Date(dateStrOrObj).getTime();
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();
  return d >= start && d <= end;
}

/**
 * 1. Calculates net profit for a single order and its line items.
 *
 * Revenue definition:
 * Net Revenue = Line item prices after discounts + Shipping charged to customer.
 * Strictly excludes all taxes (sales tax/VAT), tips, and gift cards.
 *
 * Expense definition:
 * Expenses = COGS + Fulfillment Shipping Expense + Payment Processing Fee.
 *
 * Mixed-Basket Allocation:
 * Allocates NET Overhead = (Shipping Expense + Payment Fee - Shipping Charged to Customer)
 * across line items by revenue share (or evenly if revenue = 0).
 * Guarantees that the sum of line item profits equals the sale event profit to the exact cent.
 */
export function orderProfit(
  order: ProfitOrderInput,
  productCosts: Record<string, number> = {},
  settings: ProfitSettings = DEFAULT_PROFIT_SETTINGS
): OrderProfitResult {
  const estimationReasons: string[] = [];
  let isEstimated = false;

  // 1. Resolve product costs (COGS) using order line snapshots or catalog fallback
  let totalCogsMinor = 0;
  let realCogsMinor = 0;
  let estimatedCogsMinor = 0;

  const resolvedLineItems = order.lineItems.map((item) => {
    let unitCost: number | null = null;
    let source: "REAL" | "ESTIMATED" = item.costSource;

    if (typeof item.snapshotUnitCostMinor === "number" && item.snapshotUnitCostMinor >= 0) {
      unitCost = item.snapshotUnitCostMinor;
    } else if (item.variantId && typeof productCosts[item.variantId] === "number") {
      unitCost = productCosts[item.variantId];
      source = "REAL";
    } else if (item.productId && typeof productCosts[item.productId] === "number") {
      unitCost = productCosts[item.productId];
      source = "REAL";
    } else {
      // Missing cost fallback: use default margin
      const marginBps = Math.max(0, Math.min(10000, settings.defaultMarginBps));
      const costRatioBps = 10000 - marginBps;
      const unitPrice = Math.max(0, item.priceMinor);
      unitCost = calcBasisPoints(unitPrice, costRatioBps);
      source = "ESTIMATED";
      isEstimated = true;
      if (!estimationReasons.includes("DEFAULT_PRODUCT_MARGIN_USED")) {
        estimationReasons.push("DEFAULT_PRODUCT_MARGIN_USED");
      }
    }

    const itemCogs = unitCost * item.quantity;
    totalCogsMinor += itemCogs;

    if (source === "REAL") {
      realCogsMinor += itemCogs;
    } else {
      estimatedCogsMinor += itemCogs;
    }

    return {
      ...item,
      resolvedUnitCost: unitCost,
      itemCogs,
      costSource: source,
    };
  });

  // 2. Shipping revenue & shipping fulfillment expense
  const shippingChargedToCustomer = Math.max(0, order.shippingChargedToCustomerMinor || 0);

  let shippingExpense = settings.shippingCostPerOrderMinor;
  if (
    typeof order.shippingCostExpenseMinor === "number" &&
    order.shippingCostExpenseMinor >= 0
  ) {
    shippingExpense = order.shippingCostExpenseMinor;
  } else {
    isEstimated = true;
    if (!estimationReasons.includes("DEFAULT_SHIPPING_USED")) {
      estimationReasons.push("DEFAULT_SHIPPING_USED");
    }
  }

  // 3. Payment fee calculation on total charged including tax
  const totalCharged = Math.max(0, order.totalChargedMinor || 0);
  const paymentFee = calcPaymentFee(
    totalCharged,
    settings.paymentFeeBps,
    settings.paymentFeeFixedMinor
  );

  // 4. Net revenue (item prices + shipping charged to customer)
  const itemRevenueTotal = resolvedLineItems.reduce((acc, item) => acc + item.priceMinor, 0);
  const netRevenueMinor = itemRevenueTotal + shippingChargedToCustomer;

  // 5. Initial sale event profit
  const saleEventProfitMinor = netRevenueMinor - totalCogsMinor - shippingExpense - paymentFee;

  // 6. Net refund event impact (recorded strictly on refund dates)
  let totalRefundImpactMinor = 0;
  const refundImpacts: OrderRefundImpact[] = [];

  if (Array.isArray(order.refunds) && order.refunds.length > 0) {
    for (const ref of order.refunds) {
      const refundAmount = Math.max(0, ref.refundAmountMinor || 0);

      // Restocked inventory credit
      let restockedCredit = 0;
      if (Array.isArray(ref.restockedItems)) {
        for (const r of ref.restockedItems) {
          restockedCredit += r.quantity * r.snapshotUnitCostMinor;
        }
      }

      // Refunded payment fee if setting enabled
      let refundedFee = 0;
      if (settings.feesRefundedOnRefund && totalCharged > 0 && paymentFee > 0) {
        const refundTotalCharged = ref.refundTotalChargedMinor ?? refundAmount;
        refundedFee = Number(
          roundHalfAwayFromZero(
            BigInt(paymentFee) * BigInt(refundTotalCharged),
            BigInt(totalCharged)
          )
        );
      }

      const netRefundDeduction = refundAmount - restockedCredit - refundedFee;
      const netImpactMinor = -netRefundDeduction;
      totalRefundImpactMinor += netImpactMinor;

      refundImpacts.push({
        refundId: ref.refundId,
        refundDate:
          typeof ref.refundDate === "string"
            ? ref.refundDate
            : ref.refundDate.toISOString(),
        refundAmountMinor: refundAmount,
        restockedCreditMinor: restockedCredit,
        refundedFeeMinor: refundedFee,
        netImpactMinor,
      });
    }
  }

  const lifetimeProfitMinor = saleEventProfitMinor + totalRefundImpactMinor;

  // 7. Mixed-basket line item profit allocation:
  // Allocate NET overhead = shipping expense + payment fee - shipping charged to customer
  const netOverhead = shippingExpense + paymentFee - shippingChargedToCustomer;
  const shares = resolvedLineItems.map((item) => item.priceMinor);
  const allocatedOverheads = allocateProportional(netOverhead, shares);

  const lineItemProfits: LineItemProfitResult[] = resolvedLineItems.map((item, idx) => {
    const itemOverhead = allocatedOverheads[idx] ?? 0;
    const profitMinor = item.priceMinor - item.itemCogs - itemOverhead;

    return {
      productId: item.productId,
      variantId: item.variantId || null,
      quantity: item.quantity,
      revenueMinor: item.priceMinor,
      cogsMinor: item.itemCogs,
      allocatedNetOverheadMinor: itemOverhead,
      profitMinor,
      costSource: item.costSource,
      isAttributed: Boolean(item.isAttributed),
    };
  });

  return {
    orderId: order.orderId,
    orderDate:
      typeof order.orderDate === "string"
        ? order.orderDate
        : order.orderDate.toISOString(),
    netRevenueMinor,
    cogsMinor: totalCogsMinor,
    realCogsMinor,
    estimatedCogsMinor,
    shippingExpenseMinor: shippingExpense,
    paymentFeeMinor: paymentFee,
    saleEventProfitMinor,
    refundImpactMinor: totalRefundImpactMinor,
    lifetimeProfitMinor,
    isEstimated,
    estimationReasons,
    lineItemProfits,
    refundImpacts,
  };
}

/**
 * 2. Aggregates ad profit across orders and ad spend for a date window, campaign, or product.
 *
 * Attribution rules:
 * - Campaign-level and Day-level ad profit use the WHOLE attributed order's profit
 *   (matches OpenAI's order-level conversion reporting convention).
 * - Product-level uses the mixed-basket item allocation (Item Net Profit).
 */
export function calculateAdProfit(options: {
  key: string; // date, campaignId, or productId
  level: "DAY" | "CAMPAIGN" | "PRODUCT";
  orders: ProfitOrderInput[];
  adSpendMinor: number;
  adSpendCurrency: string;
  shopCurrency: string;
  rates?: Record<string, string>; // EUR-based rates map
  productCosts?: Record<string, number>;
  settings?: ProfitSettings;
  dateRange?: { start: string | Date; end: string | Date };
}): AdProfitAggregate {
  const {
    key,
    level,
    orders,
    adSpendMinor,
    adSpendCurrency,
    shopCurrency,
    rates = {},
    productCosts = {},
    settings = DEFAULT_PROFIT_SETTINGS,
    dateRange,
  } = options;

  // 1. Convert ad spend to shop currency if different
  let convertedSpend = adSpendMinor;
  let currencyNote: string | undefined = undefined;

  if (adSpendCurrency.toUpperCase() !== shopCurrency.toUpperCase()) {
    const fxResult = convertCurrency({
      amountMinor: adSpendMinor,
      fromCurrency: adSpendCurrency,
      toCurrency: shopCurrency,
      rates,
    });
    convertedSpend = fxResult.convertedMinor;
    currencyNote = fxResult.uiNote;
  }

  // 2. Aggregate attributed revenue and order profit
  let totalAttributedRevenue = 0;
  let totalAttributedProfit = 0;
  let attributedOrdersCount = 0;
  let isEstimated = false;
  const estimationReasons: string[] = [];

  for (const order of orders) {
    const orderCalc = orderProfit(order, productCosts, settings);
    if (orderCalc.isEstimated) {
      isEstimated = true;
      for (const reason of orderCalc.estimationReasons) {
        if (!estimationReasons.includes(reason)) {
          estimationReasons.push(reason);
        }
      }
    }

    const orderInWindow = isDateInRange(orderCalc.orderDate, dateRange);

    if (level === "PRODUCT") {
      // Product level: uses mixed-basket item profit allocation
      if (orderInWindow) {
        const matchingItems = orderCalc.lineItemProfits.filter(
          (li) => li.productId === key
        );
        if (matchingItems.length > 0) {
          attributedOrdersCount++;
          for (const item of matchingItems) {
            totalAttributedRevenue += item.revenueMinor;
            totalAttributedProfit += item.profitMinor;
          }
        }
      }
    } else {
      // Day and Campaign levels:
      // (1) Sale event: if order creation date is in window, count order and add sale event revenue and profit
      if (orderInWindow) {
        attributedOrdersCount++;
        totalAttributedRevenue += orderCalc.netRevenueMinor;
        totalAttributedProfit += orderCalc.saleEventProfitMinor;
      }

      // (2) Refund events: recorded strictly on the refund date
      if (dateRange) {
        if (orderCalc.refundImpacts && orderCalc.refundImpacts.length > 0) {
          for (const ref of orderCalc.refundImpacts) {
            if (isDateInRange(ref.refundDate, dateRange)) {
              totalAttributedProfit += ref.netImpactMinor;
              totalAttributedRevenue -= ref.refundAmountMinor;
            }
          }
        }
      } else {
        // If no dateRange specified, include full lifetime refunds
        totalAttributedProfit += orderCalc.refundImpactMinor;
        if (orderCalc.refundImpacts) {
          for (const ref of orderCalc.refundImpacts) {
            totalAttributedRevenue -= ref.refundAmountMinor;
          }
        }
      }
    }
  }

  // 3. Net ad profit = Attributed Profit - Ad Spend
  const netAdProfitMinor = totalAttributedProfit - convertedSpend;

  // 4. Division by zero handling:
  // ROAS is null when ad spend is 0 (never Infinity or NaN)
  const roas =
    convertedSpend > 0
      ? Math.round((totalAttributedRevenue / convertedSpend) * 100) / 100
      : null;

  // CPA is null when attributed orders is 0 (never Infinity or NaN)
  const cpaMinor =
    attributedOrdersCount > 0
      ? Number(
          roundHalfAwayFromZero(
            BigInt(convertedSpend),
            BigInt(attributedOrdersCount)
          )
        )
      : null;

  return {
    key,
    attributedRevenueMinor: totalAttributedRevenue,
    attributedOrderProfitMinor: totalAttributedProfit,
    adSpendMinor: convertedSpend,
    netAdProfitMinor,
    roas,
    cpaMinor,
    attributedOrdersCount,
    isEstimated,
    estimationReasons,
    currencyNote,
  };
}
