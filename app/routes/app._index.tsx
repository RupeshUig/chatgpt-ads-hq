import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function HomePage() {
  return (
    <s-page heading="Home">
      <s-section heading="Setup Checklist">
        <s-paragraph>
          Complete the onboarding checklist to connect your OpenAI Ads account, sync your product catalog, configure tracking pixels, and establish profit protection rules.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
