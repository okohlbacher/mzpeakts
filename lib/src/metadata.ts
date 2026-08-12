import * as Arrow from "apache-arrow";
import * as ArrowFFI from "arrow-js-ffi";
import { ParquetFile, wasmMemory, FFIStream } from "parquet-wasm";

import { binarySearch, binarySearchAll, Span1DBigInt } from "./utils";
import { bigIntToNumber } from "apache-arrow/util/bigint";
import { SpacingInterpolationModel } from "./data";
import {
  Spectrum,
  ParamDescribed,
  MetadataTree,
  SpectrumBuilder,
  ScanBuilder,
  SelectedIonBuilder,
  ChromatogramBuilder,
  PrecursorBuilder,
} from "./record";
import {
  DataKindTag,
  EntityType,
  EntityTypeTag,
  FileIndex,
  FileIndexEntry,
  ZipStorage,
  DataKind,
  MetadataColumn,
} from "./store";

const DATA_POINT_COUNT_ACC = "MS:1003060";
const PEAK_COUNT_ACC = "MS:1003059";

// arrow-js-ffi imports the C-interface Large* types with typeIds apache-arrow's visitor
// dispatch cannot resolve (LargeList → 30, `Type[30]` undefined). Downgrade to the
// equivalent small-offset variants — which is what the FFI already produces for the data.
function compatType(t: Arrow.DataType): Arrow.DataType {
  const a = t as any;
  switch ((t as any)[Symbol.toStringTag]) {
    case "LargeList":
    case "List":
      return new Arrow.List(compatField(a.children[0]));
    case "LargeUtf8":
      return new Arrow.Utf8();
    case "LargeBinary":
      return new Arrow.Binary();
    case "Struct":
      return new Arrow.Struct(a.children.map(compatField));
    case "FixedSizeList":
      return new Arrow.FixedSizeList(a.listSize, compatField(a.children[0]));
    case "Map":
    case "Map_":
      return new Arrow.Map_(compatField(a.children[0]), a.keysSorted);
    default:
      return t;
  }
}

function compatField(f: Arrow.Field): Arrow.Field {
  return new Arrow.Field(f.name, compatType(f.type), f.nullable, f.metadata);
}

// An empty (0-row) facet still needs a struct Vector whose children are real Data instances,
// otherwise getChild/getChildAt throws "Vector constructor expects an Array of Data
// instances" the moment any spectrum with empty precursors/selected_ions is read. Build one
// empty child Data per field (types coerced so the Large* shim's bad typeIds never surface).
function emptyStructVecFrom(type: Arrow.Struct) {
  const fields = type.children.map(compatField);
  const children = fields.map((f) => Arrow.makeData({ type: f.type, length: 0 }));
  return Arrow.makeVector(
    Arrow.makeData({ type: new Arrow.Struct(fields), length: 0, children }),
  );
}

/**
 * Convert a WASM FFI stream of Arrow data into a JavaScript Arrow.Vector<Struct> instance, circumventing certain
 * compatibility breakdowns from the LargeList support shim in `arrow-js-ffi`.
 *
 * @param ffi A WASM FFIStream owning the underlying Arrow data in an exportable format. It will be destroyed by this call!
 */
export function wasmArrowToArrowJS(ffi: FFIStream): Arrow.Vector<Arrow.Struct> {
  const mem = wasmMemory();
  const schema = ArrowFFI.parseSchema(mem.buffer, ffi.schemaAddr());
  const dtype = new Arrow.Struct(schema.fields);
  const chunks = [];
  for (let i = 0; i < ffi.numArrays(); i++) {
    const ptr = ffi.arrayAddr(i);
    const structData = ArrowFFI.parseData(mem.buffer, ptr, dtype, true);
    chunks.push(Arrow.makeVector(structData));
  }
  ffi.drop();

  if (chunks.length == 0) return emptyStructVecFrom(dtype);
  else if (chunks.length == 1) return chunks[0];
  else return chunks[0].concat(...chunks.slice(1));
}

export class Param {
  name: string;
  value: any | null = null;
  accession: string | null = null;
  unit: string | null = null;

  constructor(
    name: string,
    value: any | null,
    accession: string | null = null,
    unit: string | null = null,
  ) {
    this.name = name;
    this.value = value;
    this.accession = accession;
    this.unit = unit;
  }

  static fromJSON(raw: any) {
    return new Param(raw.name, raw.value, raw.accession, raw.unit);
  }

  static fromArrow(array: Arrow.Vector | null | undefined) {
    if (!array) return [];
    const names = array.getChild("name") as Arrow.Vector<Arrow.Utf8>;
    const accessions = array.getChild("accession") as Arrow.Vector<Arrow.Utf8>;
    const units = array.getChild("unit") as Arrow.Vector<Arrow.Utf8>;
    const values = array.getChild("value") as Arrow.Vector<Arrow.Struct>;

    if (names == null || accessions == null || units == null || values == null)
      throw new Error(`Cannot convert ${array} to Param array`);
    return Array.from(names).map((name, i) => {
      if (name == null) throw new Error(`A Param name cannot be null`);
      const acc = accessions.get(i);
      const unit = units.get(i);
      const val = values.get(i);
      if (val == null) {
        return new this(name, val, acc, unit);
      } else {
        const typedVal = Object.values(val.toJSON()).filter((v) => v != null);
        let valueFor = null;
        if (typedVal.length) {
          valueFor = typedVal[0];
        }
        return new this(name, valueFor, acc, unit);
      }
    });
  }
}

export class SourceFile extends ParamDescribed {
  id: string;
  name: string;
  location: string;

  constructor(id: string, name: string, location: string, parameters: Param[]) {
    super(parameters);
    this.id = id;
    this.name = name;
    this.location = location;
  }

  static fromJSON(raw: any) {
    const parameters = (raw.parameters as Array<any>).map(Param.fromJSON);
    return new SourceFile(raw.id, raw.name, raw.location, parameters);
  }
}

export class FileDescription {
  contents: Param[];
  sourceFiles: SourceFile[];

  constructor(contents: Param[], sourceFiles: SourceFile[]) {
    this.contents = contents;
    this.sourceFiles = sourceFiles;
  }

  static fromJSON(raw: any) {
    const contents = (raw.contents as Array<any>).map(Param.fromJSON);
    const sourceFiles = (raw.source_files as Array<any>).map(
      SourceFile.fromJSON,
    );
    return new FileDescription(contents, sourceFiles);
  }
}

export class InstrumentComponent extends ParamDescribed {
  componentType: string;
  order: number;

  constructor(componentType: string, order: number, parameters: Param[]) {
    super(parameters);
    this.componentType = componentType;
    this.order = order;
  }

  static fromJSON(raw: any) {
    const parameters = (raw.parameters as Array<any>).map(Param.fromJSON);
    return new InstrumentComponent(raw.component_type, raw.order, parameters);
  }
}

export class InstrumentConfiguration extends ParamDescribed {
  id: number;
  components: InstrumentComponent[];
  softwareReference?: string;

  constructor(
    id: number,
    components: InstrumentComponent[],
    parameters: Param[],
    softwareReference?: string,
  ) {
    super(parameters);
    this.id = id;
    this.components = components;
    this.softwareReference = softwareReference;
  }

  static fromJSON(raw: any) {
    const components = (raw.components as any[]).map(
      InstrumentComponent.fromJSON,
    );
    const params = (raw.parameters as any[]).map(Param.fromJSON);
    return new InstrumentConfiguration(
      raw.id,
      components,
      params,
      raw.software_reference,
    );
  }
}

export class ProcessingMethod extends ParamDescribed {
  order: number;

  constructor(order: number, parameters: Param[]) {
    super(parameters);
    this.order = order;
  }

  static fromJSON(raw: any) {
    return new ProcessingMethod(
      raw["order"],
      (raw["parameters"] as any[]).map(Param.fromJSON),
    );
  }
}

export class DataProcessingMethod {
  id: string;
  methods: ProcessingMethod[];

  constructor(id: string, methods: ProcessingMethod[]) {
    this.id = id;
    this.methods = methods;
  }

  static fromJSON(raw: any) {
    return new DataProcessingMethod(
      raw.id,
      (raw["methods"] as any[]).map(ProcessingMethod.fromJSON),
    );
  }
}

export class Software extends ParamDescribed {
  id: string;
  version: string;

  constructor(id: string, version: string, parameters: Param[]) {
    super(parameters);
    this.id = id;
    this.version = version;
  }

  static fromJSON(raw: any) {
    return new Software(
      raw.id,
      raw.version,
      (raw["parameters"] as any[]).map(Param.fromJSON),
    );
  }
}

export class Sample extends ParamDescribed {
  id: string;
  name: string;

  constructor(id: string, name: string, parameters: Param[]) {
    super(parameters);
    this.id = id;
    this.name = name;
  }

  static fromJSON(raw: any) {
    return new Sample(
      raw.id,
      raw.name,
      (raw["parameters"] as any[]).map(Param.fromJSON),
    );
  }
}

export class MSRun {
  id: string;
  defaultDataProcessingId?: string;
  defaultInstrumentId?: number;
  defaultSourceFileId?: string;
  startTime?: Date;

  constructor(
    id: string,
    defaultDataProcessingId?: string,
    defaultInstrumentId?: number,
    defaultSourceFileId?: string,
    startTime?: Date,
  ) {
    this.id = id;
    this.defaultDataProcessingId = defaultDataProcessingId;
    this.defaultInstrumentId = defaultInstrumentId;
    this.defaultSourceFileId = defaultSourceFileId;
    this.startTime = startTime;
  }

  static fromJSON(raw: any) {
    return new MSRun(
      raw.id,
      raw.default_data_processing_id,
      raw.default_instrument_id,
      raw.default_source_file_id,
      raw.start_time ? new Date(raw.start_time) : undefined,
    );
  }
}

export class FileMetadata {
  fileDescription: FileDescription;
  instrumentConfigurations: InstrumentConfiguration[];
  software: Software[];
  samples: Sample[];
  dataProcessingMethods: DataProcessingMethod[];
  run?: MSRun;

  constructor(
    fileDescription: FileDescription,
    instrumentConfigurations: InstrumentConfiguration[],
    software: Software[],
    samples: Sample[],
    dataProcessingMethods: DataProcessingMethod[],
    run?: MSRun,
  ) {
    this.fileDescription = fileDescription;
    this.instrumentConfigurations = instrumentConfigurations ?? [];
    this.software = software ?? [];
    this.samples = samples ?? [];
    this.dataProcessingMethods = dataProcessingMethods ?? [];
    this.run = run;
  }

  static empty() {
    return new FileMetadata(new FileDescription([], []), [], [], [], []);
  }

  static fromParquet(handle: ParquetFile) {
    const meta = handle.metadata().fileMetadata().keyValueMetadata();
    let raw = meta.get("file_description");
    const fileDescription = raw
      ? FileDescription.fromJSON(JSON.parse(raw))
      : new FileDescription([], []);
    raw = meta.get("instrument_configuration_list");
    const instrumentConfigs = raw
      ? (JSON.parse(raw) as any[]).map(InstrumentConfiguration.fromJSON)
      : [];
    raw = meta.get("data_processing_method_list");
    const dpMethods = raw
      ? JSON.parse(raw).map(DataProcessingMethod.fromJSON)
      : [];
    raw = meta.get("software_list");
    const softwares = raw ? JSON.parse(raw).map(Software.fromJSON) : [];
    raw = meta.get("sample_list");
    const samples = raw ? JSON.parse(raw).map(Sample.fromJSON) : [];
    raw = meta.get("run");
    const run = raw ? MSRun.fromJSON(JSON.parse(raw)) : undefined;
    return new FileMetadata(
      fileDescription,
      instrumentConfigs,
      softwares,
      samples,
      dpMethods,
      run,
    );
  }
}

abstract class MetadataReaderBase {
  /** The backing Parquet file */
  handle: ParquetTableNamespace;
  metadataTrees: Map<string, MetadataTree>;
  /** Whether the {@link init} method has been called, which asynchronously loads data */
  initialized: boolean = false;
  dataPointCountColumn: string | null;
  peakCountColumn: string | null;

  /**
   * The basic constructor for {@link MetadataReaderBase} instances. This does not
   * complete the initialization process. Call the asynchronous {@link init} method
   * to finish loading data.
   *
   * @param handle The Parquet file this reader uses
   */
  constructor(handle: ParquetTableNamespace) {
    this.handle = handle;
    this.metadataTrees = new Map();
    for (let [k, v] of handle.metadataMap()) {
      this.metadataTrees.set(k, MetadataTree.fromMetadataMap(v));
    }
    this.initialized = false;
    this.peakCountColumn = null;
    this.dataPointCountColumn = null;
    const root = this.metadataTrees.get(DataKindTag.Metadata);
    this.dataPointCountColumn =
      root?.columnForCURIE(DATA_POINT_COUNT_ACC)?.[0] ?? null;
    this.peakCountColumn = root?.columnForCURIE(PEAK_COUNT_ACC)?.[0] ?? null;
  }

  mappingsFor(kind: string) {
    return this.metadataTrees.get(kind);
  }

  protected get _mainStruct(): Arrow.Vector<Arrow.Struct> | null {
    throw new Error("Most override");
  }

  /**
   * Get the number of profile data points for this entry
   * @returns {integer} the number of points
   * */
  dataPointCount(index: number): number | null;
  /**
   * Get the array of profile data points for this entry
   * @returns {Arrow.Vector<Arrow.Uint64>} the array number of points
   * */
  dataPointCount(): null | Arrow.Vector<Arrow.Uint64>;
  dataPointCount(
    index: number | undefined = undefined,
  ): number | null | Arrow.Vector<Arrow.Uint64> {
    if (!this.dataPointCountColumn) return null;
    const main = this._mainStruct;
    const counter: Arrow.Vector<Arrow.Uint64> | null = main?.getChild(
      this.dataPointCountColumn,
    ) as any;
    if (index == undefined) {
      return counter;
    }
    if (counter == null) {
      return null;
    } else {
      const val = counter.get(index);
      return val == null ? null : bigIntToNumber(val);
    }
  }

  /** Get the number of peaks for this entry
   * @returns {integer} the number of peaks
   */
  peakCount(index: number): number | null;
  /**
   * Get the array of peak counts for this entry
   * @returns {Arrow.Vector<Arrow.Uint64>} the array number of peaks
   * */
  peakCount(): null | Arrow.Vector<Arrow.Uint64>;
  peakCount(
    index: number | undefined = undefined,
  ): number | null | Arrow.Vector<Arrow.Uint64> {
    if (!this.peakCountColumn) return null;
    const main = this._mainStruct;
    const counter: Arrow.Vector<Arrow.Uint64> | null = main?.getChild(
      this.peakCountColumn,
    ) as any;
    if (index == undefined) {
      return counter;
    }
    if (counter == null) {
      return null;
    } else {
      const val = counter.get(index);
      return val == null ? null : bigIntToNumber(val);
    }
  }

  /**
   * Asynchronously load metadata tables from Parquet file
   */
  async init(): Promise<this> {
    throw new Error("Must override init");
  }

  /** Get the number of entries of the main data sequence in this reader */
  get length(): number {
    return this.initialized && this._mainStruct ? this._mainStruct.length : 0;
  }
}


const parquetHasColumn = (handle: ParquetFile, name: string) => {
  return handle
    .metadata()
    .rowGroup(0)
    .columns()
    ?.find((c) => c.columnPath().join(".") == name) != undefined
}


const parquetColumnStatistics = (handle: ParquetFile, name: string) : {summary: {min_value: any, max_value: any}, rowGroups: any[]} | null => {
  const meta = handle.metadata()
  const rowGroups = []
  let colIdx = null;
  for(let i = 0; i < meta.numRowGroups(); i++) {
    const rg = meta.rowGroup(i);
    if (colIdx == null) {
      const foundIdx = rg.columns().findIndex((c) => c.columnPath().join(".") == name);
      if (foundIdx == -1) return null;
      colIdx = foundIdx;
    }
    const col = rg.column(colIdx)
    rowGroups.push(col.statistics())
  }
  const summary = rowGroups.reduce((state: {min_value: any, max_value: any}, colStats) => {
    return {
      min_value: state.min_value
        ? Math.min(state.min_value, colStats.min_value)
        : colStats.min_value,
      max_value: state.max_value
        ? Math.max(state.max_value, colStats.max_value)
        : colStats.max_value,
    };
  }, {min_value: undefined, max_value: undefined})

  return {summary, rowGroups}
}

export class ParquetTableNamespace {
  fileIndex: FileIndex;
  entityType: EntityType;
  metadata: ParquetFile | null = null;
  scans: ParquetFile | null = null;
  precursors: ParquetFile | null = null;
  selectedIons: ParquetFile | null = null;
  products: ParquetFile | null = null;

  constructor(fileIndex: FileIndex, entityType: EntityType) {
    this.fileIndex = fileIndex;
    this.entityType = entityType;
    this.metadata = null;
    this.scans = null;
    this.precursors = null;
    this.selectedIons = null;
    this.products = null;
  }

  hasMetadata() {
    return this.metadata != null;
  }

  facetHasColumn(facet: DataKindTag, name: string) {
    switch (facet) {
      case DataKindTag.Metadata:
        return this.metadata ? parquetHasColumn(this.metadata, name) : false;
      case DataKindTag.Precursors:
        return this.precursors
          ? parquetHasColumn(this.precursors, name)
          : false;
      case DataKindTag.SelectedIons:
        return this.selectedIons
          ? parquetHasColumn(this.selectedIons, name)
          : false;
      case DataKindTag.Scans:
        return this.scans
          ? parquetHasColumn(this.scans, name)
          : false;
      case DataKindTag.Products:
        return this.products
          ? parquetHasColumn(this.products, name)
          : false;
      default:
        return false
    }
  }

  facetColumnMinMaxes(facet: DataKindTag, name: string) {
    switch (facet) {
      case DataKindTag.Metadata:
        return this.metadata ? parquetColumnStatistics(this.metadata, name) : null;
      case DataKindTag.Precursors:
        return this.precursors
          ? parquetColumnStatistics(this.precursors, name)
          : null;
      case DataKindTag.SelectedIons:
        return this.selectedIons
          ? parquetColumnStatistics(this.selectedIons, name)
          : null;
      case DataKindTag.Scans:
        return this.scans ? parquetColumnStatistics(this.scans, name) : null;
      case DataKindTag.Products:
        return this.products ? parquetColumnStatistics(this.products, name) : null;
      default:
        return null;
    }
  }

  static async populateFromStorage<T>(
    storage: ZipStorage<T>,
    entityType: EntityType | EntityTypeTag,
  ) {
    const self = new ParquetTableNamespace(
      storage.fileIndex,
      entityType instanceof EntityType
        ? entityType
        : EntityType.fromString(entityType),
    );
    const filesOf = self.fileIndex.files.filter((f) =>
      f.entityType.equals(self.entityType),
    );

    const opener = async (f: FileIndexEntry) => {
      const handle = await ParquetFile.fromFile(
        (await storage.openFromIndex(f.entityType, f.dataKind)) as any as Blob,
      );
      return handle;
    };

    for (let f of filesOf) {
      switch (`${f.dataKind.tag}`) {
        case DataKindTag.Metadata:
          self.metadata = await opener(f);
          break;
        case DataKindTag.Scans:
          self.scans = await opener(f);
          break;
        case DataKindTag.Precursors:
          self.precursors = await opener(f);
          break;
        case DataKindTag.SelectedIons:
          self.selectedIons = await opener(f);
          break;
        case DataKindTag.Products:
          self.products = await opener(f);
          break;
        case DataKindTag.DataArrays:
        case DataKindTag.Peaks:
          break;
        case DataKindTag.Proprietary:
        case DataKindTag.Other:
        default:
          console.log("Failed to handle", f);
      }
    }
    return self;
  }

  indexEntry(dataKind: DataKind | DataKindTag) {
    const hits = this.fileIndex.files.filter(
      (e) =>
        e.dataKind.equals(dataKind) && e.entityType.equals(this.entityType),
    );
    return hits.length ? null : hits[0];
  }

  metadataMap(): Map<string, MetadataColumn[]> {
    const result = new Map();
    this.fileIndex.files
      .filter(
        (e) =>
          e.entityType.equals(this.entityType) &&
          e.column_mapping &&
          e.column_mapping.length > 0,
      )
      .forEach((e) => {
        result.set(e.dataKind.name, e.column_mapping);
      });
    return result;
  }

  async readMetadata() {
    if (this.metadata) {
      return await this.readToVector(this.metadata);
    } else {
      return null;
    }
  }

  async readScans() {
    if (this.scans) {
      return await this.readToVector(this.scans);
    } else {
      return null;
    }
  }

  async readPrecursors() {
    if (this.precursors) {
      return await this.readToVector(this.precursors);
    } else {
      return null;
    }
  }

  async readSelectedIons() {
    if (this.selectedIons) {
      return await this.readToVector(this.selectedIons);
    } else {
      return null;
    }
  }

  async readProducts() {
    if (this.products) {
      return await this.readToVector(this.products);
    } else {
      return null;
    }
  }

  /**
   * Read the Parquet file completely into memory.
   * @returns An Arrow {@link Arrow.Table}
   */
  async readToVector(handle: ParquetFile) {
    const tab = await handle.read();
    const ffi = tab.intoFFI();
    return wasmArrowToArrowJS(ffi);
  }
}

export class SpectrumMetadata extends MetadataReaderBase {
  _spectra: Arrow.Vector<Arrow.Struct> | null;
  _scans: Arrow.Vector<Arrow.Struct> | null;
  _precursors: Arrow.Vector<Arrow.Struct> | null;
  _selectedIons: Arrow.Vector<Arrow.Struct> | null;

  constructor(handle: ParquetTableNamespace) {
    super(handle);
    this._spectra = null;
    this._scans = null;
    this._precursors = null;
    this._selectedIons = null;
  }

  /**
   * Convert a time range to a contiguous span of indices
   *
   * @param start The starting time in minutes
   * @param end The ending time in minutes
   * @returns The index range that corresponds to the time interval requested
   */
  timeRangeToIndices(start: number, end: number): Span1DBigInt | null {
    if (!this._spectra)
      throw new Error("Cannot query spectrum indices, table not loaded");
    const indexArr = this._spectra.getChildAt(0) as Arrow.Vector<Arrow.Uint64>;
    const timeArr = this._spectra.getChild("time") as Arrow.Vector<Arrow.Float>;
    let startedAt: number | null = null;

    for (let i = 0; i < timeArr.length; i++) {
      let val = timeArr.get(i);
      if (val == null) continue;
      if (startedAt == null) {
        if (val >= start) {
          startedAt = i;
        }
      } else if (val > end) {
        if (startedAt != null) {
          return {
            start: indexArr.get(startedAt) as bigint,
            end: indexArr.get(i) as bigint,
          };
        } else {
          return null;
        }
      }
    }
    if (startedAt != null) {
      return {
        start: indexArr.get(startedAt) as bigint,
        end: indexArr.get(indexArr.length - 1) as bigint,
      };
    } else {
      return null;
    }
  }

  /**
   * Read the run-level metadata from the Parquet file footer
   *
   * @returns {FileMetadata} The run level metadata
   */
  fileMetadata() {
    if (this.handle.metadata)
      return FileMetadata.fromParquet(this.handle.metadata);
    else return FileMetadata.empty();
  }

  static async fromNamespace(handle: ParquetTableNamespace) {
    const self = new this(handle);
    return await self.init();
  }

  protected get _mainStruct() {
    return this._spectra;
  }

  async init() {
    if (this.initialized) return this;

    this._spectra = await this.handle.readMetadata();
    this._scans = await this.handle.readScans();
    this._precursors = await this.handle.readPrecursors();
    this._selectedIons = await this.handle.readSelectedIons();
    this.initialized = true;
    return this;
  }

  /**
   * Find the minimum (MS:1000528) and maximum (MS:1000527) m/z values across all spectra
   * @returns The column min/max values or null aren't  available
   */
  mzRange(): { min: number | undefined; max: number | undefined } | null {
    const metas = this.metadataTrees.get(DataKindTag.Metadata);
    const lowCol = metas?.columnForCURIE("MS:1000528");
    const hiCol = metas?.columnForCURIE("MS:1000527");
    if (lowCol && hiCol) {
      const low = this.handle.facetColumnMinMaxes(
        DataKindTag.Metadata,
        lowCol[0],
      );
      const hi = this.handle.facetColumnMinMaxes(
        DataKindTag.Metadata,
        hiCol[0],
      );
      return { min: low?.summary.min_value, max: hi?.summary.max_value };
    } else {
      return null;
    }
  }

  /**
   * Load the spacing models from the metadata table.
   *
   * @returns A mapping to {@coderef SpacingInterpolationModel} for spectra with a fitted model.
   */
  loadSpacingModelIndex(): Map<bigint, SpacingInterpolationModel> | null {
    if (this.spectra === null) return null;
    const indexArr = this.spectra.getChildAt(0) as Arrow.Vector<Arrow.Uint64>;
    const spacingModels = this.spectra.getChild(
      "mz_delta_model",
    ) as Arrow.Vector<Arrow.List<Arrow.Float64>> | null;
    if (spacingModels == null) return null;
    const modelIndex = new Map();
    for (let i = 0; i < indexArr.length; i++) {
      const key = indexArr.get(i);
      if (key == null) continue;
      const coefs = spacingModels.get(i);
      if (coefs == null) continue;
      const model = SpacingInterpolationModel.fromArrow(coefs);
      modelIndex.set(key, model);
    }
    return modelIndex;
  }

  get spectra() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._spectra;
  }

  get scans() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._scans;
  }

  get precursors() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._precursors;
  }

  get selectedIons() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._selectedIons;
  }

  /**
   * Fetch the metadata record
   * @param index The index of the spectrum to read out
   * @returns The metadata record for a {@coderef Spectrum}
   */
  get(index: number | bigint): Spectrum {
    if (index >= this.length) throw new Error("Index out of range");
    let index_ = bigIntToNumber(index);
    let index_n = BigInt(index);
    if (this.spectra == null) throw new Error("Invalid state");

    let indexArr = this.spectra?.getChild(
      "index",
    ) as Arrow.Vector<Arrow.Uint64>;
    let row = indexArr.get(index_);
    if (row != index_n) {
      const offset = binarySearch(indexArr, index_n);
      row = indexArr.get(offset);
    }

    let tree = this.metadataTrees.get(DataKindTag.Metadata);
    if (!tree) tree = MetadataTree.fromMetadataMap([]);
    let builder = new SpectrumBuilder(tree);
    const spectrumRecord = builder
      .visit(this.spectra.slice(index_, index_ + 1))
      .finish()[0];

    if (!spectrumRecord)
      throw new Error("Invalid state, spectrum record not found");
    indexArr = this.scans?.getChild(
      "source_index",
    ) as Arrow.Vector<Arrow.Uint64>;
    let offsets = binarySearchAll(indexArr, index_n);

    if (offsets && this.scans) {
      const scanCols =
        this.metadataTrees.get(DataKindTag.Scans) ?? MetadataTree.empty();
      const builder = new ScanBuilder(scanCols);
      spectrumRecord.scans = builder
        .visit(this.scans.slice(offsets[0], offsets[1]))
        .finish()
        .filter((v) => v != null);
    }

    if (this.precursors != null) {
      indexArr = this.precursors?.getChild(
        "source_index",
      ) as Arrow.Vector<Arrow.Uint64>;
      const precursorCols =
        this.metadataTrees.get(DataKindTag.Precursors) ?? MetadataTree.empty();
      const precursorBuilder = new PrecursorBuilder(precursorCols);
      offsets = binarySearchAll(indexArr, index_n);
      if (offsets) {
        const precursorRecords = this.precursors.slice(offsets[0], offsets[1]);
        spectrumRecord.precursors = precursorBuilder
          .visit(precursorRecords)
          .finish()
          .filter((v) => v != null);
      }
    }

    if (this.selectedIons != null) {
      indexArr = this.selectedIons.getChild(
        "source_index",
      ) as Arrow.Vector<Arrow.Uint64>;
      offsets = binarySearchAll(indexArr, index_n);
      if (offsets) {
        const selectedIonCols =
          this.metadataTrees.get(DataKindTag.SelectedIons) ??
          MetadataTree.empty();
        spectrumRecord.selectedIons = new SelectedIonBuilder(selectedIonCols)
          .visit(this.selectedIons.slice(offsets[0], offsets[1]))
          .finish()
          .filter((v) => v != null);
      }
    }

    return spectrumRecord;
  }
}

export class ChromatogramMetadata extends MetadataReaderBase {
  _chromatograms: Arrow.Vector | null;
  _precursors: Arrow.Vector | null;
  _selectedIons: Arrow.Vector | null;

  static async fromNamespace(handle: ParquetTableNamespace) {
    const self = new this(handle);
    return await self.init();
  }

  constructor(handle: ParquetTableNamespace) {
    super(handle);
    this._chromatograms = null;
    this._precursors = null;
    this._selectedIons = null;
  }

  async init() {
    if (this.initialized) return this;
    this._chromatograms = await this.handle.readMetadata();
    this._precursors = await this.handle.readPrecursors();
    this._selectedIons = await this.handle.readSelectedIons();
    this.initialized = true;
    return this;
  }

  protected get _mainStruct() {
    return this.chromatograms;
  }

  get chromatograms() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._chromatograms;
  }

  get precursors() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._precursors;
  }

  get selectedIons() {
    if (!this.initialized)
      throw new Error("Metadata not initialized yet! call and await `init()`");
    return this._selectedIons;
  }

  get length(): number {
    return this.initialized && this._chromatograms
      ? this._chromatograms.length
      : 0;
  }

  get(index: number | bigint) {
    if (index >= this.length) throw new Error("Index out of range");
    let index_ = bigIntToNumber(index);
    let index_n = BigInt(index);
    if (this.chromatograms == null) throw new Error("Invalid state");
    let indexArr = this.chromatograms?.getChild(
      "index",
    ) as Arrow.Vector<Arrow.Uint64>;
    let row = indexArr.get(index_);
    if (row != BigInt(index)) {
      index_ = binarySearch(indexArr, BigInt(index));
    }

    let tree = this.metadataTrees.get(DataKindTag.Metadata);
    if (!tree) tree = MetadataTree.fromMetadataMap([]);
    let builder = new ChromatogramBuilder(tree);
    const chromatogramRecord = builder
      .visit(this.chromatograms.slice(index_, index_ + 1))
      .finish()[0];
    if (!chromatogramRecord)
      throw new Error("Invalid state, chromatogram record not found");

    if (this.precursors != null) {
      indexArr = this.precursors?.getChild(
        "source_index",
      ) as Arrow.Vector<Arrow.Uint64>;
      let offsets = binarySearchAll(indexArr, index_n);
      if (offsets) {
        const precursorRecords = this.precursors.slice(offsets[0], offsets[1]);
        chromatogramRecord.precursors = new PrecursorBuilder(
          this.metadataTrees.get(DataKindTag.Precursors) ??
            MetadataTree.empty(),
        )
          .visit(precursorRecords)
          .finish()
          .filter((v) => v != null);
      }
    }

    if (this.selectedIons != null) {
      indexArr = this.selectedIons.getChild(
        "source_index",
      ) as Arrow.Vector<Arrow.Uint64>;
      let offsets = binarySearchAll(indexArr, index_n);
      if (offsets) {
        const selectedIonCols =
          this.metadataTrees.get(DataKindTag.SelectedIons) ??
          MetadataTree.empty();
        chromatogramRecord.selectedIons = new SelectedIonBuilder(
          selectedIonCols,
        )
          .visit(this.selectedIons.slice(offsets[0], offsets[1]))
          .finish()
          .filter((v) => v != null);
      }
    }

    return chromatogramRecord;
  }
}
