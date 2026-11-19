import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { logger } from "./lib/logger.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      let currency = "USD";
      let timezone = "UTC";

      if (admin) {
        try {
          const response = await admin.graphql(`
            #graphql
            query getShopDetails {
              shop {
                currencyCode
                ianaTimezone
              }
            }
          `);
          const data = await response.json();
          if (data?.data?.shop) {
            currency = data.data.shop.currencyCode || currency;
            timezone = data.data.shop.ianaTimezone || timezone;
          }
        } catch {
          logger.warn("Could not query shop details during afterAuth, using defaults", {
            shop: session.shop,
          });
        }
      }

      await prisma.shop.upsert({
        where: { shopDomain: session.shop },
        create: {
          shopDomain: session.shop,
          currency,
          timezone,
          installedAt: new Date(),
          uninstalledAt: null,
        },
        update: {
          currency,
          timezone,
          installedAt: new Date(),
          uninstalledAt: null,
        },
      });

      logger.info("Shop installed/updated successfully in afterAuth hook", {
        shop: session.shop,
        currency,
        timezone,
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
