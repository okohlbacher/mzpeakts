/*
numpress.ts
TypeScript translation of MSNumpress.cs (rfellers@gmail.com / Johan Teleman)

MS Numpress compression for mass spectrometry numeric arrays.
Apache License, Version 2.0.

Incomplete
*/

import * as Arrow from 'apache-arrow';

export const ACC_NUMPRESS_LINEAR = "MS:1002312";
export const ACC_NUMPRESS_PIC    = "MS:1002313";
export const ACC_NUMPRESS_SLOF   = "MS:1002314";


export interface Appender {
  append: (value: number) => void,
  build: () => Float64Array
}


export class ArrowArrayAppender implements Appender {
  builder: Arrow.Float64Builder

  constructor() {
    this.builder = Arrow.makeBuilder({
      type: new Arrow.Float64(),
      nullValues: [null, undefined]
    })
  }

  append(value: number) {
    this.builder.append(value)
  }

  build() {
    return this.buildArrow().toArray()
  }

  buildArrow() {
    return this.builder.finish().toVector();
  }
}

export class NativeAppender implements Appender {
  builder: number[]

  constructor() {
    this.builder = []

  }

  append(value: number) {
    this.builder.push(value)
  };

  build() {
    return new Float64Array(this.builder)
  }
}

// ---- Fixed-point helpers ----

export function encodeFixedPoint(fixedPoint: number, result: Uint8Array): void {
  new DataView(result.buffer, result.byteOffset).setFloat64(0, fixedPoint, false);
}

export function decodeFixedPoint(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset).getFloat64(0, false);
}

// ---- Integer half-byte encoding ----

/**
 * Encodes a 32-bit integer into half-bytes by truncating leading zeros or ones.
 * Returns the number of half-bytes written.
 */
export function encodeInt(x: number, res: Uint8Array, resOffset: number): number {
  const mask = 0xF0000000 | 0;
  const init = (x & mask) | 0;

  if (init === 0) {
    let l = 8;
    for (let i = 0; i < 8; i++) {
      const m = (mask >> (4 * i)) | 0;
      if ((x & m) !== 0) {
        l = i;
        break;
      }
    }
    res[resOffset] = l;
    for (let i = l; i < 8; i++) {
      res[resOffset + 1 + i - l] = 0xf & (x >> (4 * (i - l)));
    }
    return 1 + 8 - l;

  } else if (init === mask) {
    let l = 7;
    for (let i = 0; i < 8; i++) {
      const m = (mask >> (4 * i)) | 0;
      if (((x & m) | 0) !== m) {
        l = i;
        break;
      }
    }
    res[resOffset] = (l | 8) & 0xFF;
    for (let i = l; i < 8; i++) {
      res[resOffset + 1 + i - l] = 0xf & (x >> (4 * (i - l)));
    }
    return 1 + 8 - l;

  } else {
    res[resOffset] = 0;
    for (let i = 0; i < 8; i++) {
      res[resOffset + 1 + i] = 0xf & (x >> (4 * i));
    }
    return 9;
  }
}

// ---- IntDecoder ----

export class IntDecoder {
  bytes: Uint8Array;
  pos: number;
  half: boolean;

  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes;
    this.pos = pos;
    this.half = false;
  }

  next(): number {
    let head: number;
    if (!this.half) {
      head = (this.bytes[this.pos] & 0xff) >> 4;
    } else {
      head = 0xf & this.bytes[this.pos++];
    }
    this.half = !this.half;

    let n: number;
    let res = 0;

    if (head <= 8) {
      n = head;
    } else {
      n = head - 8;
      const mask = 0xF0000000 | 0;
      for (let i = 0; i < n; i++) {
        const m = (mask >> (4 * i)) | 0;
        res = (res | m) | 0;
      }
    }

    if (n === 8) return 0;

    for (let i = n; i < 8; i++) {
      let hb: number;
      if (!this.half) {
        hb = (this.bytes[this.pos] & 0xff) >> 4;
      } else {
        hb = 0xf & this.bytes[this.pos++];
      }
      res = ((res | 0) | (hb << ((i - n) * 4))) | 0;
      this.half = !this.half;
    }

    return res;
  }
}

// ---- Linear prediction codec ----

export function optimalLinearFixedPoint(data: Float64Array, dataSize: number): number {
  if (dataSize === 0) return 0;
  if (dataSize === 1) return Math.floor(0xFFFFFFFF / data[0]);
  let maxDouble = Math.max(data[0], data[1]);

  for (let i = 2; i < dataSize; i++) {
    const extrapol = data[i - 1] + (data[i - 1] - data[i - 2]);
    const diff = data[i] - extrapol;
    maxDouble = Math.max(maxDouble, Math.ceil(Math.abs(diff) + 1));
  }

  return Math.floor(0x7FFFFFFF / maxDouble);
}

export function encodeLinear(
  data: Float64Array,
  dataSize: number,
  result: Uint8Array,
  fixedPoint: number,
): number {
  const ints = [0, 0, 0];
  const halfBytes = new Uint8Array(10);
  let halfByteCount = 0;

  encodeFixedPoint(fixedPoint, result);
  if (dataSize === 0) return 8;

  ints[1] = Math.trunc(data[0] * fixedPoint + 0.5);
  for (let i = 0; i < 4; i++) {
    result[8 + i] = (ints[1] >> (i * 8)) & 0xff;
  }
  if (dataSize === 1) return 12;

  ints[2] = Math.trunc(data[1] * fixedPoint + 0.5);
  for (let i = 0; i < 4; i++) {
    result[12 + i] = (ints[2] >> (i * 8)) & 0xff;
  }

  halfByteCount = 0;
  let ri = 16;

  for (let i = 2; i < dataSize; i++) {
    ints[0] = ints[1];
    ints[1] = ints[2];
    ints[2] = Math.trunc(data[i] * fixedPoint + 0.5);
    // Accumulate the extrapolation in full-precision JS arithmetic to match the
    // 64-bit reference encoder (see the matching note in decodeLinear). `diff`
    // is the small second difference and stays narrowed to a 32-bit int for
    // encodeInt.
    const extrapol = ints[1] + (ints[1] - ints[0]);
    const diff = (ints[2] - extrapol) | 0;
    halfByteCount += encodeInt(diff, halfBytes, halfByteCount);

    for (let hbi = 1; hbi < halfByteCount; hbi += 2) {
      result[ri++] = ((halfBytes[hbi - 1] << 4) | (halfBytes[hbi] & 0xf)) & 0xff;
    }

    if (halfByteCount % 2 !== 0) {
      halfBytes[0] = halfBytes[halfByteCount - 1];
      halfByteCount = 1;
    } else {
      halfByteCount = 0;
    }
  }

  if (halfByteCount === 1) {
    result[ri++] = (halfBytes[0] << 4) & 0xff;
  }

  return ri;
}

export function decodeLinear(data: Uint8Array, dataSize: number, result: Appender): number {
  if (dataSize === 8) return 0;
  if (dataSize < 8) return -1;

  const fixedPoint = decodeFixedPoint(data);

  if (dataSize < 12) return -1;

  const ints = [0, 0, 0];
  ints[1] = 0;
  for (let i = 0; i < 4; i++) {
    ints[1] = (ints[1] | ((data[8 + i] & 0xFF) << (i * 8))) | 0;
  }
  result.append(ints[1] / fixedPoint);

  if (dataSize === 12) return 1;
  if (dataSize < 16) return -1;

  ints[2] = 0;
  for (let i = 0; i < 4; i++) {
    ints[2] = (ints[2] | ((data[12 + i] & 0xFF) << (i * 8))) | 0;
  }
  result.append(ints[2] / fixedPoint)

  let ri = 2;
  const dec = new IntDecoder(data, 16);

  while (dec.pos < dataSize) {
    if (dec.pos === dataSize - 1 && dec.half) {
      if ((data[dec.pos] & 0xf) !== 0x8) break;
    }

    ints[0] = ints[1];
    ints[1] = ints[2];
    ints[2] = dec.next();

    // The reference C decoder accumulates these reconstructed integers in 64-bit
    // (`long long`). The reconstructed value is `mz * fixedPoint`; with
    // ProteoWizard's auto fixed point (~2^31 / lowest m/z in the chunk) the
    // high-m/z points exceed 2^31, so a `| 0` truncation here wraps them to large
    // NEGATIVE integers — yielding negative m/z. JS numbers are exact integers up
    // to 2^53, well above any mz*fixedPoint (~1e11), so accumulate in plain
    // (full-precision) JS arithmetic to match the 64-bit reference. (The per-step
    // diff from dec.next() is a small second difference that still fits in 32 bits.)
    const extrapol = ints[1] + (ints[1] - ints[0]);
    const y = extrapol + ints[2];
    result.append(y / fixedPoint)
    ri++
    ints[2] = y;
  }

  return ri;
}

// ---- Positive integer codec ----

export function encodePic(data: Float64Array, dataSize: number, result: Uint8Array): number {
  const halfBytes = new Uint8Array(10);
  let halfByteCount = 0;
  let ri = 0;

  for (let i = 0; i < dataSize; i++) {
    const count = Math.trunc(data[i] + 0.5);
    halfByteCount += encodeInt(count, halfBytes, halfByteCount);

    for (let hbi = 1; hbi < halfByteCount; hbi += 2) {
      result[ri++] = ((halfBytes[hbi - 1] << 4) | (halfBytes[hbi] & 0xf)) & 0xff;
    }

    if (halfByteCount % 2 !== 0) {
      halfBytes[0] = halfBytes[halfByteCount - 1];
      halfByteCount = 1;
    } else {
      halfByteCount = 0;
    }
  }

  if (halfByteCount === 1) {
    result[ri++] = (halfBytes[0] << 4) & 0xff;
  }

  return ri;
}

export function decodePic(data: Uint8Array, dataSize: number, result: Float64Array): number {
  let ri = 0;
  const dec = new IntDecoder(data, 0);

  while (dec.pos < dataSize) {
    if (dec.pos === dataSize - 1 && dec.half) {
      if ((data[dec.pos] & 0xf) !== 0x8) break;
    }
    result[ri++] = dec.next();
  }

  return ri;
}

// ---- Short logged float codec ----

export function optimalSlofFixedPoint(data: Float64Array, dataSize: number): number {
  if (dataSize === 0) return 0;

  let maxDouble = 1;
  for (let i = 0; i < dataSize; i++) {
    const x = Math.log(data[i] + 1);
    maxDouble = Math.max(maxDouble, x);
  }

  return Math.floor(0xFFFF / maxDouble);
}

export function encodeSlof(
  data: Float64Array,
  dataSize: number,
  result: Uint8Array,
  fixedPoint: number,
): number {
  let ri = 8;
  encodeFixedPoint(fixedPoint, result);

  for (let i = 0; i < dataSize; i++) {
    const x = Math.trunc(Math.log(data[i] + 1) * fixedPoint + 0.5);
    result[ri++] = x & 0xff;
    result[ri++] = (x >> 8) & 0xff;
  }

  return ri;
}

export function decodeSlof(data: Uint8Array, dataSize: number, result: Appender): number {
  if (dataSize < 8) return -1;
  const fixedPoint = decodeFixedPoint(data);
  if (dataSize % 2 !== 0) return -1;

  let ri = 0;
  for (let i = 8; i < dataSize; i += 2) {
    const x = (data[i] & 0xff) | ((data[i + 1] & 0xff) << 8);
    ri++
    result.append(Math.exp((x & 0xffff) / fixedPoint) - 1);
  }

  return ri;
}

// ---- Convenience dispatcher ----
