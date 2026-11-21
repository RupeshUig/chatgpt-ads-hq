import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toMinorBigInt,
  fromMinorBigInt,
  roundHalfAwayFromZero,
  roundHalfAwayFromZeroInt,
  calcBasisPoints,
  calcPaymentFee,
  allocateProportional,
} from "./money.server.ts";

describe("Money & Rounding Helpers (BigInt Integer-Safe)", () => {
  describe("toMinorBigInt() & fromMinorBigInt()", () => {
    it("converts safe integer numbers cleanly to BigInt", () => {
      assert.equal(toMinorBigInt(100), 100n);
      assert.equal(toMinorBigInt(0), 0n);
      assert.equal(toMinorBigInt(-500), -500n);
    });

    it("accepts BigInt directly without modification", () => {
      assert.equal(toMinorBigInt(100n), 100n);
      assert.equal(toMinorBigInt(-500n), -500n);
    });

    it("throws RangeError on non-integer float (e.g. 10.5 throws)", () => {
      assert.throws(() => toMinorBigInt(10.5), {
        name: "RangeError",
        message: /decimal float 10.5 is not allowed/,
      });
      assert.throws(() => toMinorBigInt(0.1), RangeError);
      assert.throws(() => toMinorBigInt(-19.99), RangeError);
    });

    it("throws RangeError on unsafe integer numbers exceeding safe range", () => {
      const unsafeInt = Number.MAX_SAFE_INTEGER + 10;
      assert.throws(() => toMinorBigInt(unsafeInt), {
        name: "RangeError",
        message: /exceeds safe integer range/,
      });
    });

    it("fromMinorBigInt converts BigInt to number safely", () => {
      assert.equal(fromMinorBigInt(5000n), 5000);
      assert.equal(fromMinorBigInt(0n), 0);
      assert.equal(fromMinorBigInt(-100n), -100);
    });

    it("fromMinorBigInt throws RangeError if BigInt exceeds Number safe integer range", () => {
      const hugeBigInt = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
      assert.throws(() => fromMinorBigInt(hugeBigInt), {
        name: "RangeError",
        message: /exceeds JavaScript Number.isSafeInteger range/,
      });
    });
  });

  describe("calcBasisPoints() validation", () => {
    it("throws RangeError on negative bps", () => {
      assert.throws(() => calcBasisPoints(1000, -50), {
        name: "RangeError",
        message: /Basis points cannot be negative/,
      });
    });
  });
  describe("roundHalfAwayFromZero()", () => {
    it("rounds exact halves away from zero for positive numbers", () => {
      // 1.5 -> 2, 2.5 -> 3, 0.5 -> 1
      assert.equal(roundHalfAwayFromZero(3n, 2n), 2n);
      assert.equal(roundHalfAwayFromZero(5n, 2n), 3n);
      assert.equal(roundHalfAwayFromZero(1n, 2n), 1n);
      assert.equal(roundHalfAwayFromZero(7n, 2n), 4n);
    });

    it("rounds exact halves away from zero for negative numbers", () => {
      // -1.5 -> -2, -2.5 -> -3, -0.5 -> -1
      assert.equal(roundHalfAwayFromZero(-3n, 2n), -2n);
      assert.equal(roundHalfAwayFromZero(-5n, 2n), -3n);
      assert.equal(roundHalfAwayFromZero(-1n, 2n), -1n);
      assert.equal(roundHalfAwayFromZero(-7n, 2n), -4n);
    });

    it("rounds values below half down towards zero", () => {
      // 1.4 -> 1, 1.2 -> 1, -1.4 -> -1
      assert.equal(roundHalfAwayFromZero(14n, 10n), 1n);
      assert.equal(roundHalfAwayFromZero(12n, 10n), 1n);
      assert.equal(roundHalfAwayFromZero(-14n, 10n), -1n);
      assert.equal(roundHalfAwayFromZero(-12n, 10n), -1n);
    });

    it("rounds values above half up away from zero", () => {
      // 1.6 -> 2, 1.8 -> 2, -1.6 -> -2
      assert.equal(roundHalfAwayFromZero(16n, 10n), 2n);
      assert.equal(roundHalfAwayFromZero(18n, 10n), 2n);
      assert.equal(roundHalfAwayFromZero(-16n, 10n), -2n);
      assert.equal(roundHalfAwayFromZero(-18n, 10n), -2n);
    });

    it("handles zero numerator correctly", () => {
      assert.equal(roundHalfAwayFromZero(0n, 10n), 0n);
      assert.equal(roundHalfAwayFromZero(-0n, 10n), 0n);
    });

    it("handles negative denominator correctly", () => {
      // 3 / -2 = -1.5 -> -2
      assert.equal(roundHalfAwayFromZero(3n, -2n), -2n);
      // -3 / -2 = 1.5 -> 2
      assert.equal(roundHalfAwayFromZero(-3n, -2n), 2n);
    });

    it("throws RangeError on division by zero", () => {
      assert.throws(() => roundHalfAwayFromZero(10n, 0n), RangeError);
    });

    it("roundHalfAwayFromZeroInt converts numbers cleanly", () => {
      assert.equal(roundHalfAwayFromZeroInt(5, 2), 3);
      assert.equal(roundHalfAwayFromZeroInt(-5, 2), -3);
    });
  });

  describe("Real IEEE 754 Floating-Point Traps (Test 18)", () => {
    it("beats floating-point trap on fee calculation: 3000 * 0.0045 (45 bps)", () => {
      // Amount = $30.00 (3000 cents), Fee = 0.45% (45 bps)
      // Mathematical exact value: 3000 * 0.0045 = 13.5 cents -> rounds to 14 cents
      const floatResult = 3000 * 0.0045; // 13.499999999999998 in IEEE 754
      const floatRounded = Math.round(floatResult); // INCORRECTLY rounds down to 13!

      assert.equal(floatResult < 13.5, true); // Proves float representation failure
      assert.equal(floatRounded, 13); // Proves standard Math.round fails

      // BigInt implementation gives exact, mathematically correct result:
      const safeResult = calcBasisPoints(3000, 45);
      assert.equal(safeResult, 14); // Exactly 14 cents!
    });

    it("beats floating-point trap on 2.2% fee tier: 5750 * 0.022 (220 bps)", () => {
      // Amount = $57.50 (5750 cents), Fee = 2.2% (220 bps)
      // Mathematical exact value: 5750 * 0.022 = 126.5 cents -> rounds to 127 cents
      const floatResult = 5750 * 0.022; // 126.49999999999999 in IEEE 754
      const floatRounded = Math.round(floatResult); // INCORRECTLY rounds down to 126!

      assert.equal(floatResult < 126.5, true); // Proves float representation failure
      assert.equal(floatRounded, 126); // Proves standard Math.round fails

      // BigInt implementation gives exact, mathematically correct result:
      const safeResult = calcBasisPoints(5750, 220);
      assert.equal(safeResult, 127); // Exactly 127 cents!
    });
  });

  describe("calcPaymentFee()", () => {
    it("calculates standard 2.9% + 30¢ payment fee correctly", () => {
      // $100 order (10000 cents) -> 10000 * 290 / 10000 = 290 + 30 = 320 cents ($3.20)
      const fee = calcPaymentFee(10000, 290, 30);
      assert.equal(fee, 320);
    });

    it("returns strictly 0 when total charged is 0 (Test 6 promo order rule)", () => {
      // When $0 is charged at checkout, no percentage fee AND no fixed fee is assessed
      const feeZero = calcPaymentFee(0, 290, 30);
      assert.equal(feeZero, 0);

      const feeNegative = calcPaymentFee(-500, 290, 30);
      assert.equal(feeNegative, 0);
    });

    it("calculates fee on total charged including tax ($110 charged in Test 2)", () => {
      // $110.00 charged (11000 cents) -> 11000 * 290 / 10000 = 319 + 30 = 349 cents ($3.49)
      const fee = calcPaymentFee(11000, 290, 30);
      assert.equal(fee, 349);
    });
  });

  describe("allocateProportional()", () => {
    it("allocates overhead proportionally across items and sums to total exactly", () => {
      // Total overhead = 820 cents (Shipping 500¢ + Fee 320¢)
      // Product A share = $60 (6000), Product B share = $40 (4000)
      const [overheadA, overheadB] = allocateProportional(820, [6000, 4000]);

      // A: 820 * 60 / 100 = 492
      // B: 820 * 40 / 100 = 328
      assert.equal(overheadA, 492);
      assert.equal(overheadB, 328);
      assert.equal(overheadA + overheadB, 820);
    });

    it("adjusts remainder cents to the largest item when division is uneven", () => {
      // Total overhead = 100 cents across 3 equal items (33.333... each)
      // Largest item receives remainder so total is 100
      const allocated = allocateProportional(100, [3333, 3333, 3334]);
      const sum = allocated.reduce((a, b) => a + b, 0);
      assert.equal(sum, 100);
      // Third item had largest share (3334)
      assert.equal(allocated[2], 34);
      assert.equal(allocated[0], 33);
      assert.equal(allocated[1], 33);
    });

    it("allocates overhead evenly when total order revenue is $0 (Test 7 promo)", () => {
      // 2 free items ($0 revenue each), total overhead = 500 cents
      const allocated = allocateProportional(500, [0, 0]);
      assert.equal(allocated.length, 2);
      assert.equal(allocated[0], 250);
      assert.equal(allocated[1], 250);
      assert.equal(allocated[0] + allocated[1], 500);
    });

    it("allocates odd remainder to the first item when total order revenue is $0", () => {
      // 3 free items ($0 revenue each), total overhead = 500 cents
      // 500 / 3 = 166 base, remainder 2 -> item 0 receives 166 + 2 = 168
      const allocated = allocateProportional(500, [0, 0, 0]);
      assert.equal(allocated[0], 168);
      assert.equal(allocated[1], 166);
      assert.equal(allocated[2], 166);
      assert.equal(allocated[0] + allocated[1] + allocated[2], 500);
    });

    it("handles negative net overhead allocation (customer shipping > expenses)", () => {
      // Suppose shipping charged ($5.00) exceeds expenses by 200 cents -> net overhead = -200
      const [negA, negB] = allocateProportional(-200, [6000, 4000]);
      assert.equal(negA, -120);
      assert.equal(negB, -80);
      assert.equal(negA + negB, -200);
    });

    it("throws RangeError on empty shares array", () => {
      assert.throws(() => allocateProportional(500, []), {
        name: "RangeError",
        message: /Shares array cannot be empty/,
      });
    });

    it("throws RangeError on negative weights/shares", () => {
      assert.throws(() => allocateProportional(500, [100, -20, 50]), {
        name: "RangeError",
        message: /Weights\/shares cannot be negative/,
      });
    });

    it("breaks ties deterministically by giving remainder cent to lowest index", () => {
      // 2 identical items with share 100 each. Total overhead = 1 cent.
      // 1 cent cannot divide evenly between two 50% shares.
      // Remainder cent must go to lowest index (index 0), giving [1, 0] instead of [0, 1].
      const allocated = allocateProportional(1, [100, 100]);
      assert.deepEqual(allocated, [1, 0]);

      // 3 identical items with share 100 each. Total overhead = 1 cent -> [1, 0, 0].
      const allocated3 = allocateProportional(1, [100, 100, 100]);
      assert.deepEqual(allocated3, [1, 0, 0]);

      // 3 identical items with share 100 each. Total overhead = 2 cents -> [1, 1, 0].
      // Both remainder cents go to the lowest indices (0 and 1)
      const allocated3Two = allocateProportional(2, [100, 100, 100]);
      assert.equal(allocated3Two.reduce((a, b) => a + b, 0), 2);
      assert.equal(allocated3Two[0], 1);
    });
  });
});
