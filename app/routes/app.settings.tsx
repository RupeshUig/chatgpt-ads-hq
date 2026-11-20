import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { encrypt } from "../lib/crypto.server.ts";
import { logger } from "../lib/logger.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  return {
    shopDomain: session.shop,
    pixelId: shop.adsConnection?.pixelId || "",
    conversionKeyLast4: shop.adsConnection?.conversionKeyLast4 || null,
    apiKeyLast4: shop.adsConnection?.keyLast4 || null,
    feedId: shop.adsConnection?.feedId || null,
    connectionStatus: shop.adsConnection?.status || "PENDING",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  if (!shop) {
    return { error: "Shop not found" };
  }

  if (intent === "save_conversion_credentials") {
    const pixelId = String(formData.get("pixelId") || "").trim();
    const conversionKey = String(formData.get("conversionKey") || "").trim();

    const updateData: {
      pixelId?: string;
      encryptedConversionKey?: string;
      conversionKeyLast4?: string;
    } = {};

    if (pixelId) {
      updateData.pixelId = pixelId;
    }

    if (conversionKey) {
      updateData.encryptedConversionKey = encrypt(conversionKey);
      updateData.conversionKeyLast4 = conversionKey.slice(-4);
    }

    if (shop.adsConnection) {
      await db.adsConnection.update({
        where: { shopId: shop.id },
        data: updateData,
      });
    } else {
      // If ads connection doesn't exist yet, create one
      await db.adsConnection.create({
        data: {
          shopId: shop.id,
          encryptedApiKey: encrypt("placeholder_key"),
          keyLast4: "none",
          pixelId: updateData.pixelId,
          encryptedConversionKey: updateData.encryptedConversionKey,
          conversionKeyLast4: updateData.conversionKeyLast4,
        },
      });
    }

    logger.info("Saved OpenAI Pixel & Conversion Key credentials", {
      shopDomain: session.shop,
      hasPixelId: Boolean(pixelId),
      hasConversionKey: Boolean(conversionKey),
    });

    return {
      success: true,
      message: "OpenAI Measurement Pixel & Conversion Key credentials saved securely.",
    };
  }

  return { error: "Invalid intent" };
};

export default function SettingsPage() {
  const { pixelId, conversionKeyLast4, connectionStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; message?: string; error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Settings & API Credentials">
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

      <s-section heading="OpenAI Tracking & Conversions API (CAPI)">
        <s-paragraph>
          Configure your OpenAI Measurement Pixel and Conversion Key for real-time storefront
          tracking and server-side order deduplication.
        </s-paragraph>

        <Form method="post">
          <input type="hidden" name="intent" value="save_conversion_credentials" />

          <s-stack direction="block" gap="base">
            <div>
              <label
                htmlFor="pixelId"
                style={{ display: "block", marginBottom: "6px", fontWeight: 600, fontSize: "14px" }}
              >
                OpenAI Pixel ID (pid)
              </label>
              <input
                id="pixelId"
                type="text"
                name="pixelId"
                placeholder="e.g. pid_123456789"
                defaultValue={pixelId}
                style={{
                  width: "100%",
                  maxWidth: "420px",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid #c9cccf",
                  fontSize: "14px",
                }}
              />
              <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#6d7175" }}>
                Found in your ChatGPT Ads dashboard under Tracking & Measurement.
              </p>
            </div>

            <div>
              <label
                htmlFor="conversionKey"
                style={{ display: "block", marginBottom: "6px", fontWeight: 600, fontSize: "14px" }}
              >
                Conversions API Key / Token
              </label>
              <input
                id="conversionKey"
                type="password"
                name="conversionKey"
                placeholder={
                  conversionKeyLast4
                    ? `••••••••••••${conversionKeyLast4} (Enter new key to change)`
                    : "Paste OpenAI conversion key..."
                }
                style={{
                  width: "100%",
                  maxWidth: "420px",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid #c9cccf",
                  fontSize: "14px",
                }}
              />
              <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#6d7175" }}>
                Conversion keys are encrypted using AES-256-GCM. Personal customer data is never stored or transmitted.
              </p>
            </div>

            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save Tracking Credentials"}
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Tracking Status & Health">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Pixel Configured: </s-text>
            <s-badge tone={pixelId ? "success" : "warning"}>
              {pixelId ? "Active" : "Not Set"}
            </s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Conversions API Key: </s-text>
            <s-badge tone={conversionKeyLast4 ? "success" : "warning"}>
              {conversionKeyLast4 ? `Ending in ${conversionKeyLast4}` : "Not Set"}
            </s-badge>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Ads Connection: </s-text>
            <s-badge tone={connectionStatus === "CONNECTED" ? "success" : "info"}>
              {connectionStatus}
            </s-badge>
          </s-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
