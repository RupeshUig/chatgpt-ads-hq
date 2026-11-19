import { BillingInterval } from "@shopify/shopify-app-react-router/server";

export const PLAN_NAMES = {
  FREE: "Free",
  PRO: "Pro",
  SCALE: "Scale",
} as const;

export type PlanKey = keyof typeof PLAN_NAMES;
export type PlanDisplayName = (typeof PLAN_NAMES)[PlanKey];

export interface PlanDefinition {
  key: PlanKey;
  name: PlanDisplayName;
  priceUSD: number;
  interval: BillingInterval | null;
  trialDays: number;
  tagline: string;
  features: string[];
}

export const BILLING_CONFIG = {
  /**
   * Test mode prevents actual credit card charges.
   * Defaults to true unless BILLING_TEST_MODE is explicitly set to "false".
   */
  isTest: process.env.BILLING_TEST_MODE !== "false",

  plans: {
    FREE: {
      key: "FREE",
      name: PLAN_NAMES.FREE,
      priceUSD: 0,
      interval: null,
      trialDays: 0,
      tagline: "Free forever for product sync & tracking check",
      features: [
        "Automated catalog sync (SFTP + Delta API)",
        "Per-product sync diagnostics & plain-language fixes",
        "Free include/exclude collection & tag rules",
        "1-click Web Pixel & server-side CAPI tracking setup",
        "Pre-spend fit check viability score",
        "Basic email alerts",
      ],
    },
    PRO: {
      key: "PRO",
      name: PLAN_NAMES.PRO,
      priceUSD: 29,
      interval: BillingInterval.Every30Days,
      trialDays: 14,
      tagline: "True profit reporting & spend protection",
      features: [
        "Everything in Free",
        "True profit dashboard (Revenue minus COGS, fees, ad spend)",
        "Profit per campaign & per product",
        "Automated daily profit pause rules & monthly spend cap",
        "Tracking break detector & missed-sale audit",
        "30+ day historical reporting stored in Postgres",
        "AI catalog quality score & attribute enrichment",
        "Weekly performance executive email summary",
      ],
    },
    SCALE: {
      key: "SCALE",
      name: PLAN_NAMES.SCALE,
      priceUSD: 99,
      interval: BillingInterval.Every30Days,
      trialDays: 14,
      tagline: "For high-volume stores & agencies",
      features: [
        "Everything in Pro",
        "Multi-engine AI channel overview (ChatGPT, Perplexity, Claude, Gemini)",
        "High-volume catalog limits",
        "Team & agency staff access",
        "Priority support",
      ],
    },
  } satisfies Record<PlanKey, PlanDefinition>,
};
