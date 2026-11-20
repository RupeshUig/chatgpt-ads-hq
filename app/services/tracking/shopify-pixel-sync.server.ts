import { logger } from "../../lib/logger.server.ts";

/**
 * Ensures the Web Pixel extension is activated on the Shopify store with the given pixelId.
 */
export async function syncShopifyWebPixel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  pixelId: string,
  appUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const cleanPixelId = pixelId.trim();
  if (!cleanPixelId) {
    return { success: false, error: "Pixel ID cannot be empty" };
  }

  const settingsJson = JSON.stringify({
    pixelId: cleanPixelId,
    endpoint: "https://bzr.openai.com/v1/events",
    appUrl: appUrl || process.env.SHOPIFY_APP_URL || "",
  });

  try {
    // 1. Try creating the Web Pixel on the shop
    const createResp = await admin.graphql(
      `#graphql
      mutation webPixelCreate($settings: JSON!) {
        webPixelCreate(webPixel: { settings: $settings }) {
          userErrors {
            code
            field
            message
          }
          webPixel {
            id
            settings
          }
        }
      }`,
      {
        variables: { settings: settingsJson },
      }
    );

    const createJson = await createResp.json();
    const userErrors = createJson.data?.webPixelCreate?.userErrors || [];

    if (userErrors.length === 0) {
      logger.info("Successfully created and activated Web Pixel on store", {
        pixelId: cleanPixelId,
        webPixelId: createJson.data?.webPixelCreate?.webPixel?.id,
      });
      return { success: true };
    }

    // 2. If it already exists, query existing pixel and update it
    logger.info("webPixelCreate returned userErrors, checking existing pixels", {
      errors: userErrors,
    });

    const queryResp = await admin.graphql(
      `#graphql
      query getWebPixels {
        webPixels(first: 5) {
          nodes {
            id
            settings
          }
        }
      }`
    );

    const queryJson = await queryResp.json();
    const existingPixels = queryJson.data?.webPixels?.nodes || [];

    if (existingPixels.length > 0) {
      const existingId = existingPixels[0].id;
      const updateResp = await admin.graphql(
        `#graphql
        mutation webPixelUpdate($id: ID!, $settings: JSON!) {
          webPixelUpdate(id: $id, webPixel: { settings: $settings }) {
            userErrors {
              code
              field
              message
            }
            webPixel {
              id
              settings
            }
          }
        }`,
        {
          variables: {
            id: existingId,
            settings: settingsJson,
          },
        }
      );

      const updateJson = await updateResp.json();
      const updateErrors = updateJson.data?.webPixelUpdate?.userErrors || [];

      if (updateErrors.length === 0) {
        logger.info("Successfully updated existing Web Pixel settings", {
          pixelId: cleanPixelId,
          webPixelId: existingId,
        });
        return { success: true };
      }

      return {
        success: false,
        error: updateErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    return {
      success: false,
      error: userErrors.map((e: { message: string }) => e.message).join(", "),
    };
  } catch (err: unknown) {
    logger.error("Exception synchronizing Shopify Web Pixel", {
      error: String(err),
      pixelId: cleanPixelId,
    });
    return { success: false, error: String(err) };
  }
}
