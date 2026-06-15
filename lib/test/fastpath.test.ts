// streamPointArrays (the fast bulk decode path) must be byte-identical to the generic
// enumerate()+packTableIntoDataArrays path. Compares on the bundled fixture (whichever of
// spectra_data / spectra_peaks is present) including any batch-boundary stitching.
import { expect, test } from "vitest";
import * as fs from "fs";
import { MzPeakReader } from "../src/reader";
import { packTableIntoDataArrays } from "../src/data";

const FIXTURE = "static/small.mzpeak";

async function openDataReader() {
  const reader = await MzPeakReader.fromBlob(await fs.openAsBlob(FIXTURE));
  return (await reader.spectrumData()) ?? (await reader.spectrumPeaks());
}

test("streamPointArrays is byte-identical to enumerate()+pack", async () => {
  const drFast = await openDataReader();
  expect(drFast).toBeTruthy();

  const fast = new Map<number, { mz: Float64Array; intensity: Float32Array }>();
  for await (const s of drFast!.streamPointArrays()) {
    fast.set(s.index, { mz: s.mz, intensity: s.intensity });
  }

  // Fresh reader so the parquet stream state is independent.
  const drGen = await openDataReader();
  const gen = new Map<number, { mz: Float64Array; intensity: Float32Array }>();
  for await (const [idx, table] of drGen!.enumerate()) {
    const packed = packTableIntoDataArrays(table as any);
    const mzRaw = packed["m/z array"] as any;
    const inRaw = packed["intensity array"] as any;
    if (!mzRaw || !inRaw) continue;
    gen.set(Number(idx), { mz: Float64Array.from(mzRaw), intensity: Float32Array.from(inRaw) });
  }

  expect(fast.size).toBeGreaterThan(0);
  expect(fast.size).toBe(gen.size);
  for (const [i, f] of fast) {
    const g = gen.get(i)!;
    expect(g, `spectrum ${i} missing from generic`).toBeTruthy();
    expect(f.mz.length).toBe(g.mz.length);
    expect(f.intensity.length).toBe(g.intensity.length);
    for (let k = 0; k < f.mz.length; k++) {
      expect(f.mz[k]).toBe(g.mz[k]);
      expect(f.intensity[k]).toBe(g.intensity[k]);
    }
  }
});

test("streamPointArrays(mzFloat32) yields f32 m/z equal (within f32) to the f64 stream", async () => {
  const dr32 = await openDataReader();
  const f32 = new Map<number, Float32Array>();
  for await (const s of dr32!.streamPointArrays(true)) {
    expect(s.mz).toBeInstanceOf(Float32Array);
    f32.set(s.index, s.mz as Float32Array);
  }
  const dr64 = await openDataReader();
  for await (const s of dr64!.streamPointArrays(false)) {
    expect(s.mz).toBeInstanceOf(Float64Array);
    const m32 = f32.get(s.index)!;
    expect(m32.length).toBe(s.mz.length);
    for (let k = 0; k < m32.length; k++) expect(m32[k]).toBe(Math.fround(s.mz[k]!)); // exact f32 of the f64
  }
  expect(f32.size).toBeGreaterThan(0);
});
