import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { BILLING_CONFIG, PLAN_NAMES } from "../config/billing.server";
import {
  getStoreBillingStatus,
  cancelSubscription,
} from "../services/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const billingStatus = await getStoreBillingStatus(request);

  return {
    currentPlan: billingStatus.plan,
    isTest: BILLING_CONFIG.isTest,
    plans: BILLING_CONFIG.plans,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetPlan = formData.get("plan");

  if (
    intent === "upgrade" &&
    (targetPlan === "PRO" || targetPlan === "SCALE")
  ) {
    const planName =
      targetPlan === "SCALE" ? PLAN_NAMES.SCALE : PLAN_NAMES.PRO;

    const url = new URL(request.url);
    return await billing.request({
      plan: planName,
      isTest: BILLING_CONFIG.isTest,
      returnUrl: `${url.origin}/app/plans`,
    });
  }

  if (intent === "downgrade") {
    await cancelSubscription(request);
    return { success: true };
  }

  return { error: "Invalid action" };
};

export default function PlansPage() {
  const { currentPlan, isTest, plans } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";

  return (
    <s-page heading="Plans & Pricing">
      {isTest && (
        <s-banner tone="info">
          Test Billing Mode: You are in test mode. No actual charges will be
          billed to your Shopify account.
        </s-banner>
      )}

      <s-section heading="Choose the right plan for your ChatGPT Ads">
        <s-paragraph>
          Sync and tracking health are always free. Upgrade anytime to unlock
          True Profit reporting and Spend Protection rules.
        </s-paragraph>
      </s-section>

      {/* Free Plan */}
      <s-section
        heading={`${plans.FREE.name} — $${plans.FREE.priceUSD}/month`}
      >
        <s-paragraph>{plans.FREE.tagline}</s-paragraph>
        <s-unordered-list>
          {plans.FREE.features.map((feature, idx) => (
            <s-list-item key={idx}>{feature}</s-list-item>
          ))}
        </s-unordered-list>

        {currentPlan === "FREE" ? (
          <s-badge tone="success">Current Plan</s-badge>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="downgrade" />
            <s-button type="submit" disabled={isSubmitting}>
              Downgrade to Free
            </s-button>
          </fetcher.Form>
        )}
      </s-section>

      {/* Pro Plan */}
      <s-section
        heading={`${plans.PRO.name} — $${plans.PRO.priceUSD}/month (${plans.PRO.trialDays}-day free trial)`}
      >
        <s-paragraph>{plans.PRO.tagline}</s-paragraph>
        <s-unordered-list>
          {plans.PRO.features.map((feature, idx) => (
            <s-list-item key={idx}>{feature}</s-list-item>
          ))}
        </s-unordered-list>

        {currentPlan === "PRO" ? (
          <s-badge tone="success">Current Plan</s-badge>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="upgrade" />
            <input type="hidden" name="plan" value="PRO" />
            <s-button
              type="submit"
              variant={currentPlan === "FREE" ? "primary" : undefined}
              disabled={isSubmitting}
            >
              {currentPlan === "SCALE"
                ? "Switch to Pro"
                : "Upgrade to Pro (14-Day Free Trial)"}
            </s-button>
          </fetcher.Form>
        )}
      </s-section>

      {/* Scale Plan */}
      <s-section
        heading={`${plans.SCALE.name} — $${plans.SCALE.priceUSD}/month (${plans.SCALE.trialDays}-day free trial)`}
      >
        <s-paragraph>{plans.SCALE.tagline}</s-paragraph>
        <s-unordered-list>
          {plans.SCALE.features.map((feature, idx) => (
            <s-list-item key={idx}>{feature}</s-list-item>
          ))}
        </s-unordered-list>

        {currentPlan === "SCALE" ? (
          <s-badge tone="success">Current Plan</s-badge>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="upgrade" />
            <input type="hidden" name="plan" value="SCALE" />
            <s-button type="submit" disabled={isSubmitting}>
              Upgrade to Scale (14-Day Free Trial)
            </s-button>
          </fetcher.Form>
        )}
      </s-section>
    </s-page>
  );
}
