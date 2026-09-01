// @ts-check
import * as zip from "@zip.js/zip.js";
import { ParquetFile, setPanicHook } from "parquet-wasm";
import { Param, ParquetTableNamespace } from "./metadata";

setPanicHook();

const SPECTRUM = "spectrum";
const CHROMATOGRAM = "chromatogram";
// Space-separated, per the spec (schema/mzpeak_index.json) and every file the reference
// writer emits — NOT "wavelength_spectrum"/"data_arrays".
const WAVELENGTH_SPECTRUM = "wavelength spectrum";

const DATA_ARRAYS = "data arrays";
const METADATA = "metadata";
const PEAKS = "peaks";
const OTHER = "other";
const SCANS = "scans";
const PRECURSORS = "precursors";
const SELECTED_IONS = "selected_ions";
const PRODUCTS = "products";
const PROPRIETARY = "proprietary";

// Canonicalize an index data_kind/entity_type token so "_" and " " compare equal
// (spec uses "data arrays"/"wavelength spectrum"; the converter emits the underscore forms).
function normalizeKindKey(s: string): string {
  return s.replace(/_/g, " ").toLowerCase();
}

export enum DataKindTag {
  DataArrays = DATA_ARRAYS,
  Metadata = METADATA,
  Peaks = PEAKS,
  Proprietary = PROPRIETARY,
  Other = OTHER,
  Scans = SCANS,
  Precursors = PRECURSORS,
  SelectedIons = SELECTED_IONS,
  Products = PRODUCTS,
}

export class DataKind {
  name: string;
  tag: DataKindTag;

  constructor(name: string, tag: DataKindTag) {
    this.name = name;
    this.tag = tag;
  }

  equals(other: string | DataKind | DataKindTag) {
    // Compare on the resolved TAG, not the raw name: fromString normalizes "_"<->" "
    // into the tag, but the raw names still differ ("data_arrays" vs "data arrays",
    // "wavelength_spectrum" vs "wavelength spectrum"), so a name compare wrongly rejects
    // the wavelength/data facets and they never load.
    if (other instanceof DataKind) {
      return this.tag == other.tag;
    } else if (typeof other === "string") {
      return normalizeKindKey(this.name) == normalizeKindKey(String(other));
    } else {
      return this.tag == other;
    }
  }

  static fromString(key: string) {
    // Match on the enum's VALUE, not its key name. TypeScript string enums have no reverse
    // mapping, so `DataKindTag[key]` is always undefined for an index value like "metadata"
    // (the key is `Metadata`) — which made every entry fall back to `Other`.
    // Normalize "_" vs " ": the spec spells the multi-word kinds with spaces
    // ("data arrays", "wavelength spectrum") but the reference converter emits underscores
    // ("data_arrays", "wavelength_spectrum"). Without this every chunked corpus file loses
    // its spectra_data facet and reads back zero points.
    const tag = (Object.values(DataKindTag) as string[]).find(
      (v) => normalizeKindKey(v) === normalizeKindKey(key),
    ) as DataKindTag | undefined;
    return new DataKind(key, tag ?? DataKindTag.Other);
  }
}

export enum EntityTypeTag {
  Spectrum = SPECTRUM,
  Chromatogram = CHROMATOGRAM,
  WavelengthSpectrum = WAVELENGTH_SPECTRUM,
  Other = OTHER,
  Proprietary = PROPRIETARY,
}

export class EntityType {
  name: string;
  tag: EntityTypeTag;

  constructor(name: string, tag: EntityTypeTag) {
    this.name = name;
    this.tag = tag;
  }

  equals(other: string | EntityType | EntityTypeTag) {
    // Compare on the resolved TAG (see DataKind.equals): "wavelength_spectrum" and
    // "wavelength spectrum" must compare equal, which a raw-name compare would fail.
    if (other instanceof EntityType) {
      return this.tag == other.tag;
    } else if (typeof other === "string") {
      return normalizeKindKey(this.name) == normalizeKindKey(String(other));
    } else {
      return this.tag == other;
    }
  }

  static fromString(key: string) {
    // Same fix as DataKind.fromString: match the enum VALUE (normalizing "_" vs " ") not the key.
    const tag = (Object.values(EntityTypeTag) as string[]).find(
      (v) => normalizeKindKey(v) === normalizeKindKey(key),
    ) as EntityTypeTag | undefined;
    return new EntityType(key, tag ?? EntityTypeTag.Other)
  }
}

export class MetadataColumn {
  name: string;
  path: string[];
  accession: string | null = null;
  unit: string | null = null;
  term_marker: boolean | null = null;

  constructor(
    name: string,
    path: string[] | string,
    accession: string | null = null,
    unit: string | null = null,
    term_marker: boolean | null = null,
  ) {
    this.name = name;
    this.path =
      path instanceof String || typeof path === "string"
        ? path.split(".")
        : (path as string[]);
    this.accession = accession;
    this.unit = unit;
    this.term_marker = term_marker
  }

  param(value: any | null) {
    return new Param(this.name, value, this.accession, this.unit);
  }

  get termMarker() {
    return this.term_marker ?? false
  }

  set termMarker(value: boolean | null) {
    this.term_marker = value ?? false
  }

  get leaf() {
    return this.path[this.path.length - 1];
  }

  static fromRaw(value: any) {
    return new MetadataColumn(
      value.name,
      value.path,
      value.accession || null,
      value.unit || null,
      value.term_marker || null,
    );
  }
}

export class FileIndexEntry {
  name: string;
  data_kind: DataKind;
  entity_type: EntityType;
  column_mapping: MetadataColumn[];
  parameters: Param[];

  constructor(
    name: string,
    data_kind: string,
    entity_type: string,
    column_mapping: any[],
    parameters: any[],
  ) {
    this.name = name;
    this.data_kind = DataKind.fromString(data_kind);
    this.entity_type = EntityType.fromString(entity_type);
    this.column_mapping = column_mapping
      ? column_mapping.map(MetadataColumn.fromRaw)
      : [];
    this.parameters = parameters ? parameters.map(Param.fromJSON) : [];
  }

  get columnMapping() {
    return this.column_mapping;
  }

  get dataKind(): DataKind {
    return this.data_kind;
  }

  get entityType(): EntityType {
    return this.entity_type;
  }
}

export class FileIndex {
  metadata: any;
  files: FileIndexEntry[];

  static FILE_NAME: string = "mzpeak_index.json";

  constructor(files: FileIndexEntry[], metadata: any | undefined = undefined) {
    this.files = files;
    this.metadata = metadata ? metadata : {};
  }

  static fromRaw(indexObj: any) {
    const files = Array.from(indexObj.files).map(
      (e: any) =>
        new FileIndexEntry(
          e.name,
          e.data_kind,
          e.entity_type,
          e.column_mapping,
          e.parameters,
        ),
    );
    return new FileIndex(files, indexObj.metadata);
  }
}

/**
 * Low-level mzPeak storage that is backed by an uncompressed `ZIP` archive that is either local
 * or remote to the runtime.
 */
export class ZipStorage<T> {
  /** The raw {@linkcode zip.Reader} that backs this archive */
  reader: zip.Reader<T>;
  /** The `ZIP` reader on top of {@link reader} */
  archive: zip.ZipReader<T>;
  /** mzPeak archive metadata describing the standardized files */
  fileIndex: FileIndex;
  /** Raw `ZIP` metadata entries */
  entries: zip.Entry[];
  /** Whether the {@linkcode init} method has been called. */
  initialized: boolean;

  /**
   * The raw constructor for `ZipStorage` that works directly on `zip.js`'s `Reader` base type.
   *
   * Prefer {@linkcode `fromUrl`} or {@linkcode `fromBlob`} for most cases as they automatically call `init` as well.
   *
   * @param reader The underlying ZIP reader
   * @see {@linkcode ZipStorage.fromUrl} - For initializing from URLs
   * @see {@linkcode ZipStorage.fromBlob} - For initializing from {@linkcode Blob} or similar interface
   */
  constructor(reader: zip.Reader<T>) {
    this.reader = reader;
    this.archive = new zip.ZipReader(reader);
    this.fileIndex = new FileIndex([]);
    this.entries = [];
    this.initialized = false;
  }

  async openMetadataNamespace(entityType: EntityTypeTag | EntityType) {
    return ParquetTableNamespace.populateFromStorage(this, entityType);
  }

  /**
   * Open a {@linkcode RemoteBlob} for the requested member of the ZIP archive by name
   * @param {string} filename - The name of the file to open from the archive.
   * @returns {RemoteBlob<T> | undefined} If `filename` is found, then a `RemoteBlob` is returned,
   * otherwise `undefined` is returned instead.
   */
  async open(filename: string): Promise<RemoteBlob<T> | undefined> {
    if (!this.initialized) await this.init();

    const entry = this.entries.find((e) => e.filename == filename);
    if (entry === undefined) return undefined;
    return RemoteBlob.fromEntry(this.reader, entry);
  }

  /**
   * Create a `ZipStorage` instance from a URL.
   * @param url The URL for the mzPeak file stored on an accessible server. If this is a cross-origin request, care must be taken to allow range request headers
   * @returns {ZipStorage<zip.HttpRangeReader>} The storage configured for loading via HTTP requests.
   */
  static async fromUrl(url: string | URL) {
    const store = new ZipStorage(
      new zip.HttpRangeReader(url, {
        headers: [["Access-Control-Allow-Origin", "*"]],
      }),
    );
    await store.init();
    return store;
  }

  /**
   * Create a {@linkcode ZipStorage} instance from a {@linkcode Blob}-like object. This works with local files
   * (including those attached to a browser window) or anything exposing a `Blob`-like API like `slice`, `size`,
   * `arrayBuffer`, et. al.
   *
   * @param {Blob | RemoteBlob} blob The `Blob`-like object to read from. This might be a `RemoteBlob` too
   * @returns {ZipStorage<zip.BlobReader>} The storage configured for loading content via `Blob.slice` calls
   */
  static async fromBlob(blob: Blob) {
    const store = new ZipStorage(new zip.BlobReader(blob));
    await store.init();
    return store;
  }

  /**
   * Open a ZIP archive member based upon its entry in {@linkcode fileIndex}. This cannot open files not in the index
   * and should not be used to open proprietary files listed in the index directly.
   * @param entityType The {@linkcode EntityTypeTag} to look up in the {@linkcode fileIndex}
   * @param dataKind The {@linkcode DataKindTag} to look up in the {@linkcode fileIndex}
   * @returns {RemoteBlob<T> | undefined} If a matching entry is found, then a `RemoteBlob` is returned,
   * otherwise `undefined` is returned instead.
   *
   * @see {@linkcode ZipStorage.open}
   */
  async openFromIndex(
    entityType: EntityTypeTag | EntityType,
    dataKind: DataKindTag | DataKind,
  ): Promise<RemoteBlob<T> | undefined> {
    if (!this.initialized) await this.init();
    const entry = this.fileIndex.files.find(
      (e) => e.dataKind.equals(dataKind) && e.entityType.equals(entityType),
    );
    if (entry === undefined) return undefined;
    return this.open(entry.name);
  }

  async spectrumMetadata(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.Metadata,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async spectrumScans(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.Scans,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async spectrumPrecursors(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.Precursors,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async spectrumSelectedIons(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.SelectedIons,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async spectrumData(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.DataArrays,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async spectrumPeaks(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Spectrum,
      DataKindTag.Peaks,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async chromatogramMetadata(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Chromatogram,
      DataKindTag.Metadata,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async chromatogramPrecursors(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Chromatogram,
      DataKindTag.Precursors,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async chromatogramSelectedIons(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Chromatogram,
      DataKindTag.SelectedIons,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async chromatogramProducts(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Chromatogram,
      DataKindTag.Products,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async chromatogramData(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.Chromatogram,
      DataKindTag.DataArrays,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async wavelengthSpectrumMetadata(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.WavelengthSpectrum,
      DataKindTag.Metadata,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async wavelengthSpectrumScans(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.WavelengthSpectrum,
      DataKindTag.Scans,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  async wavelengthSpectrumData(): Promise<ParquetFile | undefined> {
    const blob = await this.openFromIndex(
      EntityTypeTag.WavelengthSpectrum,
      DataKindTag.DataArrays,
    );
    if (!blob) return undefined;
    return ParquetFile.fromFile(blob as any as Blob);
  }

  /**
   * Read the file index JSON file from the source and initialize the `fileIndex` property.
   *
   * @throws {Error} if the index JSON file is not found or not properly formatted.
   */
  async init() {
    if (this.initialized) return;

    this.entries = [];
    const it = this.archive.getEntriesGenerator();
    for await (let entry of it) {
      this.entries.push(entry);
      if (entry.filename == FileIndex.FILE_NAME) {
        const rawIndex = JSON.parse(
          await (await RemoteBlob.fromEntry(this.reader, entry)).text(),
        );
        this.fileIndex = FileIndex.fromRaw(rawIndex);
        this.initialized = true;
      }
    }
    if (!this.initialized) {
      throw new Error(
        `File index did not contain "${FileIndex.FILE_NAME}", not a valid mzPeak ZIP!`,
      );
    }
  }
}

async function readZipHeaderSize<T>(blob: RemoteBlob<T>) {
  const arrayBuffer = await blob.slice(0, 30).arrayBuffer();
  const view = new DataView(arrayBuffer);
  let offset = 30;
  const nameSize = view.getUint16(26, true);
  const extraSize = view.getUint16(28, true);
  return offset + nameSize + extraSize;
}

/**
 * Per-source read serialization. parquet-wasm's async reader issues several page reads
 * concurrently; when their completions arrive OUT OF ISSUE ORDER (browsers routinely
 * reorder range fetches; Node's local fetch happens to complete in order) the reader's
 * internal buffer assembly is corrupted and the wasm panics with
 * `range start must not be greater than end` (bytes crate) while parsing a page.
 * Chaining every read on the shared underlying {@linkcode zip.Reader} forces completion
 * order == issue order, which sidesteps the bug. Measured cost is negligible: the hot
 * paths issue large mostly-sequential reads, and parallel range reads showed no
 * wall-clock win on this stack anyway.
 */
const sourceReadChains = new WeakMap<object, Promise<unknown>>();

function chainRead<R>(source: object, read: () => Promise<R>): Promise<R> {
  const prev = sourceReadChains.get(source) ?? Promise.resolve();
  const run = prev.then(read);
  sourceReadChains.set(source, run.catch(() => undefined));
  return run;
}

/**
 * An abstraction that mimicks the built-in {@linkcode Blob} interface but serves data
 * using a {@linkcode zip.Reader} instance. This may refer to a byte range of a larger
 * data store as in a `ZIP` archive.
 */
export class RemoteBlob<T> {
  /** The backing data that may be local or remote */
  source: zip.Reader<T>;
  /** A human-readable name or URL */
  name: string;
  /** The end of the byte range that defines this data source */
  end: number;
  /** The start of the byte range that defines this data source */
  start: number;
  /** A MIME type, not required, part of the {@linkcode Blob} interface */
  type: string | undefined;

  static async fromEntry<T extends zip.Initializable & zip.ReadableReader>(
    sourceUrl: zip.Reader<T>,
    entry: zip.Entry,
  ) {
    const blob = new RemoteBlob(
      sourceUrl,
      entry.filename,
      entry.offset,
      entry.offset + entry.uncompressedSize,
    );
    const headerSize = await readZipHeaderSize(blob);
    blob.start += headerSize;
    blob.end += headerSize;
    return blob;
  }

  constructor(
    source: zip.Reader<T>,
    name: string,
    start: number,
    end: number,
    type: string | undefined = undefined,
  ) {
    this.source = source;
    this.name = name;
    this.end = end;
    this.start = start;
    this.type = type;
  }

  /**
   * Create a new {@linkcode RemoteBlob} from  a slice of this object's byte range.
   *
   * The new instance shares this instance's {@linkcode source}.
   *
   * @see {@linkcode Blob.slice} */
  slice(
    start: number | undefined = undefined,
    end: number | undefined = undefined,
  ) {
    if (start === undefined) {
      return this;
    } else if (end === undefined) {
      return new RemoteBlob(
        this.source,
        this.name,
        this.start + start,
        this.end,
        this.type,
      );
    } else {
      return new RemoteBlob(
        this.source,
        this.name,
        this.start + start,
        this.start + end,
        this.type,
      );
    }
  }

  /** @see {@linkcode Blob.size} */
  get size() {
    return this.end - this.start;
  }

  private async _read(): Promise<Uint8Array> {
    // Serialized per shared source — see chainRead above (out-of-order completion of
    // concurrent parquet-wasm page reads panics the wasm reader).
    const buf = await chainRead(this.source as object, () =>
      this.source.readUint8Array(this.start, this.end - this.start),
    );
    return buf;
  }

  /**
   * Read the raw data storage of this blob
   * @returns The raw {@linkcode ArrayBuffer} backing this blob.
   * @see {@linkcode Blob.arrayBuffer}
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this._read()).buffer as ArrayBuffer;
  }

  /**
   * Read the bytes of this blob
   * @returns The data of this blob represented as {@linkcode Uint8Array}
   * @see {@linkcode Blob.bytes}
   */
  async bytes(): Promise<Uint8Array> {
    return this._read();
  }

  /**
   * Read the bytes of this blob interpreted as UTF-8
   * @returns The data of this blob represented as {@linkcode string}
   * @see {@linkcode Blob.text}
   */
  async text(): Promise<string> {
    const buf = await this._read();
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(buf);
  }
}
