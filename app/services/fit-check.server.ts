/**
 * Pure functions for eCommerce Fit Check calculations.
 * All financial amounts are represented in integer minor units (cents).
 * No database or network calls are made inside this module.
 */

export interface FitCheckConfig {
  dailyMinimumMinorByCountry: Record<string, number>;
  defaultDailyMinimumMinor: number; // in minor units (e.g., 2500 = $25.00)
  daysInMonth: number;
  assumedConversionRate: number; // e.g., 0.02 = 2.0%

  thresholds: {
    // Average Order Value thresholds (minor units)
    aovLikelyMinor: number; // 4000 = $40.00
    aovMaybeMinor: number; // 2500 = $25.00

    // Gross margin ratio thresholds (0 to 1)
    marginLikelyRatio: number; // 0.35 = 35%
    marginMaybeRatio: number; // 0.20 = 20%

    // Max affordable CPC thresholds (minor units)
    maxCpcLikelyMinor: number; // 75 = $0.75
    maxCpcMaybeMinor: number; // 40 = $0.40

    // Minimum product cost coverage ratio (0 to 1)
    costCoverageRatio: number; // 0.50 = 50% of catalog

    // Minimum high-margin products needed for likely score
    minFlagshipProducts: number; // 3
  };
}

export const DEFAULT_FIT_CHECK_CONFIG: FitCheckConfig = {
  dailyMinimumMinorByCountry: {
    US: 2500, // $25.00/day
    CA: 3500, // $35.00 CAD/day
    GB: 2000, // £20.00/day
    EU: 2500, // €25.00/day
    DEFAULT: 2500,
  },
  defaultDailyMinimumMinor: 2500,
  daysInMonth: 30,
  assumedConversionRate: 0.02, // 2% benchmark conversion rate

  thresholds: {
    aovLikelyMinor: 4000, // $40.00
    aovMaybeMinor: 2500, // $25.00
    marginLikelyRatio: 0.35, // 35%
    marginMaybeRatio: 0.20, // 20%
    maxCpcLikelyMinor: 75, // $0.75
    maxCpcMaybeMinor: 40, // $0.40
    costCoverageRatio: 0.50, // 50%
    minFlagshipProducts: 3,
  },
};

export interface OrderLineItemInput {
  variantId?: string | null;
  productId?: string | null;
  quantity: number;
  unitPriceMinor?: number | null;
  costMinor?: number | null;
}

export interface OrderInput {
  id?: string;
  totalPriceMinor: number;
  lineItems?: OrderLineItemInput[] | null;
}

export interface ProductVariantInput {
  id: string;
  priceMinor: number;
  costMinor?: number | null;
}

export interface ProductInput {
  id: string;
  title: string;
  handle?: string;
  priceMinor: number;
  costMinor?: number | null;
  vendor?: string;
  imageUrl?: string | null;
  inventoryQuantity?: number | null;
  variants?: ProductVariantInput[] | null;
}

export interface RankedProduct {
  id: string;
  title: string;
  handle?: string;
  priceMinor: number;
  costMinor: number;
  profitMinor: number;
  marginRatio: number;
  vendor?: string;
  imageUrl?: string | null;
}

export interface GrossMarginResult {
  averageProfitMinor: number;
  grossMarginRatio: number;
  totalRevenueMinor: number;
  totalCostMinor: number;
  totalProfitMinor: number;
  ordersEvaluated: number;
}

export type FitScoreLevel = "likely" | "maybe" | "unlikely";

export interface FitScoreResult {
  score: FitScoreLevel;
  reasons: string[];
  metrics: {
    aovMinor: number;
    averageProfitMinor: number;
    grossMarginRatio: number;
    maxAffordableCpcMinor: number;
    costCoverageRatio: number;
    eligibleProductCount: number;
  };
}

/**
 * 1. Calculates Average Order Value (AOV) across the provided orders in integer minor units.
 * Returns 0 if orders array is empty.
 */
export function averageOrderValue(orders: OrderInput[]): number {
  if (!orders || orders.length === 0) {
    return 0;
  }

  const validOrders = orders.filter(
    (o) => typeof o.totalPriceMinor === "number" && o.totalPriceMinor > 0
  );

  if (validOrders.length === 0) {
    return 0;
  }

  const totalRevenue = validOrders.reduce(
    (sum, o) => sum + Math.round(o.totalPriceMinor),
    0
  );

  return Math.round(totalRevenue / validOrders.length);
}

/**
 * 2. Calculates gross margin and average profit per order using orders and product costs.
 * Resolves item costs from lineItems directly or matches against the products catalog.
 */
export function grossMarginPerOrder(
  orders: OrderInput[],
  products: ProductInput[] = []
): GrossMarginResult {
  if (!orders || orders.length === 0) {
    return {
      averageProfitMinor: 0,
      grossMarginRatio: 0,
      totalRevenueMinor: 0,
      totalCostMinor: 0,
      totalProfitMinor: 0,
      ordersEvaluated: 0,
    };
  }

  // Build quick cost lookup maps from product catalog
  const variantCostMap = new Map<string, number>();
  const productCostMap = new Map<string, number>();

  for (const p of products) {
    if (typeof p.costMinor === "number" && p.costMinor >= 0) {
      productCostMap.set(p.id, p.costMinor);
    }
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (typeof v.costMinor === "number" && v.costMinor >= 0) {
          variantCostMap.set(v.id, v.costMinor);
        } else if (typeof p.costMinor === "number" && p.costMinor >= 0) {
          variantCostMap.set(v.id, p.costMinor);
        }
      }
    }
  }

  // Calculate default cost ratio from products with both cost and price
  let catalogTotalCost = 0;
  let catalogTotalPrice = 0;
  for (const p of products) {
    if (
      typeof p.costMinor === "number" &&
      p.costMinor >= 0 &&
      typeof p.priceMinor === "number" &&
      p.priceMinor > 0
    ) {
      catalogTotalCost += p.costMinor;
      catalogTotalPrice += p.priceMinor;
    }
  }
  const defaultCostRatio =
    catalogTotalPrice > 0 ? catalogTotalCost / catalogTotalPrice : 0.5; // fallback to 50% default cost if catalog has no costs

  let totalRevenue = 0;
  let totalCost = 0;
  let evaluatedOrders = 0;

  for (const order of orders) {
    const orderRevenue = Math.max(0, Math.round(order.totalPriceMinor || 0));
    totalRevenue += orderRevenue;
    evaluatedOrders += 1;

    let orderCost = 0;
    const items = order.lineItems;

    if (Array.isArray(items) && items.length > 0) {
      let knownItemsCost = 0;
      let knownItemsRevenue = 0;

      for (const item of items) {
        const qty = Math.max(1, item.quantity || 1);
        const itemPrice = Math.max(0, item.unitPriceMinor || 0);

        let itemUnitCost: number | null = null;
        if (typeof item.costMinor === "number" && item.costMinor >= 0) {
          itemUnitCost = item.costMinor;
        } else if (item.variantId && variantCostMap.has(item.variantId)) {
          itemUnitCost = variantCostMap.get(item.variantId)!;
        } else if (item.productId && productCostMap.has(item.productId)) {
          itemUnitCost = productCostMap.get(item.productId)!;
        }

        if (itemUnitCost !== null) {
          knownItemsCost += itemUnitCost * qty;
          knownItemsRevenue += itemPrice * qty;
        }
      }

      if (knownItemsRevenue > 0) {
        // Extrapolate margin to order total
        const itemsCostRatio = knownItemsCost / knownItemsRevenue;
        orderCost = Math.round(orderRevenue * itemsCostRatio);
      } else {
        orderCost = Math.round(orderRevenue * defaultCostRatio);
      }
    } else {
      orderCost = Math.round(orderRevenue * defaultCostRatio);
    }

    totalCost += orderCost;
  }

  const totalProfit = Math.max(0, totalRevenue - totalCost);
  const averageProfitMinor =
    evaluatedOrders > 0 ? Math.round(totalProfit / evaluatedOrders) : 0;
  const grossMarginRatio =
    totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 1000) / 1000 : 0;

  return {
    averageProfitMinor,
    grossMarginRatio,
    totalRevenueMinor: totalRevenue,
    totalCostMinor: totalCost,
    totalProfitMinor: totalProfit,
    ordersEvaluated: evaluatedOrders,
  };
}

/**
 * 3. Calculates the maximum affordable cost per click (CPC) in integer minor units:
 * Max CPC = profitPerOrder * assumedConversionRate
 * e.g., $30 profit per order * 2% conversion rate = $0.60 Max CPC (60 cents).
 */
export function maxAffordableCpc(
  profitPerOrderMinor: number,
  assumedConversionRate: number = DEFAULT_FIT_CHECK_CONFIG.assumedConversionRate
): number {
  if (profitPerOrderMinor <= 0 || assumedConversionRate <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(profitPerOrderMinor * assumedConversionRate));
}

/**
 * 4. Filters and ranks products for advertising:
 * - Excludes products with missing or non-positive cost of goods
 * - Ranks primarily by gross dollar profit (price - cost), secondarily by price
 */
export function bestProductsToAdvertise(
  products: ProductInput[]
): RankedProduct[] {
  if (!products || products.length === 0) {
    return [];
  }

  const eligible: RankedProduct[] = [];

  for (const p of products) {
    // Exclude products with missing cost
    if (typeof p.costMinor !== "number" || p.costMinor <= 0) {
      continue;
    }

    const price = Math.max(0, Math.round(p.priceMinor || 0));
    const cost = Math.max(0, Math.round(p.costMinor));
    const profit = Math.max(0, price - cost);
    const marginRatio = price > 0 ? Math.round((profit / price) * 1000) / 1000 : 0;

    eligible.push({
      id: p.id,
      title: p.title,
      handle: p.handle,
      priceMinor: price,
      costMinor: cost,
      profitMinor: profit,
      marginRatio,
      vendor: p.vendor,
      imageUrl: p.imageUrl || null,
    });
  }

  // Rank by profit descending, then price descending
  eligible.sort((a, b) => {
    if (b.profitMinor !== a.profitMinor) {
      return b.profitMinor - a.profitMinor;
    }
    return b.priceMinor - a.priceMinor;
  });

  return eligible;
}

/**
 * 5. Calculates the monthly minimum ad spend required by OpenAI in integer minor units.
 * Daily minimum is configurable by country (defaults to $25.00 / 2500 cents/day in the US).
 */
export function monthlyMinimumSpend(
  campaignCount: number = 1,
  dailyMinimumMinor?: number,
  country: string = "US",
  config: FitCheckConfig = DEFAULT_FIT_CHECK_CONFIG
): number {
  const safeCount = Math.max(1, Math.round(campaignCount || 1));
  const dailyMin =
    typeof dailyMinimumMinor === "number" && dailyMinimumMinor > 0
      ? dailyMinimumMinor
      : config.dailyMinimumMinorByCountry[country.toUpperCase()] ??
        config.defaultDailyMinimumMinor;

  return Math.round(safeCount * dailyMin * config.daysInMonth);
}

/**
 * 6. Computes the Fit Score ("likely" | "maybe" | "unlikely") with 2 to 4 plain human-readable reasons.
 * Uses thresholds from the tuneable config object.
 */
export function fitScore(
  params: {
    aovMinor: number;
    averageProfitMinor: number;
    grossMarginRatio: number;
    maxAffordableCpcMinor: number;
    totalProducts: number;
    productsWithCostCount: number;
    bestProductsCount: number;
  },
  config: FitCheckConfig = DEFAULT_FIT_CHECK_CONFIG
): FitScoreResult {
  const { thresholds } = config;
  const reasons: string[] = [];

  const costCoverageRatio =
    params.totalProducts > 0
      ? params.productsWithCostCount / params.totalProducts
      : 0;

  // Reason 1: Max Affordable CPC assessment
  const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;

  const isCpcLikely = params.maxAffordableCpcMinor >= thresholds.maxCpcLikelyMinor;
  const isCpcMaybe = params.maxAffordableCpcMinor >= thresholds.maxCpcMaybeMinor;

  if (isCpcLikely) {
    reasons.push(
      `Healthy maximum affordable CPC of ${formatMoney(
        params.maxAffordableCpcMinor
      )}, giving you strong competitive headroom to win ad auctions in ChatGPT search.`
    );
  } else if (isCpcMaybe) {
    reasons.push(
      `Moderate maximum affordable CPC of ${formatMoney(
        params.maxAffordableCpcMinor
      )}. Profitable advertising is achievable with tight keyword and product targeting.`
    );
  } else {
    reasons.push(
      `Tight maximum affordable CPC of ${formatMoney(
        params.maxAffordableCpcMinor
      )}. At lower profit margins, ad acquisition costs may exceed order profit without high repeat purchase rates.`
    );
  }

  // Reason 2: Average Order Value & Gross Margin
  const isAovLikely = params.aovMinor >= thresholds.aovLikelyMinor;
  const isAovMaybe = params.aovMinor >= thresholds.aovMaybeMinor;
  const isMarginLikely = params.grossMarginRatio >= thresholds.marginLikelyRatio;
  const isMarginMaybe = params.grossMarginRatio >= thresholds.marginMaybeRatio;

  if (isAovLikely && isMarginLikely) {
    reasons.push(
      `Strong unit economics with an Average Order Value of ${formatMoney(
        params.aovMinor
      )} and an estimated ${formatPercent(
        params.grossMarginRatio
      )} gross margin (${formatMoney(params.averageProfitMinor)} profit/order).`
    );
  } else if (isAovMaybe || isMarginMaybe) {
    reasons.push(
      `Average Order Value is ${formatMoney(
        params.aovMinor
      )} with a ${formatPercent(
        params.grossMarginRatio
      )} gross margin. Focus campaigns on your top-performing catalog items.`
    );
  } else {
    reasons.push(
      `Average Order Value of ${formatMoney(
        params.aovMinor
      )} leaves ${formatMoney(
        params.averageProfitMinor
      )} gross profit per order, requiring disciplined bid caps.`
    );
  }

  // Reason 3: Product Cost Readiness
  const isCostCoverageSufficient =
    costCoverageRatio >= thresholds.costCoverageRatio;
  if (isCostCoverageSufficient) {
    reasons.push(
      `Catalog data is well-prepared: ${formatPercent(
        costCoverageRatio
      )} of products have cost of goods tracked in Shopify for automated margin protection.`
    );
  } else {
    const missingCount = params.totalProducts - params.productsWithCostCount;
    reasons.push(
      `${missingCount} product(s) are missing cost of goods in Shopify. Adding cost data will unlock accurate margin-based bidding.`
    );
  }

  // Reason 4: Flagship products availability
  if (params.bestProductsCount >= thresholds.minFlagshipProducts) {
    reasons.push(
      `${params.bestProductsCount} high-margin products are ready to lead your initial ChatGPT Ads campaigns.`
    );
  } else if (params.bestProductsCount > 0) {
    reasons.push(
      `Found ${params.bestProductsCount} eligible product with tracked margins ready for advertising.`
    );
  } else {
    reasons.push(
      `No products currently have both positive prices and cost of goods filled.`
    );
  }

  // Keep reasons strictly between 2 and 4
  const finalReasons = reasons.slice(0, 4);

  // Determine overall score
  let score: FitScoreLevel = "unlikely";

  if (isCpcLikely && (isAovLikely || isMarginLikely) && isCostCoverageSufficient) {
    score = "likely";
  } else if (
    (isCpcMaybe || isCpcLikely) &&
    (isAovMaybe || isMarginMaybe || params.bestProductsCount >= 1)
  ) {
    score = "maybe";
  } else {
    score = "unlikely";
  }

  return {
    score,
    reasons: finalReasons,
    metrics: {
      aovMinor: params.aovMinor,
      averageProfitMinor: params.averageProfitMinor,
      grossMarginRatio: params.grossMarginRatio,
      maxAffordableCpcMinor: params.maxAffordableCpcMinor,
      costCoverageRatio: Math.round(costCoverageRatio * 1000) / 1000,
      eligibleProductCount: params.bestProductsCount,
    },
  };
}
