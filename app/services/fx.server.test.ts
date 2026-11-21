import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertCurrency,
  ECB_CURRENCY_EXPONENTS,
  UNSUPPORTED_CURRENCY_WARNING,
} from "./fx.server.ts";

describe("Foreign Exchange (FX) Math & ECB Rate Conversion", () => {
  const mockEcbRates = {
    USD: "1.085000",
    JPY: "168.650000",
    GBP: "0.854000",
    CAD: "1.472000",
  };

  it("returns unconverted amount when fromCurrency equals toCurrency", () => {
    const result = convertCurrency({
      amountMinor: 5000,
      fromCurrency: "USD",
      toCurrency: "USD",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 5000);
    assert.equal(result.isConverted, false);
    assert.equal(result.effectiveRate, "1.000000");
    assert.equal(result.warning, undefined);
  });

  it("Test 16: EUR to USD direct conversion", () => {
    // 10,000 EUR cents (€100.00) at 1.085000 -> 10,850 USD cents ($108.50)
    const result = convertCurrency({
      amountMinor: 10000,
      fromCurrency: "EUR",
      toCurrency: "USD",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 10850);
    assert.equal(result.isConverted, true);
    assert.equal(result.fromCurrency, "EUR");
    assert.equal(result.toCurrency, "USD");
    assert.equal(result.effectiveRate, "1.085000");
    assert.equal(result.uiNote, "Ad spend converted from EUR at ECB daily rates");
  });

  it("Test 17: JPY to USD cross-rate path with exponent scaling (0 to 2 decimals)", () => {
    // JPY has exponent 0 (¥15,545 whole units). USD has exponent 2 (cents).
    // EUR/USD = 1.085000, EUR/JPY = 168.650000
    // Cross rate = 1.085000 / 168.650000 ≈ 0.006433442
    // 15,545 * (1.085000 / 168.650000) * 10^(2 - 0) = 15,545 * 0.6433442... = 10,000.785...
    // roundHalfAwayFromZero -> 10,001 USD cents ($100.01)
    const result = convertCurrency({
      amountMinor: 15545,
      fromCurrency: "JPY",
      toCurrency: "USD",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 10001);
    assert.equal(result.isConverted, true);
    assert.equal(result.fromCurrency, "JPY");
    assert.equal(result.toCurrency, "USD");
    assert.equal(result.uiNote, "Ad spend converted from JPY at ECB daily rates");
  });

  it("USD to JPY cross-rate path with exponent scaling (2 to 0 decimals)", () => {
    // USD has exponent 2 (10,000 cents = $100.00). JPY has exponent 0 (whole units).
    // 10,000 * (168.650000 / 1.085000) * 10^(0 - 2) = 100 * 155.437788... = 15,543.7788...
    // roundHalfAwayFromZero -> 15,544 JPY
    const result = convertCurrency({
      amountMinor: 10000,
      fromCurrency: "USD",
      toCurrency: "JPY",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 15544);
    assert.equal(result.isConverted, true);
  });

  it("Test 19: returns unconverted with UNSUPPORTED_CURRENCY warning for non-ECB currency", () => {
    // KWD is not in ECB reference rate list
    const result = convertCurrency({
      amountMinor: 50000,
      fromCurrency: "KWD",
      toCurrency: "USD",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 50000);
    assert.equal(result.isConverted, false);
    assert.equal(result.warning, UNSUPPORTED_CURRENCY_WARNING);
  });

  it("returns unconverted with UNSUPPORTED_CURRENCY warning when quote is not in ECB list", () => {
    const result = convertCurrency({
      amountMinor: 5000,
      fromCurrency: "USD",
      toCurrency: "XYZ",
      rates: mockEcbRates,
    });

    assert.equal(result.convertedMinor, 5000);
    assert.equal(result.isConverted, false);
    assert.equal(result.warning, UNSUPPORTED_CURRENCY_WARNING);
  });

  it("returns unconverted with UNSUPPORTED_CURRENCY warning when rate is missing from map", () => {
    const incompleteRates = { USD: "1.085000" }; // Missing JPY
    const result = convertCurrency({
      amountMinor: 5000,
      fromCurrency: "JPY",
      toCurrency: "USD",
      rates: incompleteRates,
    });

    assert.equal(result.convertedMinor, 5000);
    assert.equal(result.isConverted, false);
    assert.equal(result.warning, UNSUPPORTED_CURRENCY_WARNING);
  });

  it("validates ECB currency exponents list contains major currencies with correct exponents", () => {
    assert.equal(ECB_CURRENCY_EXPONENTS.EUR, 2);
    assert.equal(ECB_CURRENCY_EXPONENTS.USD, 2);
    assert.equal(ECB_CURRENCY_EXPONENTS.JPY, 0);
    assert.equal(ECB_CURRENCY_EXPONENTS.KRW, 0);
    assert.equal(ECB_CURRENCY_EXPONENTS.GBP, 2);
    assert.equal(ECB_CURRENCY_EXPONENTS.CAD, 2);
  });
});
