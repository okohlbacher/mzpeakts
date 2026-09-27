import { expect, test, beforeAll } from "vitest";
import * as fs from "fs";
import { MzPeakReader } from "../src/reader";
import { bigIntToNumber } from 'apache-arrow/util/bigint';

test("test launches", async () => {
  const blob = await fs.openAsBlob("static/small.mzpeak");
  const reader = await MzPeakReader.fromBlob(blob);
  expect.assert(reader.length == 48);
});

const INDEX_SIZE_MSLEVEL = [
  [0, 13589, 1],
  [1, 18177, 1],
  [2, 485, 2],
  [3, 1006, 2],
  [4, 837, 2],
  [5, 650, 2],
  [6, 762, 2],
  [7, 10329, 1],
  [8, 19031, 1],
  [9, 552, 2],
  [10, 941, 2],
  [11, 635, 2],
  [12, 792, 2],
  [13, 669, 2],
  [14, 11786, 1],
  [15, 18259, 1],
  [16, 579, 2],
  [17, 916, 2],
  [18, 670, 2],
  [19, 674, 2],
  [20, 891, 2],
  [21, 11771, 1],
  [22, 15447, 1],
  [23, 579, 2],
  [24, 938, 2],
  [25, 789, 2],
  [26, 687, 2],
  [27, 865, 2],
  [28, 13955, 1],
  [29, 17610, 1],
  [30, 938, 2],
  [31, 653, 2],
  [32, 702, 2],
  [33, 587, 2],
  [34, 11342, 1],
  [35, 15451, 1],
  [36, 572, 2],
  [37, 1064, 2],
  [38, 653, 2],
  [39, 875, 2],
  [40, 754, 2],
  [41, 22554, 1],
  [42, 18409, 1],
  [43, 611, 2],
  [44, 1010, 2],
  [45, 713, 2],
  [46, 659, 2],
  [47, 636, 2],
];

test("chunked layout reader", async () => {
  const blob = await fs.openAsBlob("static/small.chunked.mzpeak");
  const reader = await MzPeakReader.fromBlob(blob);
  for (let [index, size, msLevel] of INDEX_SIZE_MSLEVEL) {
    const response = await reader.get(index);
    expect.assert(response != null);
    expect.assert(response.msLevel == msLevel);
    expect.assert(response.index == BigInt(index));
    if (response.isProfile) {
      expect.assert(response.dataArrays);
      const mzArray = response.dataArrays["m/z array"] as Float64Array;
      expect.assert(mzArray.length == size);
      expect.assert(mzArray.every((v) => v > 0.0));
      expect.assert(
        mzArray.every((v, i, arr) => {
          if (i == 0) {
            return true;
          } else {
            return v >= arr[i - 1];
          }
        }),
      );

      expect.assert(
        response.centroidPeaks()?.length ?? 0 > 0,
        `${response.index}/${index} ${response.centroids} did not have a nonzero length`,
      );
    }
    else {
      const peaks = response.centroidPeaks()
      expect.assert(peaks);

      expect.assert(peaks.length == size);
      expect.assert(peaks.every((v) => v.mz > 0.0));
      expect.assert(
        peaks.every((v, i, arr) => {
          if (i == 0) {
            return true;
          } else {
            return v.mz >= arr[i - 1].mz;
          }
        }),
      );
    }
  }

  const {status, failed} = await reader.store.checkArchiveIntegrity();
  expect.assert(status == true, "Expected the archive be valid")
  expect.assert(failed.length == 0, "Expected the archive be valid");
});



test("point layout reader", async () => {
  const blob = await fs.openAsBlob("static/small.mzpeak");
  const reader = await MzPeakReader.fromBlob(blob);
  for (let [index, size, msLevel] of INDEX_SIZE_MSLEVEL) {
    const response = await reader.get(index);
    expect.assert(response != null);
    expect.assert(response.msLevel == msLevel);
    expect.assert(response.index == BigInt(index));
    if (response.isProfile) {
      expect.assert(response.dataArrays);
      const mzArray = response.dataArrays["m/z array"] as Float64Array;
      expect.assert(mzArray.length == size);
      expect.assert(mzArray.every((v) => v > 0.0));
      for(let i = 1; i < mzArray.length; i++) {
          expect.assert(mzArray[i] >= mzArray[i - 1], `Expected ${i} > ${i - 1}: ${mzArray[i]} < ${mzArray[i - 1]}`);
      }
    } else {
      const peaks = response.centroidPeaks();
      expect.assert(peaks);

      expect.assert(peaks.length == size);
      expect.assert(peaks.every((v) => v.mz > 0.0));
      expect.assert(
        peaks.every((v, i, arr) => {
          if (i == 0) {
            return true;
          } else {
            return v.mz >= arr[i - 1].mz;
          }
        }),
      );
    }
  }
  const { status, failed } = await reader.store.checkArchiveIntegrity();
  expect.assert(status == true, "Expected the archive be valid");
  expect.assert(failed.length == 0, "Expected the archive be valid");
});


test("iterator behavior", async () => {
  const blob = await fs.openAsBlob("static/small.mzpeak");
  const reader = await MzPeakReader.fromBlob(blob);
  for await (let response of reader.enumerateSpectra()) {
    const [index, size, msLevel] = INDEX_SIZE_MSLEVEL[bigIntToNumber(response.index)]
    expect.assert(response != null);
    expect.assert(response.msLevel == msLevel);
    expect.assert(response.index == BigInt(index));
    if (response.isProfile) {
      expect.assert(response.dataArrays);
      const mzArray = response.dataArrays["m/z array"] as Float64Array;
      expect.assert(mzArray.length == size, `Expected ${size} data points, found ${mzArray.length}`);
      expect.assert(mzArray.every((v) => v > 0.0));
      expect.assert(mzArray.every((v, i, arr) => {
        if (i == 0) {
          return true;
        } else {
          return v >= arr[i - 1];
        }
      }));
    } else {
      const peaks = response.centroidPeaks();
      expect.assert(peaks);

      expect.assert(peaks.length == size);
      expect.assert(peaks.every((v) => v.mz > 0.0));
      expect.assert(
        peaks.every((v, i, arr) => {
          if (i == 0) {
            return true;
          } else {
            return v.mz >= arr[i - 1].mz;
          }
        }),
      );
    }
  }
})


test("read remote", async () => {
  try {
    const reader = await MzPeakReader.fromUrl("http://localhost:8030/small.mzpeak")
    expect.assert(reader.length == 48);
  } catch(err) {
    expect.assert((err as any).cause.code == "ECONNREFUSED")
    expect.assert((err as Error).message.match(/fetch failed/g))
  }
})