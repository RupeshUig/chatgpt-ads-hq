import db from "../../db.server.ts";
import { logger } from "../../lib/logger.server.ts";

export type AlertType =
  | "API_KEY_INVALID"
  | "PRODUCT_SYNC_FAILED"
  | "TRACKING_STOPPED_24H";

export interface ZohoEmailPayload {
  toEmail: string;
  recipientName?: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
}

export interface ZohoEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends an alert notification email via Zoho CPaaS (ZeptoMail API).
 * Falls back gracefully to logged mock delivery if API key is not yet set in environment.
 */
export async function sendZohoCpaasEmail(
  payload: ZohoEmailPayload
): Promise<ZohoEmailResult> {
  const apiKey =
    process.env.ZOHO_CPAAS_API_KEY ||
    process.env.ZEPTOMAIL_API_KEY ||
    process.env.ZOHO_ZEPTOMAIL_TOKEN;
  const fromEmail =
    process.env.ZOHO_FROM_EMAIL || "alerts@cartlightlabs.com";
  const fromName = "Cartlight ChatGPT Ads";

  if (!apiKey) {
    logger.info(
      "[Zoho CPaaS Email] (Dev/Sandbox Mode) Alert email logged because ZOHO_CPAAS_API_KEY is not set",
      {
        to: payload.toEmail,
        subject: payload.subject,
      }
    );
    return {
      success: true,
      messageId: `mock_zoho_${Date.now()}`,
    };
  }

  try {
    const res = await fetch("https://api.zeptomail.com/v1.1/email", {
      method: "POST",
      headers: {
        Authorization: `Zoho-enczapikey ${apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: {
          address: fromEmail,
          name: fromName,
        },
        to: [
          {
            email_address: {
              address: payload.toEmail,
              name: payload.recipientName || "Merchant",
            },
          },
        ],
        subject: payload.subject,
        htmlbody: payload.htmlBody,
        textbody: payload.textBody || payload.htmlBody.replace(/<[^>]+>/g, ""),
      }),
    });

    const json = (await res.json()) as {
      data?: Array<{ message_id?: string }>;
      message?: string;
    };

    if (res.ok) {
      const messageId = json.data?.[0]?.message_id || `zoho_${Date.now()}`;
      logger.info("Successfully delivered alert email via Zoho CPaaS", {
        to: payload.toEmail,
        messageId,
      });
      return { success: true, messageId };
    } else {
      logger.error("Zoho CPaaS email API returned error", {
        status: res.status,
        response: json,
      });
      return {
        success: false,
        error: json.message || `Zoho error HTTP ${res.status}`,
      };
    }
  } catch (err) {
    logger.error("Zoho CPaaS network exception", { error: String(err) });
    return { success: false, error: String(err) };
  }
}

/**
 * Scans shop conditions and triggers alerts:
 * 1. API key invalid
 * 2. Product sync failed
 * 3. Tracking events stopped for 24 hours
 *
 * Enforces strict 1-alert-per-day rate limit per shop per alert type.
 */
export async function checkAndTriggerShopAlerts(
  shopId: string,
  merchantEmail?: string | null
): Promise<{
  triggeredCount: number;
  newAlerts: string[];
}> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    include: {
      adsConnection: true,
      products: true,
    },
  });

  if (!shop) {
    return { triggeredCount: 0, newAlerts: [] };
  }

  const shopDomain = shop.shopDomain;
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const newAlerts: string[] = [];

  // Helper to check if this alert type was already sent in the last 24h
  async function wasSentRecently(alertType: AlertType): Promise<boolean> {
    const existing = await db.alert.findFirst({
      where: {
        shopId,
        alertType,
        createdAt: { gte: twentyFourHoursAgo },
      },
    });
    return Boolean(existing);
  }

  // Helper to create and email alert
  async function dispatchAlert(options: {
    alertType: AlertType;
    title: string;
    message: string;
    severity: "CRITICAL" | "WARNING" | "INFO";
  }) {
    if (await wasSentRecently(options.alertType)) {
      logger.info(
        `Suppressed duplicate alert '${options.alertType}' (sent within last 24h)`,
        { shopDomain }
      );
      return;
    }

    // 1. Store in database
    await db.alert.create({
      data: {
        shopId,
        alertType: options.alertType,
        title: options.title,
        message: options.message,
        severity: options.severity,
        isRead: false,
        isDone: false,
      },
    });

    newAlerts.push(options.title);

    // 2. Dispatch email via Zoho CPaaS if email is available
    const recipient =
      merchantEmail ||
      process.env.ALERT_NOTIFICATION_EMAIL ||
      `admin@${shopDomain}`;

    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e1e3e5; border-radius: 8px;">
        <h2 style="color: #d82c0d; margin-top: 0;">⚠️ ${options.title}</h2>
        <p style="font-size: 15px; line-height: 1.5; color: #202223;">
          ${options.message}
        </p>
        <p style="font-size: 13px; color: #6d7175; margin-top: 24px; border-top: 1px solid #e1e3e5; padding-top: 12px;">
          Store: <strong>${shopDomain}</strong><br />
          Open your <a href="https://${shopDomain}/admin/apps" style="color: #2c6ecb;">Cartlight Ads HQ</a> dashboard to resolve this issue.
        </p>
      </div>
    `;

    await sendZohoCpaasEmail({
      toEmail: recipient,
      recipientName: shopDomain,
      subject: `[Cartlight Alert] ${options.title}`,
      htmlBody,
    });
  }

  // --- Check 1: API Key Invalid ---
  if (
    shop.adsConnection &&
    (shop.adsConnection.status === "ERROR" ||
      shop.adsConnection.feedAccessStatus === "DISABLED_403")
  ) {
    await dispatchAlert({
      alertType: "API_KEY_INVALID",
      title: "OpenAI Ads API Key or Authentication Invalid",
      message:
        "Your OpenAI Ads API credentials could not be authenticated or lack advertising permissions. Ad campaigns and performance sync are paused. Please re-enter your OpenAI API key in Settings.",
      severity: "CRITICAL",
    });
  }

  // --- Check 2: Product Sync Failed ---
  const rejectedProducts = shop.products.filter(
    (p) => p.syncStatus === "REJECTED"
  );
  const failedDeltasCount = await db.feedDelta.count({
    where: { shopId, status: "FAILED" },
  });

  if (rejectedProducts.length > 0 || failedDeltasCount > 0) {
    await dispatchAlert({
      alertType: "PRODUCT_SYNC_FAILED",
      title: "Product Catalog Feed Sync Failed",
      message: `${
        rejectedProducts.length > 0
          ? `${rejectedProducts.length} product(s) were rejected by the OpenAI catalog validator.`
          : ""
      } ${
        failedDeltasCount > 0
          ? `${failedDeltasCount} catalog delta updates failed to upload.`
          : ""
      } Review your Products page to inspect rejection reasons and fix errors.`,
      severity: "WARNING",
    });
  }

  // --- Check 3: Tracking Events Stopped for 24 Hours ---
  if (shop.adsConnection?.pixelId) {
    const recentLogsCount = await db.conversionSendLog.count({
      where: {
        shopId,
        sentAt: { gte: twentyFourHoursAgo },
      },
    });

    if (recentLogsCount === 0) {
      await dispatchAlert({
        alertType: "TRACKING_STOPPED_24H",
        title: "No Conversion Tracking Signals in 24 Hours",
        message:
          "Cartlight has not recorded any storefront pixel or purchase conversion events from your store in the last 24 hours. Verify your Shopify Web Pixel status in the Tracking page.",
        severity: "WARNING",
      });
    }
  }

  return {
    triggeredCount: newAlerts.length,
    newAlerts,
  };
}
