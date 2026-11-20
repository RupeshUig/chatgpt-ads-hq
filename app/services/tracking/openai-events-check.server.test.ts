import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzePurchaseGaps } from "./openai-events-check.server.ts";
import db from "../../db.server.ts";

describe("OpenAI Events Check & Purchase Gap Analysis", () => {
  it("classifies orders correctly into synced, organic, and gap states", async () => {
    // Upsert a test shop to satisfy foreign key constraint
    const testShop = await db.shop.upsert({
      where: { shopDomain: "test-gap-audit.myshopify.com" },
      create: {
        shopDomain: "test-gap-audit.myshopify.com",
      },
      update: {},
    });
    const testShopId = testShop.id;

    // Clean up any test records
    await db.conversionSendLog.deleteMany({
      where: { shopId: testShopId },
    });

    try {
      // 1. Seed test logs
      // Order 1001: Success
      await db.conversionSendLog.create({
        data: {
          shopId: testShopId,
          eventId: "1001",
          eventName: "order_created",
          status: "SUCCESS",
          hasClickId: true,
          sentAt: new Date(),
        },
      });

      // Order 1002: Failed
      await db.conversionSendLog.create({
        data: {
          shopId: testShopId,
          eventId: "1002",
          eventName: "order_created",
          status: "FAILED",
          errorCode: "401",
          errorMessage: "Invalid OpenAI conversion key",
          hasClickId: true,
          sentAt: new Date(),
        },
      });

      // Order 1003: Skipped
      await db.conversionSendLog.create({
        data: {
          shopId: testShopId,
          eventId: "1003",
          eventName: "order_created",
          status: "SKIPPED",
          errorCode: "MISSING_CONFIG",
          errorMessage: "Pixel ID not configured",
          hasClickId: true,
          sentAt: new Date(),
        },
      });

      // 2. Prepare mock Shopify orders
      const mockShopifyOrders = [
        // Order 1001: Attributed and synced
        {
          id: "gid://shopify/Order/1001",
          name: "#1001",
          createdAt: new Date().toISOString(),
          totalPriceSet: {
            shopMoney: { amount: "49.99", currencyCode: "USD" },
          },
          customAttributes: [{ key: "_oppref", value: "click_1001" }],
        },
        // Order 1002: Attributed but failed
        {
          id: "gid://shopify/Order/1002",
          name: "#1002",
          createdAt: new Date().toISOString(),
          totalPriceSet: {
            shopMoney: { amount: "25.00", currencyCode: "USD" },
          },
          customAttributes: [{ key: "oppref", value: "click_1002" }],
        },
        // Order 1003: Attributed but skipped
        {
          id: "gid://shopify/Order/1003",
          name: "#1003",
          createdAt: new Date().toISOString(),
          totalPriceSet: {
            shopMoney: { amount: "80.00", currencyCode: "USD" },
          },
          customAttributes: [{ key: "_oppref", value: "click_1003" }],
        },
        // Order 1004: Attributed but completely missing from CAPI logs
        {
          id: "gid://shopify/Order/1004",
          name: "#1004",
          createdAt: new Date().toISOString(),
          totalPriceSet: {
            shopMoney: { amount: "120.00", currencyCode: "USD" },
          },
          customAttributes: [{ key: "_oppref", value: "click_1004" }],
        },
        // Order 1005: Organic order (no oppref)
        {
          id: "gid://shopify/Order/1005",
          name: "#1005",
          createdAt: new Date().toISOString(),
          totalPriceSet: {
            shopMoney: { amount: "15.00", currencyCode: "USD" },
          },
          customAttributes: [],
        },
      ];

      const analysis = await analyzePurchaseGaps(testShopId, mockShopifyOrders);

      assert.equal(analysis.totalShopifyOrders, 5);
      assert.equal(analysis.attributedOrders, 4); // 1001, 1002, 1003, 1004
      assert.equal(analysis.syncedPurchases, 1); // 1001
      assert.equal(analysis.gapCount, 3); // 1002 (failed), 1003 (skipped), 1004 (missing)

      // Verify specific gap types
      const gap1002 = analysis.gaps.find((g) => g.orderId === "1002");
      assert.ok(gap1002);
      assert.equal(gap1002.gapType, "GAP_FAILED");
      assert.equal(gap1002.capiStatus, "FAILED");
      assert.equal(gap1002.gapReason, "Invalid OpenAI conversion key");

      const gap1003 = analysis.gaps.find((g) => g.orderId === "1003");
      assert.ok(gap1003);
      assert.equal(gap1003.gapType, "GAP_SKIPPED");
      assert.equal(gap1003.capiStatus, "SKIPPED");

      const gap1004 = analysis.gaps.find((g) => g.orderId === "1004");
      assert.ok(gap1004);
      assert.equal(gap1004.gapType, "GAP_MISSING");
      assert.equal(gap1004.capiStatus, "NOT_SENT");

      // Verify organic order
      const order1005 = analysis.allOrders.find((o) => o.orderId === "1005");
      assert.ok(order1005);
      assert.equal(order1005.gapType, "ORGANIC");
      assert.equal(order1005.hasOppref, false);
    } finally {
      await db.conversionSendLog.deleteMany({
        where: { shopId: testShopId },
      });
      await db.shop.deleteMany({
        where: { id: testShopId },
      });
    }
  });
});
