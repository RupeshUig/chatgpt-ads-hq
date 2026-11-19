import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  // Extract only request/customer ID; strictly NO personal data logged
  const rawPayload = payload as Record<string, unknown> | undefined;
  const customer = rawPayload?.customer as Record<string, unknown> | undefined;
  const requestId = customer?.id ?? rawPayload?.id ?? "unknown";

  logger.info(`Received ${topic} webhook`, {
    shop,
    requestId: String(requestId),
  });

  return new Response(null, { status: 200 });
};
