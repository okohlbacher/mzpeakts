import { expect, test } from "vitest";
import {
  LinearGrid,
  SquareRootLinearGrid,
  BrukerTimsTOFTimsLinearGrid2,
  BrukerTimsTOFMzGrid2,
  gridFromParameters,
  type GridLike,
} from "../src/grid";

function linspace(low: number, high: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = low + ((high - low) * i) / (n - 1);
  }
  return out;
}

test("LinearGrid fits and round-trips within a small error", () => {
  const values = linspace(100, 2000, 5000);
  const grid = LinearGrid.fit(values, 100, 2000, 1.0);

  expect.assert(grid.accesion == "MS:1003824");
  expect.assert(grid.name == "linear grid interpolation");
  expect.assert(grid.scale == 1.0);

  const maxErr = grid.maxError(values);
  expect.assert(maxErr < 1e-3, `Expected a small max error, found ${maxErr}`);

  const mid = values[Math.floor(values.length / 2)];
  const index = grid.toIndex(mid);
  const back = grid.fromIndex(index);
  expect.assert(Math.abs(back - mid) < 1e-3, `Expected ${back} to be close to ${mid}`);
});

test("LinearGrid respects scale when fitting and converting", () => {
  const values = linspace(100, 2000, 1000);
  const scale = 1000.0;
  const grid = LinearGrid.fit(values, 100, 2000, scale);
  expect.assert(grid.scale == scale);

  const maxErr = grid.maxError(values);
  expect.assert(maxErr < 1e-3, `Expected a small max error, found ${maxErr}`);
});

test("SquareRootLinearGrid fits and round-trips within a small error", () => {
  const values = linspace(100, 2000, 5000);
  const grid = SquareRootLinearGrid.fit(values, 100, 2000, 1.0);

  expect.assert(grid.accesion == "MS:1003825");
  expect.assert(grid.name == "square root grid interpolation");

  const maxErr = grid.maxError(values);
  expect.assert(maxErr < 1e-3, `Expected a small max error, found ${maxErr}`);

  const mid = values[Math.floor(values.length / 2)];
  const back = grid.fromIndex(grid.toIndex(mid));
  expect.assert(Math.abs(back - mid) < 1e-3, `Expected ${back} to be close to ${mid}`);
});

test("LinearGrid parameters round-trip through toParameters/fromParameters", () => {
  const values = linspace(100, 2000, 500);
  const grid = LinearGrid.fit(values, 100, 2000, 2.0);
  const params = grid.toParameters();
  expect.assert(params.length == 3);

  const rebuilt = grid.fromParameters(grid.accesion, params) as LinearGrid;
  expect.assert(rebuilt.intercept == grid.intercept);
  expect.assert(rebuilt.slope == grid.slope);
  expect.assert(rebuilt.scale == grid.scale);
});

test("SquareRootLinearGrid parameters round-trip through toParameters/fromParameters", () => {
  const values = linspace(100, 2000, 500);
  const grid = SquareRootLinearGrid.fit(values, 100, 2000, 1.0);
  const params = grid.toParameters();

  const rebuilt = grid.fromParameters(grid.accesion, params) as SquareRootLinearGrid;
  expect.assert(rebuilt.intercept == grid.intercept);
  expect.assert(rebuilt.slope == grid.slope);
  expect.assert(rebuilt.scale == grid.scale);
});

// Fixture values taken from mzdata's own Rust unit test
// `test_im::scan2im_matches_fork_reference` in src/io/tdf/calibration.rs,
// which derives `offset`/`slope` from the raw TimsCalibration table row.
test("BrukerTimsTOFTimsLinearGrid2 matches the reference TIMS calibration", () => {
  const c0 = 1.0;
  const c1 = 708.0;
  const c2 = 241.751905250524;
  const c3 = 99.2437539638487;
  const c4 = 33.9622641509434;
  const c6 = 0.0071422641733084;
  const c7 = 164.998795925213;

  const slope = (c3 - c2) / c1;
  const offset = c2 - slope * (c4 + c0);
  const grid = new BrukerTimsTOFTimsLinearGrid2(c6, c7, offset, slope);

  expect.assert(grid.accesion == "MS:9999001");

  const im1 = grid.fromIndex(1);
  const im708 = grid.fromIndex(708);
  expect.assert(Math.abs(im1 - 1.45) < 5e-2, `im1 = ${im1}`);
  expect.assert(Math.abs(im708 - 0.64) < 5e-2, `im708 = ${im708}`);

  const back = grid.toIndex(im708);
  expect.assert(Math.abs(Number(back) - 708) <= 1, `round-trip index = ${back}`);
});

test("BrukerTimsTOFMzGrid2 matches the reference m/z calibration", () => {
  const digitizerTimebase = 0.125;
  const digitizerDelay = 25741.0;
  const rawC0 = 286.065160463331;
  const rawC1 = 154317.348188993;
  const rawC2 = 0;
  const rawC3 = 0;
  const rawC4 = 0;
  const dc1 = 20.0;
  const dc2 = 0;
  const t1 = 20.9410989491122;
  const t2 = 0.0;
  const realT1 = 20.9455139021767;
  const realT2 = 0.0;

  const cf = 1.0 + (dc1 * (t1 - realT1) + dc2 * (t2 - realT2)) / 1.0e6;
  const beta = Math.sqrt(1.0e12 / (rawC1 * cf));
  const c2 = rawC2 / cf;

  const grid = new BrukerTimsTOFMzGrid2(rawC0, beta, c2, rawC3, rawC4, digitizerTimebase, digitizerDelay);

  expect.assert(grid.accesion == "MS:9999002");

  const mz0 = grid.fromIndex(0);
  const mzMax = grid.fromIndex(636029);
  expect.assert(Math.abs(mz0 - 99.990834) < 1e-3, `mz0 = ${mz0}`);
  expect.assert(Math.abs(mzMax - 1700.005) < 1e-3, `mzMax = ${mzMax}`);

  const back = grid.toIndex(mzMax);
  expect.assert(Math.abs(Number(back) - 636029) <= 1, `round-trip index = ${back}`);
});

test("BrukerTimsTOFTimsLinearGrid2 parameters round-trip through gridFromParameters", () => {
  const grid = new BrukerTimsTOFTimsLinearGrid2(0.0071422641733084, 164.998795925213, -34.5, 0.19);
  const params = grid.toParameters();
  expect.assert(params.length == 4);

  const rebuilt = gridFromParameters(grid.accesion, params) as BrukerTimsTOFTimsLinearGrid2;
  expect.assert(rebuilt.c6 == grid.c6);
  expect.assert(rebuilt.c7 == grid.c7);
  expect.assert(rebuilt.offset == grid.offset);
  expect.assert(rebuilt.slope == grid.slope);
});

test("BrukerTimsTOFMzGrid2 parameters round-trip through gridFromParameters", () => {
  const grid = new BrukerTimsTOFMzGrid2(286.065160463331, 2544.529, 0, 0, 0, 0.125, 25741.0);
  const params = grid.toParameters();
  expect.assert(params.length == 7);

  const rebuilt = gridFromParameters(grid.accesion, params) as BrukerTimsTOFMzGrid2;
  expect.assert(rebuilt.c0 == grid.c0);
  expect.assert(rebuilt.beta == grid.beta);
  expect.assert(rebuilt.c2 == grid.c2);
  expect.assert(rebuilt.c3 == grid.c3);
  expect.assert(rebuilt.c4 == grid.c4);
  expect.assert(rebuilt.slope == grid.slope);
  expect.assert(rebuilt.intercept == grid.intercept);
});

test("gridFromParameters throws on an unknown accession", () => {
  let threw = false;
  try {
    gridFromParameters("MS:0000000", new Float64Array([1, 2, 3]));
  } catch (err) {
    threw = true;
  }
  expect.assert(threw, "Expected an unknown accession to throw");
});

test("all grid types satisfy the GridLike interface shape", () => {
  const grids: GridLike[] = [
    new LinearGrid(0, 1, 1),
    new SquareRootLinearGrid(0, 1, 1),
    new BrukerTimsTOFTimsLinearGrid2(0.007, 165, -34.5, 0.19),
    new BrukerTimsTOFMzGrid2(286, 2544, 0, 0, 0, 0.125, 25741),
  ];
  for (const grid of grids) {
    expect.assert(typeof grid.accesion == "string");
    expect.assert(typeof grid.name == "string");
    expect.assert(grid.toParameters() instanceof Float64Array);
  }
});
