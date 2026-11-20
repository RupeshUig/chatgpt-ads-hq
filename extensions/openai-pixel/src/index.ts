import { register } from "@shopify/web-pixels-extension";
import {
  extractOppref,
  hasUserConsent,
  buildPageViewPayload,
  buildProductViewPayload,
  buildAddToCartPayload,
  buildCheckoutStartedPayload,
  buildOrderCreatedPayload,
  type OpenAILiveBatchPayload,
} from "./pixel-utils";

register(({ analytics, browser, init, settings, customerPrivacy }) => {
  const pixelId = String(settings?.pixelId || "").trim();
  const baseEndpoint = String(
    settings?.endpoint || "https://bzr.openai.com/v1/events"
  ).trim();
  const appUrl = String(settings?.appUrl || "").trim();

  // If pixel ID is not set in extension settings, skip tracking
  if (!pixelId) {
    return;
  }

  const endpointUrl = `${baseEndpoint}?pid=${encodeURIComponent(pixelId)}`;

  // 1. Live Consent State Management
  let consentGranted = hasUserConsent(init?.customerPrivacy);

  if (customerPrivacy && typeof customerPrivacy.subscribe === "function") {
    customerPrivacy.subscribe("visitorConsentCollected", (event) => {
      consentGranted = hasUserConsent(event?.customerPrivacy);
    });
  }

  /**
   * Helper to retrieve or sync oppref click ID
   */
  async function resolveClickId(currentUrl: string): Promise<string | null> {
    const urlOppref = extractOppref(currentUrl);

    if (urlOppref) {
      // Persist in first-party cookie for subsequent pages in session
      try {
        await browser.cookie.set("__oppref", urlOppref);
      } catch {
        // Cookie storage failure fallback
      }

      // Sync to Shopify cart attribute so it persists across checkout to order
      try {
        await fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attributes: { _oppref: urlOppref } }),
          keepalive: true,
        });
      } catch {
        // Cart update network failure fallback
      }

      return urlOppref;
    }

    // Fallback: Read stored cookie if not on landing URL
    try {
      const storedCookie = await browser.cookie.get("__oppref");
      return storedCookie ? storedCookie.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Dispatches payload to OpenAI Pixel endpoint via fetch with keepalive: true
   * Ensures strict zero-PII and consent enforcement
   */
  async function dispatchOpenAIEvent(payload: OpenAILiveBatchPayload) {
    if (!consentGranted) {
      return;
    }

    try {
      await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (err) {
      console.error("[OpenAI Pixel] Error sending event:", err);
    }

    // Also notify app backend for real-time tracking health checks
    if (appUrl) {
      try {
        const firstEvent = payload.events[0];
        if (firstEvent) {
          await fetch(`${appUrl}/api/pixel-events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              pixelId,
              eventName: firstEvent.type,
              eventId: firstEvent.id,
              clickId: firstEvent.user?.click_id || null,
            }),
            keepalive: true,
          });
        }
      } catch {
        // Silently tolerate app ping failure
      }
    }
  }

  // 2. Event Subscriptions

  // Event 1: page_viewed -> page_viewed
  analytics.subscribe("page_viewed", async (event) => {
    const currentUrl = event.context.document.location.href;
    const clickId = await resolveClickId(currentUrl);
    const payload = buildPageViewPayload(
      event.id,
      currentUrl,
      clickId,
      new Date(event.timestamp).getTime()
    );
    await dispatchOpenAIEvent(payload);
  });

  // Event 2: product_viewed -> contents_viewed
  analytics.subscribe("product_viewed", async (event) => {
    const currentUrl = event.context.document.location.href;
    const clickId = await resolveClickId(currentUrl);
    const payload = buildProductViewPayload(
      event.id,
      currentUrl,
      event.data.productVariant,
      clickId,
      new Date(event.timestamp).getTime()
    );
    await dispatchOpenAIEvent(payload);
  });

  // Event 3: product_added_to_cart -> items_added
  analytics.subscribe("product_added_to_cart", async (event) => {
    const currentUrl = event.context.document.location.href;
    const clickId = await resolveClickId(currentUrl);
    const payload = buildAddToCartPayload(
      event.id,
      currentUrl,
      event.data.cartLine,
      clickId,
      new Date(event.timestamp).getTime()
    );
    await dispatchOpenAIEvent(payload);
  });

  // Event 4: checkout_started -> checkout_started
  analytics.subscribe("checkout_started", async (event) => {
    const currentUrl = event.context.document.location.href;
    const clickId = await resolveClickId(currentUrl);
    const payload = buildCheckoutStartedPayload(
      event.id,
      currentUrl,
      event.data.checkout,
      clickId,
      new Date(event.timestamp).getTime()
    );
    await dispatchOpenAIEvent(payload);
  });

  // Event 5: checkout_completed -> order_created
  // CRITICAL: Sets event_id to Shopify Order ID for CAPI deduplication
  analytics.subscribe("checkout_completed", async (event) => {
    const currentUrl = event.context.document.location.href;
    const clickId = await resolveClickId(currentUrl);
    const payload = buildOrderCreatedPayload(
      event.id,
      currentUrl,
      event.data.checkout,
      clickId,
      new Date(event.timestamp).getTime()
    );
    await dispatchOpenAIEvent(payload);
  });
});
