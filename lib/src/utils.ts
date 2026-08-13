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
  return isFinite(bestError) ? [bestIdx, bestError] : null;
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
  if (hi < n) {
    if (array.get(hi) == value) {
      ++hi;
    }
  }
  return [lo, hi];
}

export function binarySearchNearest<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
) {
  let lo = 0;
  let hi = array.length - 1;
  while (lo <= hi) {
    let mid = lo + Math.floor(hi - lo) / 2;
    let val = array.get(mid);
    if (val == null) {
      const top = linearSearchNearest(array, value, mid, hi);
      if (top !== null) return top;
      const bottom = linearSearchNearest(array, value, lo, hi);
      if (bottom !== null) return bottom;
      else {
        return 0;
      }
    }
    if (val < value) {
      lo = mid;
    } else if (val > value) {
      hi = mid;
    } else {
      const local = linearSearchNearest(
        array,
        value,
        Math.max(mid - 5, 0),
        Math.min(array.length - 1, mid + 5),
      );
      return local;
    }
  }
  return 0;
}

export function betweenSorted<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  start: T["TValue"],
  end: T["TValue"],
) {
  const low = binarySearchNearest(array, start);
  const hi = binarySearchNearest(array, end);
  let startIdx = null;
  let endIdx = null;
  if (low) {
    startIdx = low[0];
  }
  if (hi) {
    endIdx = hi[0];
  }
  if (startIdx == null) {
    if (endIdx != null) {
      return [0, endIdx];
    }
    return null;
  }
  if (endIdx != null) {
    return [startIdx, endIdx];
  }
  return [startIdx, array.length];
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
