import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { checkAndTriggerShopAlerts } from "../services/alerts/alerts.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Query all alerts for this shop, newest first
  const alerts = await db.alert.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const unreadCount = alerts.filter((a) => !a.isRead).length;
  const openCount = alerts.filter((a) => !a.isDone).length;

  return {
    shopDomain: session.shop,
    alerts,
    unreadCount,
    openCount,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return { error: "Shop not found" };
  }

  // 1. Mark alert as Read
  if (intent === "mark_read") {
    const alertId = String(formData.get("alertId") || "");
    if (alertId) {
      await db.alert.update({
        where: { id: alertId },
        data: { isRead: true },
      });
      return { success: true, message: "Alert marked as read." };
    }
  }

  // 2. Mark alert as Done (Resolved)
  if (intent === "mark_done") {
    const alertId = String(formData.get("alertId") || "");
    if (alertId) {
      await db.alert.update({
        where: { id: alertId },
        data: { isDone: true, isRead: true },
      });
      return { success: true, message: "Alert marked as resolved (Done)." };
    }
  }

  // 3. Mark all alerts as Read
  if (intent === "mark_all_read") {
    await db.alert.updateMany({
      where: { shopId: shop.id, isRead: false },
      data: { isRead: true },
    });
    return { success: true, message: "All alerts marked as read." };
  }

  // 4. Run automated alert scan now
  if (intent === "run_scan") {
    const sessionRecord = await db.session.findFirst({
      where: { shop: session.shop },
    });
    const result = await checkAndTriggerShopAlerts(
      shop.id,
      sessionRecord?.email || null
    );

    if (result.triggeredCount > 0) {
      return {
        success: true,
        message: `Diagnostics complete: Generated ${result.triggeredCount} new alert(s) and dispatched notifications via Zoho CPaaS.`,
      };
    } else {
      return {
        success: true,
        message:
          "Diagnostics complete: No new alerts triggered (or rate limited to 1/day).",
      };
    }
  }

  return { error: "Invalid intent" };
};

export default function AlertsPage() {
  const { alerts, unreadCount, openCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; message?: string; error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Alerts & System Notifications">
      {actionData?.success && (
        <s-banner tone="success">
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      )}

      {actionData?.error && (
        <s-banner tone="critical">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}

      {/* Overview Status Cards */}
      <s-section heading="Alert Status">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Open Issues: </s-text>
            <s-badge tone={openCount > 0 ? "critical" : "success"}>
              {openCount}
            </s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Unread Alerts: </s-text>
            <s-badge tone={unreadCount > 0 ? "warning" : "neutral"}>
              {unreadCount}
            </s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Email Channel: </s-text>
            <s-badge tone="info">Zoho CPaaS Email</s-badge>
          </s-box>
        </s-stack>

        <div style={{ marginTop: "12px" }}>
          <s-stack direction="inline" gap="base">
            <Form method="post">
              <input type="hidden" name="intent" value="run_scan" />
              <s-button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "Running Scan..." : "Run Health & Alert Scan"}
              </s-button>
            </Form>

            {unreadCount > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="mark_all_read" />
                <s-button type="submit" disabled={isSubmitting}>
                  Mark All as Read
                </s-button>
              </Form>
            )}
          </s-stack>
        </div>
      </s-section>

      {/* Alerts Feed */}
      <s-section heading="System Alerts">
        {alerts.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-banner tone="success">
              No active alerts. All systems (API credentials, catalog feed, and tracking events) are functioning normally!
            </s-banner>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                style={{
                  backgroundColor: alert.isDone
                    ? "#f6f6f7"
                    : alert.isRead
                    ? "#ffffff"
                    : "#f4f6f8",
                  opacity: alert.isDone ? 0.75 : 1,
                  borderRadius: "8px",
                  border: "1px solid #e1e3e5",
                  padding: "16px",
                  marginBottom: "12px",
                }}
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-badge
                      tone={
                        alert.severity === "CRITICAL"
                          ? "critical"
                          : alert.severity === "WARNING"
                          ? "warning"
                          : "info"
                      }
                    >
                      {alert.severity}
                    </s-badge>

                    {!alert.isRead && (
                      <s-badge tone="warning">NEW</s-badge>
                    )}

                    {alert.isDone ? (
                      <s-badge tone="success">RESOLVED (DONE)</s-badge>
                    ) : (
                      <s-badge tone="neutral">OPEN</s-badge>
                    )}

                    <s-text>
                      <small style={{ color: "#6d7175" }}>
                        {new Date(alert.createdAt).toLocaleString()}
                      </small>
                    </s-text>
                  </s-stack>

                  <div>
                    <s-text><strong>{alert.title}</strong></s-text>
                    <s-paragraph>{alert.message}</s-paragraph>
                  </div>

                  <s-stack direction="inline" gap="base">
                    {!alert.isRead && !alert.isDone && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="mark_read" />
                        <input type="hidden" name="alertId" value={alert.id} />
                        <s-button type="submit" disabled={isSubmitting}>
                          Mark as Read
                        </s-button>
                      </Form>
                    )}

                    {!alert.isDone && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="mark_done" />
                        <input type="hidden" name="alertId" value={alert.id} />
                        <s-button type="submit" variant="primary" disabled={isSubmitting}>
                          Mark as Done
                        </s-button>
                      </Form>
                    )}
                  </s-stack>
                </s-stack>
              </div>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
