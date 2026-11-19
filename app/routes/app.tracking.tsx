import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function TrackingPage() {
  return (
    <s-page heading="Tracking">
      <s-section>
        <s-paragraph>
          Configure and monitor the ChatGPT Ads Web Pixel and Conversions API (CAPI) server-side tracking health.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
