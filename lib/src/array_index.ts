import * as Arrow from "apache-arrow";

export enum BufferFormat {
  Point = "point",
  ChunkValues = "chunk_values",
  ChunkStart = "chunk_start",
  ChunkEnd = "chunk_end",
  ChunkEncoding = "chunk_encoding",
  ChunkSecondary = "chunk_secondary",
  ChunkTransform = "chunk_transform",
}

export function bufferFormatFromString(s: string): BufferFormat {
  switch (s) {
    case "point":
      return BufferFormat.Point;
    case "chunk_values":
      return BufferFormat.ChunkValues;
    case "chunk_start":
      return BufferFormat.ChunkStart;
    case "chunk_end":
      return BufferFormat.ChunkEnd;
    case "chunk_encoding":
      return BufferFormat.ChunkEncoding;
    case "secondary_chunk":
    case "chunk_secondary":
      return BufferFormat.ChunkSecondary;
    case "chunk_transform":
      return BufferFormat.ChunkTransform;
    default:
      throw new Error(`${s} is not a recognized buffer format`);
  }
}

export enum BufferPriority {
  Primary = "primary",
  Secondary = "secondary",
}

export enum BufferContext {
  Spectrum = "spectrum",
  Chromatogram = "chromatogram",
  WavelengthSpectrum = "wavelength_spectrum",
}

export function bufferContextIndexName(context: BufferContext): string {
  switch (context) {
    case BufferContext.Spectrum:
      return "spectrum_index";
    case BufferContext.Chromatogram:
      return "chromatogram_index";
    case BufferContext.WavelengthSpectrum:
      return "wavelength_spectrum_index";
  }
}

export function bufferContextName(context: BufferContext): string {
  switch (context) {
    case BufferContext.Spectrum:
      return "spectrum";
    case BufferContext.Chromatogram:
      return "chromatogram";
    case BufferContext.WavelengthSpectrum:
      return "wavelength_spectrum";
  }
}

export class ArrayIndexEntry {
  context: BufferContext;
  path: string;
  dataTypeCURIE: string;
  arrayTypeCURIE: string;
  arrayName: string;
  unitCURIE: string | null;
  transform: string | null;
  bufferFormat: BufferFormat;
  dataProcessingId: string | null;
  bufferPriority: BufferPriority | null;
  sortingRank: number | null;
  /** Populated at runtime; not serialized. */
  schemaIndex: number | null;

  constructor(
    context: BufferContext,
    path: string,
    dataTypeCURIE: string,
    arrayTypeCURIE: string,
    arrayName: string,
    bufferFormat: BufferFormat,
    unitCURIE: string | null = null,
    transform: string | null = null,
    dataProcessingId: string | null = null,
    bufferPriority: BufferPriority | null = null,
    sortingRank: number | null = null,
  ) {
    this.context = context;
    this.path = path;
    this.dataTypeCURIE = dataTypeCURIE;
    this.arrayTypeCURIE = arrayTypeCURIE;
    this.arrayName = arrayName;
    this.bufferFormat = bufferFormat;
    this.unitCURIE = unitCURIE;
    this.transform = transform;
    this.dataProcessingId = dataProcessingId;
    this.bufferPriority = bufferPriority;
    this.sortingRank = sortingRank;
    this.schemaIndex = null;
  }

  static fromJSON(obj: any): ArrayIndexEntry {
    return new ArrayIndexEntry(
      obj.context as BufferContext,
      obj.path,
      obj.data_type,
      obj.array_type,
      obj.array_name,
      bufferFormatFromString(obj.buffer_format),
      obj.unit ?? null,
      obj.transform ?? null,
      obj.data_processing_id ?? null,
      obj.buffer_priority ? (obj.buffer_priority as BufferPriority) : null,
      obj.sorting_rank ?? null,
    );
  }

  createColumnName(): string {
    const notAlpha = /[^A-Za-z_]+/g;
    const arrayName = this.arrayName
      .replace("m/z", "mz")
      .replace(" array", "")
      .trim()
      .replace(notAlpha, "_");
    if (this.bufferPriority === BufferPriority.Primary) {
      return arrayName;
    }
    // TODO: resolve dtype/unit short names from controlled vocabulary
    const dtypeName = this.dataTypeCURIE;
    const unitName = this.unitCURIE;
    if (unitName != null) {
      return [arrayName, dtypeName, unitName].join("_");
    } else {
      return [arrayName, dtypeName].join("_");
    }
  }

  equals(other: ArrayIndexEntry): boolean {
    return (
      this.arrayName === other.arrayName &&
      this.arrayTypeCURIE === other.arrayTypeCURIE &&
      this.dataProcessingId === other.dataProcessingId &&
      this.dataTypeCURIE === other.dataTypeCURIE &&
      this.transform === other.transform &&
      this.unitCURIE === other.unitCURIE
    );
  }

  get fieldName() {
    const tokens = this.path.split(".");
    return tokens[tokens.length - 1];
  }


  arrowBuilder() {
    switch (this.dataTypeCURIE) {
      case "MS:1000523":
        return Arrow.makeBuilder({
          type: new Arrow.Float64(),
          nullValues: [null, undefined],
        });
      case "MS:1000521":
        return Arrow.makeBuilder({
          type: new Arrow.Float32(),
          nullValues: [null, undefined],
        });
      case "MS:1000519":
        return Arrow.makeBuilder({
          type: new Arrow.Int32(),
          nullValues: [null, undefined],
        });
      case "MS:1000522":
        return Arrow.makeBuilder({
          type: new Arrow.Int64(),
          nullValues: [null, undefined],
        });
      case "MS:1000479":
        return Arrow.makeBuilder({
          type: new Arrow.Uint8(),
          nullValues: [null, undefined],
        });
      default:
        throw new Error(`Data type ${this.dataTypeCURIE} is not implemented`);
    }
  }

  emptyArrow() {
    switch (this.dataTypeCURIE) {
      case "MS:1000523":
        return Arrow.makeVector(new Float64Array([]));
      case "MS:1000521":
        return Arrow.makeVector(new Float32Array([]));
      case "MS:1000519":
        return Arrow.makeVector(new Int32Array([]));
      case "MS:1000522":
        return Arrow.makeVector(new BigInt64Array([]));
      case "MS:1000479":
        return Arrow.makeVector(new Uint8Array([]));
      default:
        throw new Error(`Data type ${this.dataTypeCURIE} is not implemented`);
    }
  }
}

export class ArrayIndex {
  prefix: string;
  entries: ArrayIndexEntry[];

  byFieldName: Map<string, ArrayIndexEntry>;

  constructor(prefix: string = "?", entries: ArrayIndexEntry[] = []) {
    this.prefix = prefix;
    this.entries = entries;
    this.byFieldName = new Map();
    this.rebuildFieldNameMap();
  }

  rebuildFieldNameMap() {
    this.byFieldName.clear();
    for (let e of this.entries) {
      this.byFieldName.set(e.fieldName, e);
    }
  }

  annotateFromSchema(schema: Arrow.Schema) {
    const rootNode = schema.fields[0];
    let buffer = [rootNode.name];
    const columnBuffers = (rootNode.type as Arrow.Struct).children;
    for (let i = 0; i < columnBuffers.length; i++) {
      const field = columnBuffers[i];
      buffer.push(field.name);
      const pathOf = buffer.join(".");
      for (const entry of this.entries) {
        if (entry.path === pathOf) entry.schemaIndex = i;
      }
      buffer.pop();
    }
  }

  static fromJSON(obj: any): ArrayIndex {
    const entries = (obj.entries as any[]).map(ArrayIndexEntry.fromJSON);
    return new ArrayIndex(obj.prefix, entries);
  }

  hasArrayType(arrayTypeCURIE: string): boolean {
    return this.entries.some((e) => e.arrayTypeCURIE === arrayTypeCURIE);
  }

  entriesFor(arrayTypeCURIE: string): ArrayIndexEntry[] {
    return this.entries.filter((e) => e.arrayTypeCURIE === arrayTypeCURIE);
  }

  inferBufferFormat(): BufferFormat | null {
    if (this.entries[0].bufferFormat === BufferFormat.Point) {
      return BufferFormat.Point;
    }
    switch (this.entries[0].bufferFormat) {
      case BufferFormat.ChunkEncoding:
      case BufferFormat.ChunkSecondary:
      case BufferFormat.ChunkEnd:
      case BufferFormat.ChunkStart:
      case BufferFormat.ChunkTransform:
      case BufferFormat.ChunkValues:
        return BufferFormat.ChunkValues;
      default:
        return null;
    }
  }
}
