import { authenticate } from "../shopify.server";
import { BILLING_CONFIG, PLAN_NAMES } from "../config/billing.server";
import db from "../db.server";
import { logger } from "../lib/logger.server";

export type PaidPlan = "PRO" | "SCALE";

/**
 * Route protection helper: ensures the requesting store is on the required paid plan.
 * If the shop is not on an active eligible subscription, redirects to Shopify's approval flow.
 */
export async function requirePlan(request: Request, requiredPlan: PaidPlan) {
  const { session, billing } = await authenticate.admin(request);

  // SCALE requires SCALE. PRO allows either PRO or SCALE.
  const eligiblePlans =
    requiredPlan === "SCALE"
      ? [PLAN_NAMES.SCALE]
      : [PLAN_NAMES.PRO, PLAN_NAMES.SCALE];

  await billing.require({
    plans: eligiblePlans,
    isTest: BILLING_CONFIG.isTest,
    onFailure: async () => {
      const url = new URL(request.url);
      return billing.request({
        plan: requiredPlan === "SCALE" ? PLAN_NAMES.SCALE : PLAN_NAMES.PRO,
        isTest: BILLING_CONFIG.isTest,
        returnUrl: `${url.origin}/app/plans`,
      });
    },
  });

  // Verify and sync active plan to database
  const status = await billing.check({
    plans: eligiblePlans,
    isTest: BILLING_CONFIG.isTest,
  });

  const activeSubscription = status.appSubscriptions?.[0];
  const currentPlan =
    activeSubscription?.name === PLAN_NAMES.SCALE ? "SCALE" : "PRO";

  await db.shop.updateMany({
    where: { shopDomain: session.shop },
    data: { plan: currentPlan },
  });

  return { session, billing, plan: currentPlan };
}

/**
 * Returns the current active billing subscription and tier for the store.
 */
export async function getStoreBillingStatus(request: Request) {
  const { session, billing } = await authenticate.admin(request);

  // Check SCALE first (highest tier)
  const scaleCheck = await billing.check({
    plans: [PLAN_NAMES.SCALE],
    isTest: BILLING_CONFIG.isTest,
  });

  if (scaleCheck.hasActivePayment && scaleCheck.appSubscriptions?.[0]) {
    await db.shop.updateMany({
      where: { shopDomain: session.shop },
      data: { plan: "SCALE" },
    });
    return {
      plan: "SCALE" as const,
      subscription: scaleCheck.appSubscriptions[0],
      isTest: BILLING_CONFIG.isTest,
    };
  }

  // Check PRO
  const proCheck = await billing.check({
    plans: [PLAN_NAMES.PRO],
    isTest: BILLING_CONFIG.isTest,
  });

  if (proCheck.hasActivePayment && proCheck.appSubscriptions?.[0]) {
    await db.shop.updateMany({
      where: { shopDomain: session.shop },
      data: { plan: "PRO" },
    });
    return {
      plan: "PRO" as const,
      subscription: proCheck.appSubscriptions[0],
      isTest: BILLING_CONFIG.isTest,
    };
  }

  // Free plan
  await db.shop.updateMany({
    where: { shopDomain: session.shop },
    data: { plan: "FREE" },
  });

  return {
    plan: "FREE" as const,
    subscription: null,
    isTest: BILLING_CONFIG.isTest,
  };
}

/**
 * Cancels any active paid subscriptions and downgrades the shop to FREE.
 */
export async function cancelSubscription(request: Request) {
  const { session, billing } = await authenticate.admin(request);

  const current = await getStoreBillingStatus(request);
  if (current.subscription) {
    try {
      await billing.cancel({
        subscriptionId: current.subscription.id,
        isTest: BILLING_CONFIG.isTest,
        prorate: true,
      });

      logger.info("Cancelled active subscription", {
        shop: session.shop,
        subscriptionId: current.subscription.id,
      });
    } catch (error) {
      logger.error(error, {
        shop: session.shop,
        action: "cancel_subscription",
      });
      throw error;
    }
  }

  await db.shop.updateMany({
    where: { shopDomain: session.shop },
    data: { plan: "FREE" },
  });

  return { success: true };
}
