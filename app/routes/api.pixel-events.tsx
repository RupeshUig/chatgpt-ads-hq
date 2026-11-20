import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server.ts";
import { logger } from "../lib/logger.server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders });
  }

  try {
    const body = (await request.json()) as {
      pixelId?: string;
      eventName?: string;
      eventId?: string;
      clickId?: string | null;
    };

    const pixelId = body.pixelId?.trim();
    const eventName = body.eventName?.trim() || "page_viewed";
    const eventId = body.eventId?.trim() || `evt_${Date.now()}`;
    const hasClickId = Boolean(body.clickId?.trim());

    if (!pixelId) {
      return new Response(JSON.stringify({ error: "Missing pixelId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Find the shop associated with this pixelId
    const connection = await db.adsConnection.findFirst({
      where: { pixelId },
    });

    if (!connection) {
      return new Response(JSON.stringify({ error: "Pixel ID not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Record the event in ConversionSendLog (Zero customer PII)
    await db.conversionSendLog.create({
      data: {
        shopId: connection.shopId,
        eventId,
        eventName,
        status: "SUCCESS",
        hasClickId,
        sentAt: new Date(),
      },
    });

    logger.info("Recorded storefront pixel event", {
      shopId: connection.shopId,
      eventName,
      eventId,
      hasClickId,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: unknown) {
    logger.error("Failed to log storefront pixel event", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
