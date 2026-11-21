import { roundHalfAwayFromZero } from "./profit/money.server.ts";

/**
 * Official European Central Bank (ECB) reference rate currencies with explicit ISO 4217 exponents.
 * Only currencies published in the ECB reference rate list are supported for conversion.
 * Any other currency is treated as unsupported.
 */
export const ECB_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  EUR: 2, // Base
  USD: 2, // US Dollar
  JPY: 0, // Japanese Yen
  BGN: 2, // Bulgarian Lev
  CZK: 2, // Czech Koruna
  DKK: 2, // Danish Krone
  GBP: 2, // Pound Sterling
  HUF: 2, // Hungarian Forint
  PLN: 2, // Polish Zloty
  RON: 2, // Romanian Leu
  SEK: 2, // Swedish Krona
  CHF: 2, // Swiss Franc
  ISK: 0, // Icelandic Krona
  NOK: 2, // Norwegian Krone
  TRY: 2, // Turkish Lira
  AUD: 2, // Australian Dollar
  BRL: 2, // Brazilian Real
  CAD: 2, // Canadian Dollar
  CNY: 2, // Chinese Yuan
  HKD: 2, // Hong Kong Dollar
  IDR: 2, // Indonesian Rupiah
  ILS: 2, // Israeli Shekel
  INR: 2, // Indian Rupee
  KRW: 0, // South Korean Won
  MXN: 2, // Mexican Peso
  MYR: 2, // Malaysian Ringgit
  NZD: 2, // New Zealand Dollar
  PHP: 2, // Philippine Peso
  SGD: 2, // Singapore Dollar
  THB: 2, // Thai Baht
  ZAR: 2, // South African Rand
};

export const UNSUPPORTED_CURRENCY_WARNING = "UNSUPPORTED_CURRENCY";

export interface FxConvertOptions {
  amountMinor: number;
  fromCurrency: string;
  toCurrency: string;
  /**
   * EUR-based reference rates map, e.g. { USD: "1.085000", JPY: "168.650000" }.
   * Rate represents units of quote currency per 1 EUR.
   */
  rates: Record<string, string>;
  date?: string;
}

export interface FxConvertResult {
  convertedMinor: number;
  isConverted: boolean;
  fromCurrency: string;
  toCurrency: string;
  effectiveRate: string | null;
  warning?: string;
  reason?: string;
  uiNote?: string;
}

/**
 * Converts a decimal string into a high-precision scaled BigInt with 18 decimal places.
 * Example: "1.085" -> 1085000000000000000n
 */
function parseDecimalToScaledBigInt(decimalStr: string, scale: number = 18): bigint {
  const parts = decimalStr.trim().split(".");
  const integerPart = parts[0] || "0";
  const fractionalPart = (parts[1] || "").padEnd(scale, "0").slice(0, scale);
  const sign = integerPart.startsWith("-") ? -1n : 1n;
  const cleanInt = integerPart.replace("-", "");
  return sign * (BigInt(cleanInt + fractionalPart));
}

/**
 * Pure function: converts an ad spend amount between currencies using ECB EUR-based reference rates.
 * - Handles direct EUR conversions and non-EUR cross-rates (Cross Rate = QuoteRate / BaseRate).
 * - Applies ISO 4217 minor-unit exponent scaling (e.g. JPY = 0, USD = 2).
 * - Uses exact integer math with full precision and rounds half away from zero once at the end.
 * - Returns unconverted amount with warning if currency is not in official ECB list.
 */
export function convertCurrency(options: FxConvertOptions): FxConvertResult {
  const from = options.fromCurrency.trim().toUpperCase();
  const to = options.toCurrency.trim().toUpperCase();
  const amount = Math.trunc(options.amountMinor || 0);

  // 1. Same currency: zero conversion needed
  if (from === to) {
    return {
      convertedMinor: amount,
      isConverted: false,
      fromCurrency: from,
      toCurrency: to,
      effectiveRate: "1.000000",
    };
  }

  // 2. Validate both currencies are in the official ECB reference rate list
  const fromExp = ECB_CURRENCY_EXPONENTS[from];
  const toExp = ECB_CURRENCY_EXPONENTS[to];

  if (fromExp === undefined || toExp === undefined) {
    return {
      convertedMinor: amount,
      isConverted: false,
      fromCurrency: from,
      toCurrency: to,
      effectiveRate: null,
      warning: UNSUPPORTED_CURRENCY_WARNING,
      reason: UNSUPPORTED_CURRENCY_WARNING,
    };
  }

  // 3. Resolve EUR-based rates
  const fromRateStr = from === "EUR" ? "1.0" : options.rates[from];
  const toRateStr = to === "EUR" ? "1.0" : options.rates[to];

  if (!fromRateStr || !toRateStr) {
    return {
      convertedMinor: amount,
      isConverted: false,
      fromCurrency: from,
      toCurrency: to,
      effectiveRate: null,
      warning: UNSUPPORTED_CURRENCY_WARNING,
      reason: UNSUPPORTED_CURRENCY_WARNING,
    };
  }

  // 4. Calculate cross-rate using 18-decimal high-precision scaled BigInts:
  // Converted = roundHalfAwayFromZero(Amount * ToRate / FromRate * 10^(toExp - fromExp))
  const SCALE = 18;
  const toRateScaled = parseDecimalToScaledBigInt(toRateStr, SCALE);
  const fromRateScaled = parseDecimalToScaledBigInt(fromRateStr, SCALE);

  const expDiff = toExp - fromExp;
  const expFactorNum = expDiff >= 0 ? 10n ** BigInt(expDiff) : 1n;
  const expFactorDen = expDiff < 0 ? 10n ** BigInt(-expDiff) : 1n;

  const numerator = BigInt(amount) * toRateScaled * expFactorNum;
  const denominator = fromRateScaled * expFactorDen;

  const converted = Number(roundHalfAwayFromZero(numerator, denominator));

  // Effective rate string (with 6 decimal places for display)
  const rateScaled6 = (toRateScaled * 1000000n) / fromRateScaled;
  const rateStr = (Number(rateScaled6) / 1000000).toFixed(6);

  const uiNote = `Ad spend converted from ${from} at ECB daily rates`;

  return {
    convertedMinor: converted,
    isConverted: true,
    fromCurrency: from,
    toCurrency: to,
    effectiveRate: rateStr,
    uiNote,
  };
}
