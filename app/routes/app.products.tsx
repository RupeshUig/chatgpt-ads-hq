import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.ts";
import db from "../db.server.ts";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { FEED_DISABLED_MESSAGE } from "../services/feed/openai-feed-client.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { adsConnection: true },
  });

  const isFeedAccessDisabled =
    shop?.adsConnection?.feedAccessStatus === "DISABLED_403";
  const feedAccessMessage =
    shop?.adsConnection?.feedAccessMessage || FEED_DISABLED_MESSAGE;

  return {
    isFeedAccessDisabled,
    feedAccessMessage,
  };
};

export default function ProductsPage() {
  const { isFeedAccessDisabled, feedAccessMessage } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Products">
      {isFeedAccessDisabled && (
        <s-banner tone="warning" heading="Feed Access Disabled">
          <s-paragraph>{feedAccessMessage}</s-paragraph>
        </s-banner>
      )}

      <s-section>
        <s-paragraph>
          Manage product catalog synchronization, SKU mapping, eligibility rules, and OpenAI feed diagnostics.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
