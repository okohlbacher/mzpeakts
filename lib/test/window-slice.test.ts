// Regression guards for the sorted-window primitives (adversarial review 2026-09-01).
// The old binarySearchNearest computed FRACTIONAL mids, never advanced its bounds, and
// returned a bare falsy 0; betweenSorted used "nearest" indices with an exclusive end —
// so a centroid at exactly 150.0 with window [149.9, 150.1] sliced to [0, 0]: every
// narrow XIC/DIA m/z window came back EMPTY. binarySearchAll additionally dropped the
// terminal group (the LAST spectrum's scans/precursors) via a conditional ++hi.
import { expect, test } from "vitest";
import * as Arrow from "apache-arrow";
import { betweenSorted, binarySearchNearest, binarySearchAll } from "../src/utils";

const vec = (xs: number[]) => Arrow.vectorFromArray(xs, new Arrow.Float64());
const big = (xs: number[]) => Arrow.vectorFromArray(xs.map(BigInt), new Arrow.Uint64());

test("betweenSorted: closed window includes exact boundary matches", () => {
  const mz = vec([150, 225, 300, 375, 450]);
  expect(betweenSorted(mz, 149.9, 150.1)).toEqual([0, 1]); // THE bug: was [0,0] → empty
  expect(betweenSorted(mz, 150, 150)).toEqual([0, 1]); // degenerate closed window
  expect(betweenSorted(mz, 100, 500)).toEqual([0, 5]); // whole vector
  expect(betweenSorted(mz, 200, 400)).toEqual([1, 4]); // interior
  expect(betweenSorted(mz, 440, 460)).toEqual([4, 5]); // terminal element reachable
  expect(betweenSorted(mz, 151, 224)).toBeNull(); // genuinely empty gap
  expect(betweenSorted(mz, 500, 600)).toBeNull(); // fully above
  expect(betweenSorted(mz, 0, 100)).toBeNull(); // fully below — nearest-based code returned [0,..]
});

test("betweenSorted: does not widen the window to out-of-range neighbors", () => {
  const mz = vec([100, 150, 200]);
  // start=151: nearest is 150 (below the window) — must NOT be included.
  expect(betweenSorted(mz, 151, 210)).toEqual([2, 3]);
});

test("binarySearchNearest: integer indices, converges, index 0 is a real result", () => {
  const mz = vec([10, 20, 30, 40, 50]);
  expect(binarySearchNearest(mz, 9)).toEqual([0, 1]); // index 0 + error — was a falsy bare 0
  expect(binarySearchNearest(mz, 31)?.[0]).toBe(2);
  expect(binarySearchNearest(mz, 55)?.[0]).toBe(4); // end-inclusive (old linear fallback excluded it)
  expect(binarySearchNearest(vec([]), 1)).toBeNull();
});

test("binarySearchAll: terminal group returns an EXCLUSIVE end (last spectrum keeps its rows)", () => {
  const idx = big([0, 0, 1, 2, 2]);
  expect(binarySearchAll(idx, 0n)).toEqual([0, 2]);
  expect(binarySearchAll(idx, 1n)).toEqual([2, 3]);
  expect(binarySearchAll(idx, 2n)).toEqual([3, 5]); // was [3,4] → slice dropped the final row
  expect(binarySearchAll(idx, 7n)).toBeNull();
});
