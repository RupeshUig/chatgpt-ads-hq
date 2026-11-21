import db from "../db.server.ts";
import { logger } from "../lib/logger.server.ts";
import { ECB_CURRENCY_EXPONENTS } from "../services/fx.server.ts";

/**
 * Worker job: fetches daily ECB reference rates from the Frankfurter API (frankfurter.app)
 * and stores them in the ExchangeRate table.
 * For weekends and holidays, Frankfurter automatically serves the most recent trading day rate.
 */
export async function fetchAndStoreDailyFxRates(targetDate?: string): Promise<{
  success: boolean;
  ratesCount: number;
  date: string;
  error?: string;
}> {
  const url = targetDate
    ? `https://api.frankfurter.app/${targetDate}`
    : "https://api.frankfurter.app/latest";

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.error("Frankfurter API returned non-200 status", { status: res.status });
      return { success: false, ratesCount: 0, date: targetDate || "", error: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      amount?: number;
      base?: string;
      date?: string;
      rates?: Record<string, number>;
    };

    const effectiveDateStr = json.date || new Date().toISOString().slice(0, 10);
    const dateObj = new Date(`${effectiveDateStr}T00:00:00.000Z`);
    const ratesMap = json.rates || {};

    let storedCount = 0;

    // Filter strictly to official ECB reference currencies
    for (const [quote, rateNum] of Object.entries(ratesMap)) {
      const quoteUpper = quote.toUpperCase();
      if (ECB_CURRENCY_EXPONENTS[quoteUpper] !== undefined && typeof rateNum === "number") {
        const rateDecimalStr = rateNum.toFixed(6);

        await db.exchangeRate.upsert({
          where: {
            date_base_quote: {
              date: dateObj,
              base: "EUR",
              quote: quoteUpper,
            },
          },
          update: {
            rate: rateDecimalStr,
          },
          create: {
            date: dateObj,
            base: "EUR",
            quote: quoteUpper,
            rate: rateDecimalStr,
          },
        });
        storedCount++;
      }
    }

    logger.info("Successfully fetched and stored daily ECB exchange rates", {
      date: effectiveDateStr,
      storedCount,
    });

    return {
      success: true,
      ratesCount: storedCount,
      date: effectiveDateStr,
    };
  } catch (err) {
    logger.error("Failed to fetch daily exchange rates from Frankfurter", { error: String(err) });
    return {
      success: false,
      ratesCount: 0,
      date: targetDate || "",
      error: String(err),
    };
  }
}
