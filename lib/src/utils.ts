import * as Arrow from "apache-arrow";

export function linearSearch<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
  start: number,
  end: number,
) {
  for (let i = start; i < end; i++) {
    if (array.get(i) == value) {
      return i;
    }
  }
  return null;
}

export function linearSearchNearest<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
  start: number,
  end: number,
) {
  let bestError = Infinity;
  let bestIdx = start;
  let lastErr = Infinity;
  for (let i = start; i < end; i++) {
    const v = array.get(i);
    if (v == null) continue;
    const e = Math.abs(v - value);
    if (e < bestError) {
      bestError = e;
      bestIdx = i;
    }
    if (isFinite(lastErr) && e > lastErr) break;
    lastErr = e;
  }
  return isFinite(bestError) ? ([bestIdx, bestError] as [number, number]) : null;
}

export function binarySearch<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
): number {
  let lo = 0;
  let hi = array.length - 1;
  while (lo <= hi) {
    // NB: floor the whole half-width — `Math.floor(hi - lo) / 2` floors an already-integer
    // difference and then divides, yielding a FRACTIONAL mid. With `lo = mid` / `hi = mid`
    // (no ±1) that never converges → infinite loop on small arrays. Use an integer mid and
    // move the bound past it.
    let mid = lo + Math.floor((hi - lo) / 2);
    let val = array.get(mid);
    if (val == null) {
      const top = linearSearch(array, value, mid, hi);
      if (top !== null) return top;
      const bottom = linearSearch(array, value, lo, hi);
      if (bottom !== null) return bottom;
      else {
        return 0;
      }
    }
    if (val < value) {
      lo = mid + 1;
    } else if (val > value) {
      hi = mid - 1;
    } else {
      return mid;
    }
  }
  return 0;
}

export function binarySearchAll<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
) {
  const indexOf = binarySearch(array, value);

  if (array.get(indexOf) != value) {
    return null;
  }

  const n = array.length - 1;

  let lo = indexOf;
  while (lo > 0) {
    let val = array.get(lo - 1);
    if (val == value) {
      --lo;
    } else {
      break;
    }
  }
  let hi = indexOf;
  while (hi < n) {
    let val = array.get(hi + 1);
    if (val == value) {
      hi++;
    } else {
      break;
    }
  }
  // Callers slice [lo, hi) EXCLUSIVE. After the loop `hi` is the last equal index, so the
  // exclusive end is always hi+1 — the old `if (hi < n) ++hi` skipped the increment when a
  // group ended at the vector end, silently dropping the LAST spectrum's scan/precursor/
  // selected-ion rows in every file.
  return [lo, hi + 1];
}

export function binarySearchNearest<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
): [number, number] | null {
  // Rewritten: the old version computed a FRACTIONAL mid (`Math.floor(hi - lo) / 2`),
  // never advanced its bounds (`lo = mid` / `hi = mid`), and could return a bare falsy 0
  // that callers testing `if (result)` treated as "not found". Every m/z-window slice
  // (XIC/DIA extraction) went through it and came back empty for narrow windows.
  const n = array.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n; // exclusive
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    const val = array.get(mid);
    if (val == null) {
      // nulls in a sorted coordinate column are unexpected — degrade to a linear pass
      // over the WHOLE vector (end-inclusive, unlike the old off-by-one fallback).
      return linearSearchNearest(array, value, 0, n);
    }
    if (val < value) lo = mid + 1;
    else hi = mid;
  }
  // lo = lower bound (first index with v >= value). Nearest is lo or lo-1.
  const cand: number[] = [];
  if (lo < n) cand.push(lo);
  if (lo > 0) cand.push(lo - 1);
  let bestIdx: number | null = null;
  let bestErr = Infinity;
  for (const i of cand) {
    const v = array.get(i);
    if (v == null) continue;
    const e = Math.abs(Number(v) - Number(value));
    if (e < bestErr) { bestErr = e; bestIdx = i; }
  }
  return bestIdx == null ? null : [bestIdx, bestErr];
}

export function betweenSorted<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  start: T["TValue"],
  end: T["TValue"],
): [number, number] | null {
  // Rewritten: "nearest" is the wrong primitive for a window slice — the nearest index to
  // `start` can sit BELOW the window and the nearest to `end` was used as an EXCLUSIVE
  // slice end, silently dropping the last in-window point (and often the whole window:
  // a peak at 150.0 with window [149.9, 150.1] sliced to [0, 0]). Compute the true
  // [first v >= start, last v <= end] bounds and return an exclusive end.
  const n = array.length;
  if (n === 0) return null;
  const lowerBound = (v: number): number => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      const x = array.get(mid);
      if (x == null) {
        // null in a sorted coordinate column — degrade to linear.
        let i = 0;
        while (i < n) { const y = array.get(i); if (y != null && Number(y) >= v) break; i++; }
        return i;
      }
      if (Number(x) < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const first = lowerBound(Number(start)); // first index with value >= start
  // Exclusive end: first index with value > end. lowerBound(end) lands on the first
  // value >= end; step past any values EQUAL to end so the closed [start, end] window
  // includes an exact boundary match.
  let hiEx = lowerBound(Number(end));
  while (hiEx < n) { const y = array.get(hiEx); if (y != null && Number(y) <= Number(end)) hiEx++; else break; }
  if (first >= hiEx) return null; // empty window
  return [first, hiEx];
}

export interface Span1D {
  start: number;
  end: number;
}

export interface Span1DBigInt {
    start: bigint,
    end: bigint
}

export function intervalContains(span: Span1D | Span1DBigInt, value: number | bigint) {
  return span.start <= value && span.end >= value;
}

export function intervalOverlaps(span: Span1D, other: Span1D) {
  return (
    (span.end >= other.start && span.start <= other.end) ||
    (Math.abs(span.start - other.start) < 1e-6 &&
      Math.abs(span.end - other.end) < 1e-6)
  );
}
