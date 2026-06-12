import { expect, test } from "vitest";
import {
  encodeLinear,
  decodeLinear,
  optimalLinearFixedPoint,
  NativeAppender,
} from "../src/numpress";

/**
 * Regression test for Numpress Linear decoding at high m/z.
 *
 * The reference ProteoWizard C decoder accumulates the reconstructed integers
 * in 64-bit (`long long`). The reconstructed value is `mz * fixedPoint`; with
 * the auto-selected fixed point (~2^31 / lowest m/z second-difference) the
 * high-m/z points exceed 2^31. A 32-bit `| 0` truncation wraps those to large
 * NEGATIVE integers, producing negative m/z. These tests pin the full-precision
 * (64-bit-parity) behaviour: an encode→decode round-trip must recover the
 * original m/z values, and every decoded value must stay positive.
 */

function makeMz(n: number, start: number, step: number): Float64Array {
  // A near-linear ascending m/z axis with a small curvature term, so the
  // second differences are non-trivial (exercises encodeInt) while the values
  // climb high enough to push mz*fixedPoint past 2^31.
  const mz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mz[i] = start + i * step + Math.sin(i / 17) * 0.001;
  }
  return mz;
}

test("numpress linear round-trips high m/z without negative wrap (64-bit parity)", () => {
  // 200 → ~1800 m/z: realistic profile axis that overflows 32 bits once scaled.
  const mz = makeMz(800, 200, 2.0);
  const n = mz.length;

  const fixedPoint = optimalLinearFixedPoint(mz, n);

  // Self-document that this test actually exercises the >2^31 regime that the
  // old `| 0` truncation corrupted. If this ever stops holding, the test is no
  // longer guarding the bug it was written for.
  const maxScaled = mz[n - 1] * fixedPoint;
  expect.assert(
    maxScaled > 0x7fffffff,
    `test must exercise the >2^31 regime; max scaled value was ${maxScaled}`,
  );

  // Encode, then decode through the public Appender path.
  const encoded = new Uint8Array(n * 5 + 16);
  const byteLen = encodeLinear(mz, n, encoded, fixedPoint);
  const appender = new NativeAppender();
  decodeLinear(encoded.subarray(0, byteLen), byteLen, appender);
  const decoded = appender.build();

  expect.assert(
    decoded.length === n,
    `expected ${n} decoded values, got ${decoded.length}`,
  );

  // No negative m/z (the symptom of the 32-bit wrap) and round-trip fidelity
  // to within one fixed-point quantum.
  const tol = 2 / fixedPoint;
  for (let i = 0; i < n; i++) {
    expect.assert(decoded[i] > 0, `decoded[${i}] = ${decoded[i]} is not positive`);
    expect.assert(
      Math.abs(decoded[i] - mz[i]) <= tol,
      `decoded[${i}] = ${decoded[i]} drifted from ${mz[i]} (tol ${tol})`,
    );
  }

  // m/z axis stays monotonically non-decreasing after the round-trip.
  for (let i = 1; i < n; i++) {
    expect.assert(
      decoded[i] >= decoded[i - 1],
      `decoded axis not ascending at ${i}: ${decoded[i]} < ${decoded[i - 1]}`,
    );
  }
});

test("numpress linear round-trips a short low-m/z array", () => {
  const mz = Float64Array.from([100.0, 100.5, 101.0, 101.5, 102.0]);
  const n = mz.length;
  const fixedPoint = optimalLinearFixedPoint(mz, n);

  const encoded = new Uint8Array(n * 5 + 16);
  const byteLen = encodeLinear(mz, n, encoded, fixedPoint);
  const appender = new NativeAppender();
  decodeLinear(encoded.subarray(0, byteLen), byteLen, appender);
  const decoded = appender.build();

  expect.assert(decoded.length === n);
  const tol = 2 / fixedPoint;
  for (let i = 0; i < n; i++) {
    expect.assert(decoded[i] > 0);
    expect.assert(Math.abs(decoded[i] - mz[i]) <= tol);
  }
});
