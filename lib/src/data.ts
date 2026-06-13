import * as Arrow from "apache-arrow";
import * as ArrowFFI from "arrow-js-ffi";
import { ParquetFile, wasmMemory, ReaderOptions } from "parquet-wasm";

import {
  ArrayIndex,
  ArrayIndexEntry,
  BufferContext,
  BufferFormat,
  bufferContextIndexName,
  bufferContextName,
} from "./array_index";
import { FloatArray, IntArray } from "apache-arrow/type";
import { bigIntToNumber } from "apache-arrow/util/bigint";
import { betweenSorted, intervalOverlaps, Span1D, Span1DBigInt } from "./utils";
import { decodeLinear, ACC_NUMPRESS_LINEAR, ACC_NUMPRESS_PIC, ACC_NUMPRESS_SLOF, ArrowArrayAppender as NumpressArrowAppender, decodeSlof, decodePic } from "./numpress"

export type DataArrays = Record<string, FloatArray | IntArray | BigInt64Array | string[]>;

export function packTableIntoDataArrays(table: Arrow.Table): DataArrays {
  const dataArrays: DataArrays = {};
  for (let i = 1; i < table.schema.fields.length; i++) {
    const colName = table.schema.fields[i].name;
    dataArrays[colName] = table.getChildAt(i)?.toArray();
  }
  return dataArrays;
}

export function packTableIntoPeaks(table: Arrow.Table) {
  const dataArrays = packTableIntoDataArrays(table);
  const peaks = [];
  let i = 0;
  for (let [k, vs] of Object.entries(dataArrays)) {
    const key = k.split(" ").slice(0, -1).join("_").replace("/", "");
    if (i == 0) {
      for (let v of vs) {
        peaks.push({ [key]: v });
      }
      i += 1;
    } else {
      for (let j = 0; j < vs.length; j++) {
        peaks[j][key] = vs[j];
      }
    }
  }
  return peaks;
}

export class SpacingInterpolationModel {
  coefficients: number[];

  constructor(coefficients: number[]) {
    this.coefficients = coefficients;
  }

  predict(value: number) {
    let acc = 0.0;
    for (let i = 0; i < this.coefficients.length; i++) {
      acc += Math.pow(value, i) * this.coefficients[i];
    }
    return acc;
  }

  static fromArrow(value: Arrow.Vector<Arrow.Float64>) {
    return new this(Array.from(value.toArray()));
  }
}

export const NULL_INTERPOLATE_CURIE = "MS:1003901";
export const NULL_ZERO_CURIE = "MS:1003902";

const NO_COMPRESSION_CURIE = "MS:1000576";
const DELTA_CURIE = "MS:1003089";
const NUMPRESS_LINEAR_CURIE = ACC_NUMPRESS_LINEAR;
const NUMPRESS_SLOF_CURIE = ACC_NUMPRESS_SLOF;
const NUMPRESS_PIC_CURIE = ACC_NUMPRESS_PIC;

// ---- Internal helpers ----

async function* streamArrowBatches(
  handle: ParquetFile,
  rowGroups?: number[],
  columns?: string[],
  options_?: ReaderOptions,
) {
  const options = options_ ?? { batchSize: 2048 };
  options.rowGroups = rowGroups;
  if (columns) options.columns = columns;
  const tabStream = (await handle.stream(options)).values();
  const mem = wasmMemory();
  while (true) {
    let batch = await tabStream.next();
    if (batch.done) break;
    let wBatch = batch.value;
    if (wBatch) {
      let ffi = wBatch.intoFFI();
      let arrowBat = ArrowFFI.parseRecordBatch(
        mem.buffer,
        ffi.arrayAddr(),
        ffi.schemaAddr(),
        true,
      );
      ffi.free();

      yield arrowBat;
    }
  }
}

/**
 * This combines multiple Arrow arrays, making a deep copy instead of shallowly appending their data together
 * @param arrays A list of Arrow arrays to combine
 * @returns A single Arrow array containing all the values from the source arrays, but with new storage
 */
function combineVectors<T extends Arrow.DataType>(
  arrays: Arrow.Vector<T>[],
): Arrow.Vector<T> {
  if (arrays.length == 1) return arrays[0];
  const acc = Arrow.makeBuilder({ type: arrays[0].type, nullValues: [null] });
  for (let i = 0; i < arrays.length; i++) {
    const chunk = arrays[i];
    for (let j = 0; j < chunk.length; j++) {
      acc.append(chunk.get(j));
    }
  }
  return acc.finish().toVector();
}

function rootStructOf(
  batch: Arrow.RecordBatch,
): Arrow.Vector<Arrow.Struct> | null {
  return batch.getChildAt(0) as Arrow.Vector<Arrow.Struct> | null;
}

function indexVectorOf(
  rootStruct: Arrow.Vector<Arrow.Struct>,
): Arrow.Vector<Arrow.Uint64> {
  return rootStruct.getChildAt(0) as Arrow.Vector<Arrow.Uint64>;
}

function decodeNoCompression(
  startValue: number,
  values: Arrow.Vector<Arrow.Float>,
): Arrow.Vector<Arrow.Float> {
  const acc = Arrow.makeBuilder({ type: values.type, nullValues: [null] });
  acc.append(startValue);
  for (let val of values) {
    acc.append(val);
  }
  return acc.finish().toVector();
}

function decodeDelta(
  startValue: number,
  values: Arrow.Vector<Arrow.Float>,
): Arrow.Vector<Arrow.Float> {
  const acc = Arrow.makeBuilder({ type: values.type, nullValues: [null] });
  let last: number | null = startValue;
  if (!values.isValid(0)) {
    if (!values.isValid(1)) {
      acc.append(last);
    }
    last = null;
  } else {
    acc.append(startValue);
  }
  for (let val of values) {
    if (val != null) {
      if (last != null) {
        last = val + last;
        acc.append(last);
      } else {
        acc.append(val);
        last = val;
      }
    } else {
      acc.append(val);
      last = val;
    }
  }
  const result = acc.finish().toVector();
  return result;
}

/**
 * Replace all the `null` values in a numerical array, as defined by `isValid` replaced by `0`
 * as interpreted by the data type.
 *
 * This is an **in-place** operation, no copying is done.
 *
 * If `array.nullCount == 0`, we return immediately, otherwise this does a full pass over
 * the array.
 *
 * @param array The Arrow array to have its nulls converted to 0
 * @returns The same array, modified in-place
 */
const nullToZero = <T extends Arrow.DataType>(array: Arrow.Vector<T>) => {
  if (array.nullCount == 0) return array;
  for (let _i = 0; _i < array.length; _i++) {
    if (!array.isValid(_i)) {
      array.set(_i, 0);
    }
  }
  return array;
};

interface JsStatistics<T> {
  min_value: T | undefined;
  max_value: T | undefined;
  // Distinct count could be omitted in some cases
  distinct_count: number | undefined;
  null_count: number | undefined;

  // Whether or not the min or max values are exact, or truncated.
  is_max_value_exact: boolean;
  is_min_value_exact: boolean;
}

interface JsDataPage<T> {
  min: T | undefined;
  max: T | undefined;
  null_count: number | undefined;
  row_group_index: number;
  start_row: number;
  end_row: number;
}

/**
 * Construct index ranges between pairs of masked values in `maskedVector`.
 *
 * The first and last index range will include the beginning and ending
 * of the array respectively, even if the mask does not start/end with a
 * `true` value.
 *
 * The resulting array contains [start, end) pairs (end is exclusive) of the
 * spans between two `true` values (or the termini of the array).
 *
 * Warning: can fail or produce incorrect output if there are runs of
 * `true` values longer than 2 in the mask.
 */
export function findMaskedPairs(
  maskedVector: Arrow.Vector,
): [number, number][] {
  let nullHere: number[] = [];
  for (let i = 0; i < maskedVector.length; i++) {
    if (maskedVector.get(i) == null) nullHere.push(i);
  }
  if (nullHere.length == 0) {
    return [[0, maskedVector.length]];
  }
  if (nullHere[0] != 0) {
    nullHere = [0, ...nullHere];
  }
  if (nullHere[nullHere.length - 1] !== maskedVector.length - 1) {
    nullHere.push(maskedVector.length - 1);
  }
  if (nullHere.length % 2 != 0) {
    throw new Error(
      `Number of pairs must be even, got ${nullHere.length}: ${nullHere}`,
    );
  }
  const result: [number, number][] = [];
  for (let i = 0; i < nullHere.length; i += 2) {
    if (isNaN(nullHere[i]) || isNaN(nullHere[i + 1])) {
      throw new Error(
        `Bad pair ${[nullHere[i], nullHere[i + 1]]}, ${nullHere}`,
      );
    }
    result.push([nullHere[i], nullHere[i + 1] + 1]);
  }
  return result;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Find the 2nd median of the consecutive differences of `data`.
 *
 * This is a relatively crude spacing estimate for continuous profile data.
 *
 * @returns A tuple of [secondMedian, filteredDeltas] where filteredDeltas are
 * the diff values that are <= the first median.
 */
export function estimateMedianDelta(
  data: number[] | FloatArray,
): [number, number[]] {
  const deltas: number[] = [];
  for (let i = 1; i < data.length; i++) {
    deltas.push(data[i] - data[i - 1]);
  }
  const med1 = median(deltas);
  const deltasBelow = deltas.filter((d) => d <= med1);
  const med2 = median(deltasBelow);
  return [med2, deltasBelow];
}

export function interpolateNulls(
  values: Arrow.Vector<Arrow.Float>,
  model: SpacingInterpolationModel,
): Arrow.Vector<Arrow.Float> {
  if (values.nullCount == 0) {
    return values
  }
  const pairIndices = findMaskedPairs(values);
  const chunks = [];
  let k = 0;
  for (let [start, end] of pairIndices) {
    const chunk = values.slice(start, end);
    const n = chunk.length;
    const nHasReal = n - chunk.nullCount;
    if (nHasReal == 1) {
      if (n == 2) {
        if (chunk.isValid(1)) {
          const v = chunk.get(1) ?? 0;
          chunk.set(0, v - model.predict(v));
        } else {
          const v = chunk.get(0) ?? 0;
          chunk.set(1, v + model.predict(v));
        }
      } else if (n == 3) {
        const v = chunk.get(1) ?? 0;
        chunk.set(0, v - model.predict(v));
        chunk.set(2, v + model.predict(v));
      } else {
        throw new Error(`Chunk ${start}-${end} is too short to interpolate!?`);
      }
    } else {
      const [dx, _] = estimateMedianDelta(
        chunk
          .slice(
            chunk.isValid(0) ? 0 : 1,
            chunk.isValid(chunk.length - 1) ? chunk.length : chunk.length - 1,
          )
          .toArray(),
      );
      chunk.set(0, (chunk.get(1) ?? 0) - dx);
      chunk.set(chunk.length - 1, (chunk.get(chunk.length - 2) ?? 0) + dx);
    }
    k += chunk.length;
    chunks.push(chunk);
  }
  if (chunks.map((x) => x.length).reduce((a, b) => a + b) != values.length) {
    throw new Error(
      `Information was lost, total size of chunks does not match input size: ${chunks.map((x) => x.length).reduce((a, b) => a + b)} != ${values.length}`,
    );
  }
  const result = combineVectors(chunks);
  return result;
}

// ---- GroupTagBounds ----

export class GroupTagBounds {
  key: bigint;
  start: bigint;
  end: bigint;

  constructor(key: bigint, start: bigint, end: bigint) {
    this.key = key;
    this.start = start;
    this.end = end;
  }

  contains(value: bigint): boolean {
    const value_ = BigInt(value);
    return this.start <= value_ && value_ <= this.end;
  }
}

// ---- RangeIndex ----

export class RangeIndex implements Iterable<GroupTagBounds> {
  ranges: GroupTagBounds[];

  constructor(ranges: GroupTagBounds[]) {
    this.ranges = ranges;
  }

  get length(): number {
    return this.ranges.length;
  }

  [Symbol.iterator](): Iterator<GroupTagBounds> {
    return this.ranges[Symbol.iterator]();
  }

  findByKey(key: bigint): GroupTagBounds | null {
    const key_ = BigInt(key);
    if (this.length === 0) return null;
    let lo = 0,
      hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = this.ranges[mid].key;
      if (k === key_) return this.ranges[mid];
      else if (k < key_) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  keysFor(index_: bigint): bigint[] {
    const index = BigInt(index_);
    return this.ranges.filter((r) => r.contains(index)).map((r) => r.key);
  }
}

// ---- DataArraysReaderMeta ----

export class DataArraysReaderMeta {
  context: BufferContext;
  arrayIndex: ArrayIndex;
  rowGroupIndex: RangeIndex;
  pageKeyIndex: JsDataPage<bigint>[] | null;
  format: BufferFormat;
  spacingModels: Map<bigint, SpacingInterpolationModel> | null;

  constructor(
    context: BufferContext,
    arrayIndex: ArrayIndex,
    rowGroupIndex: RangeIndex,
    format: BufferFormat,
    spacingModels: Map<bigint, SpacingInterpolationModel> | null = null,
    pageKeyIndex: JsDataPage<bigint>[] | null = null,
  ) {
    this.context = context;
    this.arrayIndex = arrayIndex;
    this.rowGroupIndex = rowGroupIndex;
    this.format = format;
    this.spacingModels = spacingModels;
    this.pageKeyIndex = pageKeyIndex;
  }

  static async fromParquet(
    handle: ParquetFile,
    context: BufferContext,
  ): Promise<DataArraysReaderMeta> {
    const pqMeta = handle.metadata();
    const nRowGroups = pqMeta.numRowGroups();
    if (nRowGroups === 0) throw new Error("Empty Parquet file");

    // 1. Load ArrayIndex JSON from file key-value metadata
    const kvMeta = pqMeta.fileMetadata().keyValueMetadata() as Map<
      string,
      string
    >;
    const arrayIndexKey = `${bufferContextName(context)}_array_index`;
    const arrayIndexJson = kvMeta.get(arrayIndexKey);
    if (arrayIndexJson == null)
      throw new Error(
        `Array index key "${arrayIndexKey}" missing from file metadata`,
      );
    const arrayIndex = ArrayIndex.fromJSON(JSON.parse(arrayIndexJson));

    // 2. Infer buffer format from first column path prefix
    const firstColPath = pqMeta.rowGroup(0).column(0).columnPath().join(".");
    let format: BufferFormat;
    if (firstColPath.startsWith("point")) format = BufferFormat.Point;
    else if (firstColPath.startsWith("chunk"))
      format = BufferFormat.ChunkValues;
    else throw new Error(`Root schema prefix "${firstColPath}" not recognized`);

    // 3. Annotate schema indices from row group 0 column paths
    const nCols = pqMeta.rowGroup(0).numColumns();
    for (let i = 0; i < nCols; i++) {
      let pathOf = pqMeta.rowGroup(0).column(i).columnPath().join(".");
      if (pathOf.endsWith(".list.item"))
        pathOf = pathOf.slice(0, -".list.item".length);
      else if (pathOf.endsWith(".list.element"))
        pathOf = pathOf.slice(0, -".list.element".length);
      for (const entry of arrayIndex.entries) {
        if (entry.path === pathOf) entry.schemaIndex = i;
      }
    }

    let pages = (pqMeta.columnIndexFor(0) as JsDataPage<number>[]).map(
      (page) => {
        return {
          min:
            page.min == null || page.min == undefined
              ? undefined
              : BigInt(page.min),
          max:
            page.max == null || page.max == undefined
              ? undefined
              : BigInt(page.max),
          start_row: page.start_row,
          null_count: page.null_count,
          end_row: page.end_row,
          row_group_index: page.row_group_index,
        };
      },
    ) as JsDataPage<bigint>[];

    const rowGroupBounds: GroupTagBounds[] = [];
    for (let i = 0; i < pqMeta.numRowGroups(); i++) {
      let rg = pqMeta.rowGroup(i);
      let idxCol = rg.column(0);
      let stats: JsStatistics<number> | null = idxCol.statistics();
      if (stats != null) {
        if (stats.min_value != undefined && stats.max_value != undefined) {
          rowGroupBounds.push(
            new GroupTagBounds(
              BigInt(i),
              BigInt(stats.min_value),
              BigInt(stats.max_value),
            ),
          );
        }
      }
    }

    return new DataArraysReaderMeta(
      context,
      arrayIndex,
      new RangeIndex(rowGroupBounds),
      format,
      null,
      pages,
    );
  }

  findPageFor(index: bigint): { offset: number; limit: number | null } | null {
    if (!this.pageKeyIndex) return null;
    let start = null;
    for (let page of this.pageKeyIndex) {
      const min = page.min;
      const max = page.max;
      if (min == undefined || max == undefined) continue;
      if (min <= index && max >= index && start == null) {
        start = page.start_row;
      }
      if (min > index && start != null) {
        const limit = (page.start_row ?? 0) - (start ?? 0);
        return { offset: start, limit: limit == 0 ? null : limit };
      }
    }
    return null;
  }

  findPageForRange(startIdx: bigint, endIdx: bigint) {
    if (!this.pageKeyIndex) return null;
    let start = null;
    let limit = 0n;
    for (let page of this.pageKeyIndex) {
      const min = page.min;
      const max = page.max;
      if (min == undefined || max == undefined) continue;
      if (min <= startIdx && max >= startIdx && start == null) {
        start = page.start_row;
        limit += BigInt((page.end_row ?? 0) - (page.start_row ?? 0));
      } else if (start != null) {
        limit += BigInt((page.end_row ?? 0) - (page.start_row ?? 0));
      }
      if (min > endIdx) {
        if (start != null) {
          return {
            offset: start,
            limit: limit == 0n ? null : bigIntToNumber(limit),
          };
        } else {
          return null;
        }
      }
    }
    if (start) {
      return {
        offset: start,
        limit: limit == 0n ? null : bigIntToNumber(limit),
      };
    } else {
      return null;
    }
  }
}

// ---- Layout readers ----

type ColumnMap = Record<string, Arrow.Vector>;

const take = <T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  indices: number[],
) => {
  const acc = Arrow.makeBuilder({ type: array.type, nullValues: [null] });
  for (let i of indices) {
    acc.append(array.get(i));
  }
  return acc.finish().toVector();
};

const firstNotNull = <T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
): T["TValue"] | null => {
  for (let i = 0; i < array.length; i++) {
    let v = array.get(i);
    if (v != null) return v;
  }
  return null;
};

const lastNotNull = <T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
): T["TValue"] | null => {
  for (let i = array.length - 1; i >= 0; i--) {
    let v = array.get(i);
    if (v != null) return v;
  }
  return null;
};

export class BaseLayoutReader {
  public arrayIndex: ArrayIndex;
  protected batches: AsyncIterableIterator<Arrow.RecordBatch>;
  protected spacingModels: Map<bigint, SpacingInterpolationModel> | undefined;
  private _queryCoordinateRange: Span1D | null = null;

  get queryCoordinateRange(): Span1D | null {
    return this._queryCoordinateRange;
  }

  set queryCoordinateRange(value: Span1D | null) {
    this._queryCoordinateRange = value;
  }

  constructor(
    batches: AsyncIterableIterator<Arrow.RecordBatch>,
    arrayIndex: ArrayIndex,
    spacingModels?: Map<bigint, SpacingInterpolationModel>,
    queryCoordinateRange: { start: number; end: number } | null = null,
  ) {
    this.batches = batches;
    this.arrayIndex = arrayIndex;
    this.spacingModels = spacingModels;
    this.queryCoordinateRange = queryCoordinateRange;
  }

  processSelectedRows(
    _entryIndex: bigint,
    rootStruct: Arrow.Vector<Arrow.Struct>,
    selectedRows: number[],
  ): ColumnMap {
    const result: ColumnMap = {};
    for (const field of rootStruct.type.children) {
      const vec = rootStruct.getChild(field.name)!;
      const isAllNull = vec.nullCount == selectedRows.length;
      /*
      We have already collected an array of this name, so this must be another dimension not present
      in this particular observation, e.g. when there are multiple intensity arrays with different units,
      so do not overwrite the existing array.
      */
      if (isAllNull) {
        continue;
      }
      if (selectedRows.length == vec.length) {
        result[field.name] = vec;
      } else {
        result[field.name] = take(vec, selectedRows);
      }
    }
    return result;
  }

  processRows(
    entryIndex: bigint,
    rootStruct: Arrow.Vector<Arrow.Struct>,
  ): ColumnMap {
    const idxVec = indexVectorOf(rootStruct);
    const selectedRows: number[] = [];
    for (let i = 0; i < idxVec.length; i++) {
      if (idxVec.get(i) === entryIndex) selectedRows.push(i);
    }

    return this.processSelectedRows(entryIndex, rootStruct, selectedRows);
  }

  postprocessRowsOf(
    entryIndex: bigint,
    nBats: number,
    accumulated: Record<string, Arrow.Vector[]>,
  ) {
    const final: Record<string, Arrow.Vector> = {};
    if (nBats == 1) {
      for (let [k, v] of Object.entries(accumulated)) {
        const arrayMeta = this.arrayIndex.byFieldName.get(k);
        final[arrayMeta?.arrayName ?? k] = this.handleTransforms(
          arrayMeta,
          entryIndex,
          v[0],
        );
      }
    } else {
      for (let [k, v] of Object.entries(accumulated)) {
        const arrayMeta = this.arrayIndex.byFieldName.get(k);
        final[arrayMeta?.arrayName ?? k] = this.handleTransforms(
          arrayMeta,
          entryIndex,
          combineVectors(v),
        );
      }
    }

    return Arrow.tableFromArrays(final as any);
  }

  async readRowsOf(
    entryIndex: bigint,
    startFrom: bigint | null,
    endAt: bigint | null,
  ): Promise<Arrow.Table> {
    let rowCountRead = 0n;
    const accumulated: Record<string, Arrow.Vector[]> = {};
    let nBats = 0;
    let ctr = 0;
    for await (const batch of this.batches) {
      ctr += 1;
      const rootStruct = rootStructOf(batch);
      if (rootStruct == null) {
        rowCountRead += BigInt(batch.numRows);
        continue;
      }

      const batchSize = BigInt(rootStruct.length);
      if (startFrom != null) {
        if (rowCountRead + batchSize < startFrom) {
          rowCountRead += batchSize;
          continue;
        }
      } else {
        const firstIdxOf = firstNotNull(indexVectorOf(rootStruct));
        if (firstIdxOf != null && firstIdxOf > entryIndex) {
          break;
        }
      }

      if (endAt != null) {
        if (rowCountRead >= endAt) break;
      } else {
        const lastIdxOf = lastNotNull(indexVectorOf(rootStruct));
        if (lastIdxOf != null && lastIdxOf < entryIndex) {
          continue;
        }
      }

      const entries = this.processRows(entryIndex, rootStruct);
      if (entries) {
        nBats += 1;

        const sizes: number[] = [];

        for (let [k, v] of Object.entries(entries)) {
          if (accumulated[k] == undefined) {
            accumulated[k] = [v];
            sizes.push(v.length);
          } else {
            accumulated[k].push(v);
            sizes.push(
              accumulated[k].map((x) => x.length).reduce((last, x) => last + x),
            );
          }
        }
        if (!sizes.every((v) => v == sizes[0])) {
          throw new Error(
            `Not all arrays are the same length: ${sizes} for ${Object.keys(accumulated)}`,
          );
        }
        rowCountRead += batchSize;
      }
    }
    return this.postprocessRowsOf(entryIndex, nBats, accumulated);
  }

  handleTransforms(
    entry: ArrayIndexEntry | undefined,
    entryIndex: bigint,
    array: Arrow.Vector<Arrow.Float>,
  ) {
    if (entry?.transform === NULL_ZERO_CURIE) {
      return nullToZero(array);
    } else if (
      entry?.transform === NULL_INTERPOLATE_CURIE &&
      this.spacingModels?.has(entryIndex)
    ) {
      const filled = interpolateNulls(
        array,
        this.spacingModels.get(entryIndex)!,
      );
      return filled;
    } else {
      return array;
    }
  }
}

export class PointLayoutReader extends BaseLayoutReader {
  override processSelectedRows(
    entryIndex: bigint,
    rootStruct: Arrow.Vector<Arrow.Struct>,
    selectedRows: number[],
  ): ColumnMap {
    const base = super.processSelectedRows(
      entryIndex,
      rootStruct,
      selectedRows,
    );
    return base;
  }
}

export class ChunkLayoutReader extends BaseLayoutReader {
  private mainAxisEntry: ArrayIndexEntry | null = null;
  private chunkStartFieldName = "";
  private chunkEndFieldName = "";
  private chunkEncodingFieldName = "";
  private chunkValuesFieldName = "";
  private secondaryFields: { name: string; entry: ArrayIndexEntry }[] = [];

  constructor(
    batches: AsyncIterableIterator<Arrow.RecordBatch>,
    arrayIndex: ArrayIndex,
    spacingModels?: Map<bigint, SpacingInterpolationModel>,
  ) {
    super(batches, arrayIndex, spacingModels);
    this.configureIndices();
  }

  private configureIndices() {
    for (const entry of this.arrayIndex.entries) {
      const fieldName = entry.fieldName;
      switch (entry.bufferFormat) {
        case BufferFormat.ChunkStart:
          this.chunkStartFieldName = fieldName;
          break;
        case BufferFormat.ChunkEnd:
          this.chunkEndFieldName = fieldName;
          break;
        case BufferFormat.ChunkEncoding:
          this.chunkEncodingFieldName = fieldName;
          break;
        case BufferFormat.ChunkValues:
          this.mainAxisEntry = entry;
          this.chunkValuesFieldName = fieldName;
          break;
        case BufferFormat.ChunkTransform:
        case BufferFormat.ChunkSecondary:
          this.secondaryFields.push({ name: fieldName, entry });
          break;
      }
    }
    if (!this.chunkEncodingFieldName)
      throw new Error("Chunk encoding column not found");
    if (this.mainAxisEntry == null) throw new Error("Main axis cannot be null");
  }

  override processSelectedRows(
    entryIndex: bigint,
    rootStruct: Arrow.Vector<Arrow.Struct>,
    selectedRows: number[],
  ): ColumnMap {
    if (selectedRows.length === 0) return {};
    if (this.mainAxisEntry == null) throw new Error("Main axis cannot be null");

    const chunkStartVec = rootStruct.getChild(this.chunkStartFieldName)!;
    const chunkEndVec = rootStruct.getChild(this.chunkEndFieldName)!;
    const chunkEncodingVec = rootStruct.getChild(
      this.chunkEncodingFieldName,
    ) as Arrow.Vector<Arrow.Utf8>;
    const chunkValuesVec = rootStruct.getChild(
      this.chunkValuesFieldName,
    ) as Arrow.Vector<Arrow.List<Arrow.DataType>>;

    const indexColName = bufferContextIndexName(this.mainAxisEntry.context);
    const mainAxisName = this.chunkValuesFieldName;

    const resultIndex: Arrow.Uint64Builder = Arrow.makeBuilder({
      type: new Arrow.Uint64(),
      nullValues: [null],
    });
    const resultMainAxis: Arrow.Vector<Arrow.Float>[] = [];
    const resultSecondary: Record<string, Arrow.Vector[]> = {};
    for (const { name } of this.secondaryFields) resultSecondary[name] = [];

    const queryRange = this.queryCoordinateRange;

    // Numpress main-axis values live in a separate byte-array column (not chunkValues).
    // The column is identical for every selected row, so look it up by transform CURIE
    // and cache it. Linear, SLOF and PIC all share this lookup; only the per-row
    // decoder differs.
    const numpressCols = new Map<
      string,
      { idx: number; col: Arrow.Vector<Arrow.Struct> | null }
    >();
    const numpressColFor = (transform: string) => {
      let c = numpressCols.get(transform);
      if (c === undefined) {
        const entriesOf = this.arrayIndex
          .entriesFor(this.mainAxisEntry!.arrayTypeCURIE)
          .filter((e) => e.transform == transform);
        if (entriesOf.length == 0)
          throw new Error(`Numpress chunk encoding found, but could not find byte array`);
        const entryFor = entriesOf[0];
        // Robustness: the byte-array column must have a concrete schema index and
        // resolve to a real child column — otherwise getChildAt would bind the wrong
        // (or a null) column and decode garbage.
        if (entryFor.schemaIndex == null)
          throw new Error(`Numpress byte-array column for ${transform} has no schema index`);
        const col = rootStruct.getChildAt(entryFor.schemaIndex);
        if (col == null)
          throw new Error(
            `Numpress byte-array column (schema index ${entryFor.schemaIndex}) not found`,
          );
        c = { idx: entryFor.schemaIndex, col };
        numpressCols.set(transform, c);
      }
      return c;
    };
    const visitedCols = new Set();
    for (const rowIdx of selectedRows) {
      visitedCols.clear()
      const startValue = Number(chunkStartVec.get(rowIdx) ?? 0);
      const encoding = chunkEncodingVec.get(rowIdx) ?? "";
      const chunkValues = chunkValuesVec.get(
        rowIdx,
      ) as Arrow.Vector<Arrow.Float> | null;

      // If we are extracting for a target range, don't bother processing this chunk
      // if it doesn't touch the range we care about.
      if (queryRange != null) {
        const endValue = Number(chunkEndVec.get(rowIdx) ?? 0);
        const rowSpan = { start: startValue, end: endValue };
        if (!intervalOverlaps(rowSpan, queryRange)) {
          continue;
        }
      }
      let decoded: Arrow.Vector<Arrow.Float>;
      switch (encoding) {
        case NO_COMPRESSION_CURIE:
          if (chunkValues == null)
            throw new Error(
              `Chunk values cannot be null, but ${rowIdx} with start value ${startValue} for ${entryIndex} was`,
            );
          decoded = decodeNoCompression(startValue, chunkValues);
          break;
        case DELTA_CURIE:
          if (chunkValues == null)
            throw new Error(
              `Chunk values cannot be null, but ${rowIdx} with start value ${startValue} for ${entryIndex} was`,
            );
          decoded = decodeDelta(startValue, chunkValues);
          break;
        case NUMPRESS_LINEAR_CURIE: {
          const { idx, col } = numpressColFor(ACC_NUMPRESS_LINEAR);
          visitedCols.add(idx);
          const buf = col!.get(rowIdx) as Arrow.Vector<Arrow.Uint8> | null;
          if (buf == null) throw new Error(`Numpress byte array is expected, found null`);
          const acc = new NumpressArrowAppender();
          // decodeLinear returns -1 on a truncated/malformed buffer; surface that as a
          // typed corrupt-file error instead of silently building a partial array.
          if (decodeLinear(buf.toArray(), buf.length, acc) < 0)
            throw new Error(`Corrupt Numpress Linear buffer at row ${rowIdx}`);
          decoded = acc.buildArrow();
          break;
        }
        case NUMPRESS_SLOF_CURIE: {
          const { idx, col } = numpressColFor(ACC_NUMPRESS_SLOF);
          visitedCols.add(idx);
          const buf = col!.get(rowIdx) as Arrow.Vector<Arrow.Uint8> | null;
          if (buf == null) throw new Error(`Numpress byte array is expected, found null`);
          const acc = new NumpressArrowAppender();
          // decodeSlof returns -1 on a truncated/odd-length buffer.
          if (decodeSlof(buf.toArray(), buf.length, acc) < 0)
            throw new Error(`Corrupt Numpress SLOF buffer at row ${rowIdx}`);
          decoded = acc.buildArrow();
          break;
        }
        case NUMPRESS_PIC_CURIE: {
          const { idx, col } = numpressColFor(ACC_NUMPRESS_PIC);
          visitedCols.add(idx);
          const buf = col!.get(rowIdx) as Arrow.Vector<Arrow.Uint8> | null;
          if (buf == null) throw new Error(`Numpress byte array is expected, found null`);
          const acc = new NumpressArrowAppender();
          decodePic(buf.toArray(), buf.length, acc);
          decoded = acc.buildArrow();
          break;
        }
        default:
          throw new Error(`Unknown chunk encoding: ${encoding}`);
      }
      decoded = this.handleTransforms(this.mainAxisEntry, entryIndex, decoded);
      resultMainAxis.push(decoded);
      for (let _i = 0; _i < decoded.length; _i++)
        resultIndex.append(entryIndex);

      for (const { name, entry } of this.secondaryFields) {
        if (visitedCols.has(entry.schemaIndex)) continue
        visitedCols.add(entry.schemaIndex);
        const secVec = rootStruct.getChild(name) as Arrow.Vector<
            Arrow.List<Arrow.DataType>
          >;
        let secValues = secVec.get(rowIdx);
        if (secValues == null) continue;
        if (entry.transform == NULL_ZERO_CURIE) {
          nullToZero(secValues);
        }
        if (entry.arrayTypeCURIE == this.mainAxisEntry.arrayTypeCURIE) continue;
        if (entry.transform === NUMPRESS_SLOF_CURIE) {
          const buf = new NumpressArrowAppender()
          decodeSlof(
            (secValues as Arrow.Vector<Arrow.Uint8>).toArray(),
            secValues.length,
            buf,
          );
          resultSecondary[name].push(buf.buildArrow());
        } else if (entry.transform === NUMPRESS_PIC_CURIE) {
          const buf = new NumpressArrowAppender()
          decodePic(
            (secValues as Arrow.Vector<Arrow.Uint8>).toArray(),
            secValues.length,
            buf,
          );
          resultSecondary[name].push(buf.buildArrow());
        } else if (entry.transform === NUMPRESS_LINEAR_CURIE) {
          const buf = new NumpressArrowAppender()
          decodeLinear(
            (secValues as Arrow.Vector<Arrow.Uint8>).toArray(),
            secValues.length,
            buf,
          );
          resultSecondary[name].push(buf.buildArrow());
        } else {
          resultSecondary[name].push(secValues);
        }
      }
    }

    if (resultMainAxis.length == 0) {
      const result: ColumnMap = {};
      result[indexColName] = resultIndex.finish().toVector();
      for (let e of this.arrayIndex.entries) {
        result[e.arrayName] = e.emptyArrow();
      }
      return result;
    }

    let mainAxisCombined = combineVectors(resultMainAxis);
    const result: ColumnMap = {
      [indexColName]: resultIndex.finish().toVector(),
      [mainAxisName]: mainAxisCombined,
    } as ColumnMap;

    for (const [name, values] of Object.entries(resultSecondary)) {
      if (values.length == 0) continue
      const vec = combineVectors(values);
      /*
      We have already collected an array of this name, so this must be another dimension not present
      in this particular observation, e.g. when there are multiple intensity arrays with different units,
      so do not overwrite the existing array.
      */
      if (vec.nullCount == vec.length) {
        continue;
      }
      result[name] = vec;
    }

    return result;
  }
}

// ---- DataArraysReader ----

export class DataArraysReader {
  bufferContext: BufferContext;
  handle: ParquetFile;
  metadata: DataArraysReaderMeta;

  constructor(handle: ParquetFile, meta: DataArraysReaderMeta) {
    this.handle = handle;
    this.metadata = meta;
    this.bufferContext = meta.context;
  }

  static async fromParquet(handle: ParquetFile, context: BufferContext) {
    const meta = await DataArraysReaderMeta.fromParquet(handle, context);
    return new this(handle, meta);
  }

  get arrayIndex(): ArrayIndex {
    return this.metadata.arrayIndex;
  }
  get rowGroupIndex(): RangeIndex {
    return this.metadata.rowGroupIndex;
  }

  get format(): BufferFormat {
    return this.metadata.format;
  }

  get length(): number | undefined {
    if (!this.metadata.pageKeyIndex) return 0;
    if (this.metadata.pageKeyIndex.length == 0) return 0;
    const val =
      this.metadata.pageKeyIndex[this.metadata.pageKeyIndex.length - 1].max;
    return val ? bigIntToNumber(val) : 0;
  }

  get spacingModels(): Map<bigint, SpacingInterpolationModel> | null {
    return this.metadata.spacingModels;
  }
  set spacingModels(v: Map<bigint, SpacingInterpolationModel> | null) {
    this.metadata.spacingModels = v;
  }

  makeLayoutReader(
    batches: AsyncIterableIterator<Arrow.RecordBatch>,
  ): BaseLayoutReader {
    const models = this.spacingModels ?? undefined;
    if (this.metadata.format === BufferFormat.Point) {
      return new PointLayoutReader(batches, this.metadata.arrayIndex, models);
    } else if (this.metadata.format === BufferFormat.ChunkValues) {
      return new ChunkLayoutReader(batches, this.metadata.arrayIndex, models);
    }
    throw new Error("Data layout not recognized");
  }

  async get(key_: bigint | number): Promise<Arrow.Table | null> {
    const key = BigInt(key_);
    const rowGroups = this.rowGroupIndex.keysFor(key);
    if (rowGroups.length === 0) return null;
    const offset = this.metadata.findPageFor(key);
    const opts: ReaderOptions = {
      batchSize: 32768,
    };
    if (offset != null) {
      opts.offset = offset.offset;
      if (offset.limit != null) {
        opts.limit = offset.limit;
      }
    }
    const batches = streamArrowBatches(
      this.handle,
      rowGroups.map(Number),
      undefined,
      opts,
    );
    const layoutReader = this.makeLayoutReader(batches);
    return layoutReader.readRowsOf(key, null, null);
  }

  async getRange(start_: bigint | number, end_: bigint | number) {
    const start = BigInt(start_);
    const end = BigInt(end_);
    const iter = await this._getRangeIter(start, end);
    if (iter == null) return null;
    const entries = [];
    for await (const [idx, tab] of iter) {
      if (idx < end) {
        entries.push({ index: idx, dataArrays: tab });
      } else {
        break;
      }
    }
    return entries;
  }

  /**
   * Extract a contiguous region of the coordinate space in an entry index range, like when building and
   * extracted ion chromatogram (XIC)
   *
   * @param indexRange The start and end entry index to extract between, otherwise all entries are used
   * @param coordinateRange The start and end coordinate (e.g. m/z, time) to extract between, otherwise all points are used
   * @returns An array of untimed {@coderef XICPoint}
   */
  async extractRangeFor(
    indexRange: Span1DBigInt | null,
    coordinateRange: Span1D | null = null,
  ) {
    let iter = null;
    let endIdx = null;
    if (indexRange == null) {
      iter = await this.enumerate();
    } else {
      iter = await this._getRangeIter(
        BigInt(indexRange.start),
        BigInt(indexRange.end),
      );
      endIdx = BigInt(indexRange.end);
    }
    if (iter == null) return [];
    const entries = [];
    if (coordinateRange) {
      iter.setQueryCoordinateRange(coordinateRange);
    }
    const sortArr = this.arrayIndex.entries.reduce((last, e) =>
      e.sortingRank != null && e.sortingRank < (last.sortingRank || Infinity)
        ? e
        : last,
    );
    for await (const [index, entry] of iter) {
      if (endIdx != null && endIdx < index) break;
      if (coordinateRange) {
        const coordinatesOf = (entry as Arrow.Table).getChild(
          sortArr.arrayName,
        );
        if (!coordinatesOf)
          throw new Error(`Could not find ${sortArr} in ${entry.schema}`);
        const idxRange = betweenSorted(
          coordinatesOf,
          coordinateRange.start,
          coordinateRange.end,
        );

        // Extract for just the slice of the coordinate dimension
        if (idxRange) {
          entries.push({
            index,
            dataArrays: packTableIntoDataArrays(
              (entry as Arrow.Table).slice(idxRange[0], idxRange[1]),
            ),
          });
        }
      } else {
        // Collect everything
        entries.push({
          index,
          dataArrays: packTableIntoDataArrays(entry as Arrow.Table),
        });
      }
    }
    return entries;
  }

  /**
   * An internal helper method to open a narrower Parquet reading iterator.
   *
   * See {@coderef extractForRange} for the high level interface
   *
   * @param start The entry index to start iterating from
   * @param end The entry index to stop iterating at
   * @returns A peekable iterator between those two points
   */
  async _getRangeIter(start: bigint, end: bigint) {
    const rowGroupsStart = this.rowGroupIndex.keysFor(start);
    const rowGroupsEnd = this.rowGroupIndex.keysFor(end);
    let i = rowGroupsStart[0] ?? 0;
    let skipped = 0;
    for (let j = 0; j < i; j++) {
      skipped += this.handle.metadata().rowGroup(j).numRows();
    }
    const lastRgIdx = rowGroupsEnd[rowGroupsEnd.length - 1] ?? Math.max.apply(null, rowGroupsStart.map(bigIntToNumber));
    const rowGroupsTotal: bigint[] = [];
    while (i <= lastRgIdx) {
      rowGroupsTotal.push(i);
      i++;
    }
    if (rowGroupsTotal.length === 0) return null;
    const offset = this.metadata.findPageForRange(start, end);
    const opts: ReaderOptions = {
      batchSize: 32768,
    };
    if (offset != null) {
      opts.offset = offset.offset;
      if (offset.limit != null) {
        opts.limit = offset.limit;
      }
    }
    const batches = streamArrowBatches(
      this.handle,
      rowGroupsTotal.map(bigIntToNumber),
      undefined,
      opts,
    );
    const iter = new PeekableDataStreamIterator(new DataStreamIterator(this, batches));
    await iter.seek(start);
    return iter;
  }

  /**
   * Open a new streaming iterator for this data file
   *
   * @param batchSize The size of the batch to load from the Parquet at a time
   * @returns An iterator over the entire data file reader
   */
  enumerate(batchSize: number | undefined = 32768): PeekableDataStreamIterator {
    const iter = new DataStreamIterator(
      this,
      streamArrowBatches(this.handle, undefined, undefined, {
        batchSize,
      }),
    );
    return new PeekableDataStreamIterator(iter)
  }

  [Symbol.asyncIterator](): AsyncIterator<[bigint, Arrow.Table | ColumnMap]> {
    return this.enumerate();
  }
}

function vectorEquals<T extends Arrow.DataType>(
  array: Arrow.Vector<T>,
  value: T["TValue"],
) {
  const acc: boolean[] = [];
  for (let v of array) {
    acc.push(v == value);
  }
  return acc;
}

function vectorWhere(mask: boolean[]) {
  const indices: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * An incremental, entry-level data iterator that internally buffers
 * and chunks the linear data stream.
 *
 * This is an {@coderef AsyncIterator}
 */
export class DataStreamIterator
  implements
    AsyncIterator<[bigint, Arrow.Table | ColumnMap]>,
    AsyncIterable<[bigint, Arrow.Table | ColumnMap]>
{
  private reader: DataArraysReader;
  private batchStream: AsyncIterableIterator<Arrow.RecordBatch>;
  private layoutReader: BaseLayoutReader;
  private currentBatch: Arrow.Vector<Arrow.Struct> | null = null;
  private currentIndex: bigint | null = null;
  private _current: [bigint, Arrow.Vector<Arrow.Struct> | ColumnMap] | null =
    null;
  private initialized: boolean = false;

  constructor(
    reader: DataArraysReader,
    batchStream: AsyncIterableIterator<Arrow.RecordBatch>,
  ) {
    this.reader = reader;
    this.batchStream = batchStream;
    this.layoutReader = this.reader.makeLayoutReader(this.batchStream);
  }

  get current(): [bigint, Arrow.Vector<Arrow.Struct> | ColumnMap] {
    if (!this._current)
      throw new Error("Iterator not initialized or exhausted");
    return this._current;
  }

  /**
   * Set the coordinate range to let the iterator make better decisions about
   * how to decode data
   *
   * @param query The coordinate interval to restrict reading for
   */
  setQueryCoordinateRange(query: Span1D | null) {
    this.layoutReader.queryCoordinateRange = query;
  }

  /**
   * Read the next {@code RecordBatch} from the underlying Parquet iterator stream
   * @param updateIndex Whether or not to update `this.currentIndex` from the new batch
   * @returns Whether a new batch was read
   */
  private async readNextBatch(updateIndex: boolean = false) {
    this.currentBatch = null;
    let batchMsg = await this.batchStream.next();
    if (batchMsg.done || batchMsg.value == null) return false;
    const batch = batchMsg.value;
    const root = batch.getChildAt(0) as Arrow.Vector<Arrow.Struct>;
    if (root == null) return false;
    const idxCol = root.getChildAt(0) as Arrow.Vector<Arrow.Uint64>;
    const lowestIndex = idxCol
      .toArray()
      .reduce((prev, cur) => (prev < cur ? prev : cur));
    this.currentBatch = root;
    if (
      updateIndex &&
      ((this.currentIndex !== null && lowestIndex > this.currentIndex) ||
        this.currentIndex === null)
    ) {
      this.currentIndex = lowestIndex;
    }
    return true;
  }

  private async initialize() {
    if (this.initialized) return this.currentBatch != null;
    await this.readNextBatch(true);
    this.initialized = true;
    return this.currentBatch != null;
  }

  private batchHasCurrentIndex() {
    if (this.currentBatch == null || this.currentIndex == null) return false;
    const indexArr = this.currentBatch.getChildAt(
      0,
    ) as Arrow.Vector<Arrow.Uint64>;
    const mask = vectorEquals(indexArr, this.currentIndex);
    return mask.some((e) => e);
  }

  /**
   * Read the next index in the current record batch, which may not be
   * the previous index + 1. This assumes that the batch stream is well
   * formed and ascending.
   *
   * @returns The next earliest index value in the current batch
   */
  private batchNextIndex() {
    if (this.currentBatch == null) return null
    const indexArr = this.currentBatch.getChildAt(
      0,
    ) as Arrow.Vector<Arrow.Uint64>;
    return indexArr.get(0)
  }

  /**
   *
   * @returns The {@coderef Arrow.Vector} for the thing that is the current index
   */
  private async extractForCurrentIndex(): Promise<Arrow.Vector<Arrow.Struct> | null> {
    if (this.currentBatch == null || this.currentIndex == null) return null;
    const indexArr = this.currentBatch.getChildAt(
      0,
    ) as Arrow.Vector<Arrow.Uint64>;
    const mask = vectorEquals(indexArr, this.currentIndex);
    const indices = vectorWhere(mask);
    const lastPossibleRowIndex = this.currentBatch.length - 1;
    let n: number;
    let start: number;
    let chunk: Arrow.Vector<Arrow.Struct>;
    if (indices.length == 0) {
      n = this.currentBatch.length;
      start = 0;
      chunk = this.currentBatch.slice(0, 0);
    } else {
      start = indices[0];
      n = indices.length;
      chunk = this.currentBatch.slice(start, n);
    }

    if (
      n == this.currentBatch.length ||
      indices.includes(lastPossibleRowIndex)
    ) {
      if (await this.readNextBatch(false)) {
        if (this.batchHasCurrentIndex()) {
          const rest = await this.extractForCurrentIndex();
          if (rest) {
            chunk = chunk.concat(rest);
          }
        }
      }
    } else {
      this.currentBatch = this.currentBatch.slice(n, this.currentBatch.length);
    }
    return chunk;
  }

  private async moveNextAsync(doProcess: boolean = true) {
    if (this.currentIndex == null) {
      if (!(await this.initialize())) return false;
    }
    if (this.currentBatch == null) return false;
    if (this.currentIndex == null) return false;
    let nextBatch = await this.extractForCurrentIndex();
    if (nextBatch == null) return false;
    let index = this.currentIndex;
    if (doProcess) {
      const nextBatchUnpacked = this.layoutReader.processRows(index, nextBatch)
      this._current = [index, nextBatchUnpacked]
    } else {
      this._current = [index, nextBatch]
    }
    const nextIndex = this.batchNextIndex()
    if (nextIndex != null) {
      this.currentIndex = nextIndex
    }
    return true;
  }

  async next(): Promise<IteratorResult<[bigint, Arrow.Table | ColumnMap]>> {
    const hasNext = await this.moveNextAsync();
    if (!hasNext) return { done: true, value: undefined as any };
    if (this._current == null) throw new Error("Cannot be null");
    const [entryIndex, arrays] = this._current;

    const final: ColumnMap = {};
    for (let [k, v] of Object.entries(arrays)) {
      const arrayMeta = this.layoutReader.arrayIndex.byFieldName.get(k);
      final[arrayMeta?.arrayName ?? k] = this.layoutReader.handleTransforms(
        arrayMeta,
        entryIndex,
        v,
      );
    }
    const payload: [bigint, Arrow.Table] = [
      entryIndex,
      Arrow.tableFromArrays(final as any) as Arrow.Table,
    ];
    return { done: false, value: payload };
  }

  [Symbol.asyncIterator](): AsyncIterator<[bigint, Arrow.Table | ColumnMap]> {
    return this;
  }
}


/**
 * A wrapper around {@coderef DataStreamIterator} that is peekable, letting the caller
 * ask what the next value is without consuming it.
 */
export class PeekableDataStreamIterator
  implements
    AsyncIterator<[bigint, Arrow.Table | ColumnMap]>,
    AsyncIterable<[bigint, Arrow.Table | ColumnMap]>
{
  inner: DataStreamIterator;
  private peeked: [bigint, Arrow.Table | ColumnMap] | null;

  constructor(inner: DataStreamIterator) {
    this.inner = inner;
    this.peeked = null;
  }

  /** Get the index for the value the underlying iterator is currently at */
  get currentIndex() {
    return this.peeked ? this.peeked[0] : null;
  }

  /**
   * Check the next value from the underlying iterator without "consuming" it.
   *
   * @returns The next [index, table] pair that the iterator will produce, if more data are available
   */
  async peek() {
    if (this.peeked == null) {
      const { done, value } = await this.inner.next();
      if (done) {
        return null;
      }
      this.peeked = value;
    }
    return this.peeked;
  }

  /**
   * Fetch the next value from the iterator
   *
   * @returns The next [index, table] pair
   */
  async next() {
    if (this.peeked) {
      const value = this.peeked;
      this.peeked = null;
      await this.peek();
      return { done: false, value };
    } else {
      return await this.inner.next();
    }
  }

  async seek(index_: bigint) {
    const index = BigInt(index_);
    let next = await this.peek();
    if (!next) {
      return false;
    }
    if (next[0] > index) {
      throw new Error("Cannot rewind iterator");
    }
    if (next[0] == index) {
      return true;
    } else {
      // Consume the current value as we know it does not apply
      await this.next();
      while (true) {
        next = await this.peek();
        if (!next) {
          return false;
        }
        // Found it
        if (next[0] == index) {
          return true;
        }
        // The next value avilable is beyond `index`, stop searching
        if (next[0] > index) {
          return false;
        }
        // Advance to the next value, this step doesn't satisfy
        await this.next();
      }
    }
  }

  /**
   * Set the coordinate range to let the iterator make better decisions about
   * how to decode data
   *
   * @param query The coordinate interval to restrict reading for
   */
  setQueryCoordinateRange(query: Span1D | null) {
    this.inner.setQueryCoordinateRange(query);
  }

  [Symbol.asyncIterator](): AsyncIterator<[bigint, Arrow.Table | ColumnMap]> {
    return this;
  }
}