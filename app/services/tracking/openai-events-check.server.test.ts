import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzePurchaseGaps, checkOpenAiEventsHealth } from "./openai-events-check.server.ts";
import db from "../../db.server.ts";

describe("OpenAI Events Check & Purchase Gap Analysis", () => {
  it("evaluates events health statuses: ACTIVE, WAITING, PROBLEM, NOT_CONFIGURED with persistent lastSeenAt", async () => {
    const testDomain = `test-health-${Date.now()}.myshopify.com`;
    const testShop = await db.shop.create({
      data: {
        shopDomain: testDomain,
      },
    });

    try {
      // 1. Unconfigured shop -> NOT_CONFIGURED
      const unconfiguredHealth = await checkOpenAiEventsHealth(testShop.id);
      assert.equal(unconfiguredHealth.isConnected, false);
      assert.ok(unconfiguredHealth.events.every((e) => e.status === "NOT_CONFIGURED"));

      // 2. Configured shop, no events ever -> WAITING
      await db.adsConnection.create({
        data: {
          shopId: testShop.id,
          pixelId: "pid_test_123",
          encryptedApiKey: "mock_key",
          keyLast4: "1234",
        },
      });

      const waitingHealth = await checkOpenAiEventsHealth(testShop.id);
      assert.equal(waitingHealth.isConnected, true);
      const orderEvWaiting = waitingHealth.events.find((e) => e.eventName === "order_created");
      assert.ok(orderEvWaiting);
      assert.equal(orderEvWaiting.status, "WAITING");
      assert.equal(orderEvWaiting.lastSeenAt, null);

      // 3. Historical event from 2 hours ago -> status WAITING (not red!), but lastSeenAt is preserved
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await db.conversionSendLog.create({
        data: {
          shopId: testShop.id,
          eventId: "old_event_1",
          eventName: "order_created",
          status: "SUCCESS",
          sentAt: twoHoursAgo,
        },
      });

      const historicalHealth = await checkOpenAiEventsHealth(testShop.id);
      const orderEvHist = historicalHealth.events.find((e) => e.eventName === "order_created");
      assert.ok(orderEvHist);
      assert.equal(orderEvHist.status, "WAITING"); // Neutral waiting, not red!
      assert.equal(orderEvHist.count, 0); // 0 in 15m window
      assert.equal(orderEvHist.lastSeenAt, twoHoursAgo.toISOString()); // Persisted timestamp!

      // 4. Recent event within 15 minutes -> status ACTIVE (green)
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
      await db.conversionSendLog.create({
        data: {
          shopId: testShop.id,
          eventId: "recent_event_1",
          eventName: "order_created",
          status: "SUCCESS",
          sentAt: fiveMinsAgo,
        },
      });

      const activeHealth = await checkOpenAiEventsHealth(testShop.id);
      const orderEvActive = activeHealth.events.find((e) => e.eventName === "order_created");
      assert.ok(orderEvActive);
      assert.equal(orderEvActive.status, "ACTIVE");
      assert.equal(orderEvActive.count, 1);
      assert.equal(orderEvActive.lastSeenAt, fiveMinsAgo.toISOString());

      // 5. Recent failure when count = 0 -> status PROBLEM (red)
      // Delete recent success and create a failure
      await db.conversionSendLog.deleteMany({ where: { eventId: "recent_event_1" } });
      await db.conversionSendLog.create({
        data: {
          shopId: testShop.id,
          eventId: "failed_event_1",
          eventName: "order_created",
          status: "FAILED",
          errorMessage: "Invalid API credentials",
          sentAt: new Date(),
        },
      });

      const problemHealth = await checkOpenAiEventsHealth(testShop.id);
      const orderEvProblem = problemHealth.events.find((e) => e.eventName === "order_created");
      assert.ok(orderEvProblem);
      assert.equal(orderEvProblem.status, "PROBLEM");
      assert.equal(orderEvProblem.problemReason, "Invalid API credentials");
    } finally {
      await db.conversionSendLog.deleteMany({ where: { shopId: testShop.id } });
      await db.adsConnection.deleteMany({ where: { shopId: testShop.id } });
      await db.shop.deleteMany({ where: { id: testShop.id } });
    }
  });

  it("triggers PROBLEM tracking status when 24h gap analysis finds Shopify orders but zero OpenAI purchases", async () => {
    const testDomain = `test-gap-problem-${Date.now()}.myshopify.com`;
    const testShop = await db.shop.create({
      data: {
        shopDomain: testDomain,
      },
    });

    try {
      await db.adsConnection.create({
        data: {
          shopId: testShop.id,
          pixelId: "pid_test_gap",
          encryptedApiKey: "mock_key",
          keyLast4: "5678",
        },
      });

      const gapAnalysisWithZeroPurchases = {
        totalShopifyOrders: 3,
        attributedOrders: 2,
        syncedPurchases: 0, // Zero OpenAI-reported purchase events!
        gapCount: 2,
        gaps: [],
        allOrders: [],
      };

      const gapTriggeredHealth = await checkOpenAiEventsHealth(testShop.id, {
        purchaseGaps: gapAnalysisWithZeroPurchases,
      });

      const orderEvGapProblem = gapTriggeredHealth.events.find((e) => e.eventName === "order_created");
      assert.ok(orderEvGapProblem);
      assert.equal(orderEvGapProblem.status, "PROBLEM");
      assert.match(
        orderEvGapProblem.problemReason || "",
        /3 Shopify order\(s\) in last 24h, but zero OpenAI purchase conversion events/
      );
    } finally {
      await db.conversionSendLog.deleteMany({ where: { shopId: testShop.id } });
      await db.adsConnection.deleteMany({ where: { shopId: testShop.id } });
      await db.shop.deleteMany({ where: { id: testShop.id } });
    }
  });

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
