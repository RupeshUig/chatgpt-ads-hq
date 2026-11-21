import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import db from "../../db.server.ts";
import {
  sendZohoCpaasEmail,
  checkAndTriggerShopAlerts,
} from "./alerts.server.ts";

describe("Alerts System & Zoho CPaaS Integration", () => {
  const testShopDomain = `test-alert-${Date.now()}.myshopify.com`;
  let testShopId: string;

  beforeEach(async () => {
    // Setup clean test shop
    const shop = await db.shop.upsert({
      where: { shopDomain: testShopDomain },
      update: {},
      create: {
        shopDomain: testShopDomain,
        plan: "FREE",
      },
    });
    testShopId = shop.id;

    // Clean any prior alerts for this shop
    await db.alert.deleteMany({ where: { shopId: testShopId } });
  });

  after(async () => {
    if (testShopId) {
      await db.alert.deleteMany({ where: { shopId: testShopId } });
      await db.adsConnection.deleteMany({ where: { shopId: testShopId } });
      await db.product.deleteMany({ where: { shopId: testShopId } });
      await db.shop.deleteMany({ where: { id: testShopId } });
    }
  });

  describe("sendZohoCpaasEmail()", () => {
    it("handles sandbox/dev mode safely without throwing when API key is unset", async () => {
      const result = await sendZohoCpaasEmail({
        toEmail: "merchant@example.com",
        recipientName: "Test Store",
        subject: "Test Alert",
        htmlBody: "<p>Warning: System Test</p>",
      });

      assert.equal(result.success, true);
      assert.ok(result.messageId?.startsWith("mock_zoho_"));
    });
  });

  describe("checkAndTriggerShopAlerts(): Detection & 1-per-day Rate Limiting", () => {
    it("triggers API_KEY_INVALID alert when ads connection has error", async () => {
      // Create connection with ERROR status
      await db.adsConnection.upsert({
        where: { shopId: testShopId },
        update: { status: "ERROR" },
        create: {
          shopId: testShopId,
          status: "ERROR",
          encryptedApiKey: "test_encrypted",
          keyLast4: "1234",
        },
      });

      const result = await checkAndTriggerShopAlerts(
        testShopId,
        "test@example.com"
      );

      assert.ok(result.triggeredCount >= 1);
      assert.ok(
        result.newAlerts.some((title) =>
          title.includes("API Key or Authentication Invalid")
        )
      );

      // Verify stored in DB
      const stored = await db.alert.findFirst({
        where: { shopId: testShopId, alertType: "API_KEY_INVALID" },
      });
      assert.ok(stored);
      assert.equal(stored.severity, "CRITICAL");
      assert.equal(stored.isRead, false);
      assert.equal(stored.isDone, false);
    });

    it("strictly limits identical alert types to at most 1 per day per shop", async () => {
      // 1st run should trigger
      const firstRun = await checkAndTriggerShopAlerts(
        testShopId,
        "test@example.com"
      );
      assert.ok(firstRun.triggeredCount >= 1);

      // 2nd run immediately after MUST suppress duplicate
      const secondRun = await checkAndTriggerShopAlerts(
        testShopId,
        "test@example.com"
      );
      assert.equal(secondRun.triggeredCount, 0);

      // Total count in DB for API_KEY_INVALID remains exactly 1
      const count = await db.alert.count({
        where: { shopId: testShopId, alertType: "API_KEY_INVALID" },
      });
      assert.equal(count, 1);
    });

    it("triggers PRODUCT_SYNC_FAILED alert when products are rejected", async () => {
      // Create a rejected product
      await db.product.create({
        data: {
          shopId: testShopId,
          shopifyProductId: "gid://shopify/Product/999111",
          shopifyVariantId: "gid://shopify/ProductVariant/888222",
          title: "Rejected Item",
          priceMinor: 2500,
          syncStatus: "REJECTED",
          rejectReason: "Missing description",
        },
      });

      const result = await checkAndTriggerShopAlerts(
        testShopId,
        "test@example.com"
      );

      assert.ok(result.triggeredCount >= 1);
      assert.ok(
        result.newAlerts.some((title) =>
          title.includes("Product Catalog Feed Sync Failed")
        )
      );

      const alert = await db.alert.findFirst({
        where: { shopId: testShopId, alertType: "PRODUCT_SYNC_FAILED" },
      });
      assert.ok(alert);
      assert.equal(alert.severity, "WARNING");
    });
  });
});
