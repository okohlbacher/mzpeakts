// Regression guard for the page-offset math (findPageFor / findPageForRange) across a
// ROW-GROUP BOUNDARY, where start_row RESETS per row group. findPageFor previously computed
// its limit from the NEXT page's start_row, which goes NEGATIVE at a boundary ("expected
// usize"); findPageForRange sums each page's OWN (end_row - start_row) and must stay
// positive + cover the whole requested range. These tests pin both with a synthetic page
// index — no WASM/fixture needed.
import { expect, test } from "vitest";
import { DataArraysReaderMeta } from "../src/data";

// Two row groups, two pages each. start_row/end_row RESET per row group (rg1 restarts at 0)
// — the exact shape that produced the negative limit.
//   rg0: pageA idx[0..49]  rows[0..50)   pageB idx[50..99]  rows[50..100)
//   rg1: pageC idx[100..149] rows[0..50) pageD idx[150..199] rows[50..100)
const PAGES = [
  { min: 0n, max: 49n, start_row: 0, end_row: 50, null_count: 0, row_group_index: 0 },
  { min: 50n, max: 99n, start_row: 50, end_row: 100, null_count: 0, row_group_index: 0 },
  { min: 100n, max: 149n, start_row: 0, end_row: 50, null_count: 0, row_group_index: 1 },
  { min: 150n, max: 199n, start_row: 50, end_row: 100, null_count: 0, row_group_index: 1 },
];

function metaWithPages(): DataArraysReaderMeta {
  // findPageFor / findPageForRange only touch this.pageKeyIndex; the rest is unused here.
  return new DataArraysReaderMeta(
    null as any,
    null as any,
    null as any,
    null as any,
    null,
    PAGES as any,
  );
}

test("findPageFor: index in the SECOND row group yields a POSITIVE limit (the regression)", () => {
  const meta = metaWithPages();
  // index 160 lives in pageD (rg1, start_row reset to 50). The old code did
  // nextPage.start_row - start (→ negative); the fix uses the page's own end_row.
  const r = meta.findPageFor(160n);
  expect(r).not.toBeNull();
  expect(r!.offset).toBe(50);
  expect(r!.limit).toBe(50); // end_row(100) - start_row(50)
  expect(r!.limit!).toBeGreaterThan(0);
});

test("findPageFor: index at the row-group boundary (first row of rg1)", () => {
  const r = metaWithPages().findPageFor(100n);
  expect(r).not.toBeNull();
  expect(r!.offset).toBe(0); // pageC start_row
  expect(r!.limit).toBe(50);
});

test("findPageFor: index in the first row group is unchanged", () => {
  const r = metaWithPages().findPageFor(60n);
  expect(r).not.toBeNull();
  expect(r!.offset).toBe(50); // pageB start_row
  expect(r!.limit).toBe(50);
});

test("findPageForRange spanning the boundary: positive limit covering the whole range", () => {
  // [60..160] spans pageB (rg0) → pageC, pageD (rg1).
  const r = metaWithPages().findPageForRange(60n, 160n);
  expect(r).not.toBeNull();
  expect(r!.offset).toBe(50); // pageB start_row in the first selected row group
  expect(r!.limit).toBeGreaterThan(0);
  // offset + limit must reach at least to the start of the page containing endIdx (160 is
  // in pageD, whose first row sits at concatenation index 100+50=150). 50+limit >= 150.
  expect(r!.offset + (r!.limit ?? 0)).toBeGreaterThanOrEqual(150);
});

test("findPageForRange never returns a negative limit across many boundary ranges", () => {
  const meta = metaWithPages();
  for (let s = 0; s <= 199; s += 7) {
    for (let e = s; e <= 199; e += 11) {
      const r = meta.findPageForRange(BigInt(s), BigInt(e));
      if (r && r.limit != null) expect(r.limit).toBeGreaterThan(0);
    }
  }
});
