import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const rawPayload = payload as Record<string, unknown> | undefined;
  const customer = rawPayload?.customer as Record<string, unknown> | undefined;
  const customerId = customer?.id ?? rawPayload?.id ?? "unknown";

  logger.info(`Received ${topic} webhook`, {
    shop,
    customerId: String(customerId),
  });

  // Note: Cartlight does not store customer personal data.
  // If customer-linked data is added in future phases, purge it here.

  return new Response(null, { status: 200 });
};
