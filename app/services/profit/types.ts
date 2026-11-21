/**
 * Core types and settings for the Cartlight Profit Engine.
 * All financial amounts are integer minor units (cents).
 * Percentages are integer basis points (1% = 100 bps).
 */

export interface ProfitSettings {
  /**
   * Default gross profit margin in basis points (e.g., 4000 = 40.00%)
   * Used as fallback when product cost of goods is missing.
   */
  defaultMarginBps: number;

  /**
   * Default fulfillment shipping cost per order in minor units (e.g., 500 = $5.00)
   * Used when actual carrier shipping cost is not tracked on the order.
   */
  shippingCostPerOrderMinor: number;

  /**
   * Payment processing fee percentage in basis points (e.g., 290 = 2.90%)
   */
  paymentFeeBps: number;

  /**
   * Fixed fee per transaction in minor units (e.g., 30 = $0.30)
   */
  paymentFeeFixedMinor: number;

  /**
   * Whether payment processors refund payment fees on refunds.
   * Standard processors (Shopify Payments, Stripe) do NOT refund processing fees (default: false).
   */
  feesRefundedOnRefund: boolean;
}

export const DEFAULT_PROFIT_SETTINGS: Readonly<ProfitSettings> = {
  defaultMarginBps: 4000, // 40%
  shippingCostPerOrderMinor: 500, // $5.00
  paymentFeeBps: 290, // 2.9%
  paymentFeeFixedMinor: 30, // 30¢
  feesRefundedOnRefund: false,
};

export interface OrderLineItemSnapshot {
  id?: string;
  productId: string;
  variantId?: string | null;
  title?: string;
  quantity: number;
  /**
   * Net item price after line-level and order-level discount allocations,
   * strictly excluding sales tax/VAT and tips (in shopMoney minor units).
   */
  priceMinor: number;
  /**
   * Snapshot unit cost permanently stamped at ingestion time.
   */
  snapshotUnitCostMinor?: number | null;
  costSource: "REAL" | "ESTIMATED";
  /**
   * Whether this item was specifically targeted/attributed in the ad campaign.
   */
  isAttributed?: boolean;
}

export interface RestockedItem {
  variantId?: string | null;
  productId?: string | null;
  quantity: number;
  snapshotUnitCostMinor: number;
}

export interface OrderRefundItem {
  refundId: string;
  refundDate: string | Date;
  /**
   * Amount refunded to customer in shopMoney, strictly excluding refunded tax.
   */
  refundAmountMinor: number;
  /**
   * Total charged refunded to customer INCLUDING refunded tax and tips.
   * Used for proportional payment fee recovery when feesRefundedOnRefund is true.
   */
  refundTotalChargedMinor?: number;
  /**
   * Restocked items whose inventory cost is credited back on the refund date.
   */
  restockedItems?: RestockedItem[];
}

export interface ProfitOrderInput {
  orderId: string;
  orderDate: string | Date;
  /**
   * Total amount processed at checkout including taxes and tips.
   * Used for payment fee calculation.
   */
  totalChargedMinor: number;
  /**
   * Shipping fee charged to the customer (shipping revenue).
   */
  shippingChargedToCustomerMinor?: number;
  /**
   * Actual carrier fulfillment cost incurred by merchant (expense).
   * If null/undefined, uses settings.shippingCostPerOrderMinor.
   */
  shippingCostExpenseMinor?: number | null;
  lineItems: OrderLineItemSnapshot[];
  refunds?: OrderRefundItem[];
  attribution?: {
    campaignId?: string | null;
    adGroupId?: string | null;
    adId?: string | null;
    clickId?: string | null;
  } | null;
}

export interface LineItemProfitResult {
  productId: string;
  variantId?: string | null;
  quantity: number;
  revenueMinor: number;
  cogsMinor: number;
  allocatedNetOverheadMinor: number;
  profitMinor: number;
  costSource: "REAL" | "ESTIMATED";
  isAttributed: boolean;
}

export interface OrderRefundImpact {
  refundId: string;
  refundDate: string;
  refundAmountMinor: number;
  restockedCreditMinor: number;
  refundedFeeMinor: number;
  netImpactMinor: number;
}

export interface OrderProfitResult {
  orderId: string;
  orderDate: string;
  netRevenueMinor: number;
  cogsMinor: number;
  realCogsMinor: number;
  estimatedCogsMinor: number;
  shippingExpenseMinor: number;
  paymentFeeMinor: number;
  saleEventProfitMinor: number;
  refundImpactMinor: number;
  lifetimeProfitMinor: number;
  isEstimated: boolean;
  estimationReasons: string[];
  lineItemProfits: LineItemProfitResult[];
  refundImpacts?: OrderRefundImpact[];
}

export interface AdProfitAggregate {
  key: string; // date, campaignId, or productId
  attributedRevenueMinor: number;
  attributedOrderProfitMinor: number;
  adSpendMinor: number; // In base shop currency
  netAdProfitMinor: number;
  roas: number | null; // null if adSpendMinor == 0
  cpaMinor: number | null; // null if attributedOrdersCount == 0
  attributedOrdersCount: number;
  isEstimated: boolean;
  estimationReasons: string[];
  currencyNote?: string;
}

export type OrderAttributionStatus =
  | "MATCHED_CLICK"
  | "NOT_ATTRIBUTED"
  | "REPORTED_UNMATCHED";

export interface AttributedOrderRecord {
  orderId: string;
  orderDate: string;
  status: OrderAttributionStatus;
  clickId: string | null;
  eventId: string | null;
  campaignId: string | null;
  sentConversionValueMinor: number; // Gross totalCharged sent to Pixel/CAPI
  netRevenueMinor: number;          // Net revenue excluding tax
  saleProfitMinor: number;          // Calculated order profit
  isEstimated: boolean;
  refunds?: Array<{
    refundId: string;
    refundDate: string;
    refundImpactMinor: number;
    inheritedStatus: OrderAttributionStatus;
  }>;
}

export interface CampaignReportedInput {
  campaignId: string;
  campaignName?: string;
  reportedConversions: number;
  reportedConversionValueMinor: number;
  spendMinor: number;
}

export interface CampaignProfitReconciled {
  campaignId: string;
  campaignName: string;
  reportedConversions: number;
  reportedConversionValueMinor: number;
  spendMinor: number;
  allocatedProfitBeforeSpendMinor: number;
  netAdProfitMinor: number;
  roasBps: number | null;
  roasFormatted: string;
  cpaMinor: number | null;
  isEstimated: boolean;
}

export interface StoreAttributionResult {
  matchedOrdersCount: number;
  matchedOrdersSentValueMinor: number;
  matchedOrdersNetRevenueMinor: number;
  matchedProfitMinor: number;

  openAiReportedConversions: number;
  openAiReportedConversionValueMinor: number;
  totalSpendMinor: number;

  unmatchedReportedValueMinor: number;
  sentToNetRatioBps: number;
  unmatchedNetRevenueMinor: number;
  storeMarginBps: number;
  unmatchedEstimatedProfitMinor: number;
  isEstimated: boolean;

  storeAttributedProfitBeforeSpendMinor: number;
  storeAttributedProfitAfterSpendMinor: number;

  roasBps: number | null;
  roasFormatted: string;
  cpaMinor: number | null;

  campaigns: CampaignProfitReconciled[];
  summaryText: string;
}
