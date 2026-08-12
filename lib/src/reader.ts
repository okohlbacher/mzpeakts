import * as Arrow from "apache-arrow";
import { EntityTypeTag, ZipStorage } from "./store";
import {
  SpectrumMetadata,
  ChromatogramMetadata,
  FileMetadata,
} from "./metadata";
import { HttpRangeReader, BlobReader } from "@zip.js/zip.js";
import {
  DataArraysReader,
  packTableIntoDataArrays,
  packTableIntoPeaks,
} from "./data";
import { BufferContext } from "./array_index";
import { PointLike, Spectrum } from "./record";
import { Span1D, Span1DBigInt } from "./utils";
import { bigIntToNumber } from "apache-arrow/util/bigint";
import { DataArrays } from './data';

// A facet whose Parquet has zero row groups (an empty spectra_peaks/spectra_data — common on
// centroid-only or SciEX MRM exports) means "no data for this facet", not an error. Callers
// that attempt a facet read speculatively (e.g. when the metadata count column is unpopulated)
// need it to resolve to null rather than throw "Empty Parquet file".
async function fromParquetOrNull(
  handle: Parameters<typeof DataArraysReader.fromParquet>[0],
  context: BufferContext,
): Promise<DataArraysReader | null> {
  try {
    return await DataArraysReader.fromParquet(handle, context);
  } catch (e) {
    if (e instanceof Error && e.message === "Empty Parquet file") return null;
    throw e;
  }
}

export interface XICPoint {
  index: bigint,
  time: number | null,
  dataArrays: DataArrays
}

export interface XIC {
  points: XICPoint[];
  target: {
    timeRange: Span1D | null;
    mzRange: Span1D | null;
  };
};

/**
 * A reader for mzPeak files.
 *
 * This reader eagerly loads metadata but lazily loads signal data.
 *
 * <attribute>a</attribute>
 */
export class MzPeakReader<T> implements AsyncIterable<Spectrum> {
  /**
   * The storage backend for the mzPeak file. This is a ZIP archive that is either
   * available as a `Blob` local to the runtime or available over HTTP(S) range requests.
   */
  store: ZipStorage<T>;
  /**
   * A reader for mass spectrum metadata that has been loaded eagerly.
   */
  spectrumMetadata: SpectrumMetadata | null = null;
  /** A reader for chromatogram or trace metadata that has been loaded eagerly */
  chromatogramMetadata: ChromatogramMetadata | null = null;
  /**
   * A reader for wavelength spectrum metadata that has been loaded eagerly.
   */
  wavelengthMetadata: SpectrumMetadata | null = null;
  /**
   * Whether the initial asynchronous metadata loading done by {@linkcode init} has completed.
   *
   * This only necessary if {@link constructor} is called directly instead of {@linkcode fromStore},
   * {@linkcode fromUrl}, or {@linkcode fromBlob}.
   */
  initialized: boolean = false;
  _spectrumDataReader: DataArraysReader | null = null;
  _spectrumPeaksReader: DataArraysReader | null = null;
  _chromatogramDataReader: DataArraysReader | null = null;
  _wavelengthSpectrumDataReader: DataArraysReader | null = null;
  _fileMetadata: FileMetadata | undefined = undefined;

  /**
   * Construct a {@linkcode MzPeakReader} from a {@linkcode ZipStorage}
   * @param store The data storage to read from.
   * @see {@link fromStore}, {@link fromUrl}, and {@link fromBlob}.
   */
  constructor(store: ZipStorage<T>) {
    this.store = store;
  }

  get fileMetadata() {
    if (this._fileMetadata != undefined) return this._fileMetadata;
    this._fileMetadata = this.spectrumMetadata?.fileMetadata();
    return this._fileMetadata;
  }

  static async fromStore<T>(store: ZipStorage<T>) {
    const self = new this(store);
    await self.init();
    return self;
  }

  static async fromUrl(url: string | URL) {
    return await MzPeakReader.fromStore(
      new ZipStorage(new HttpRangeReader(url)),
    );
  }

  static async fromBlob(blob: Blob) {
    return await MzPeakReader.fromStore(new ZipStorage(new BlobReader(blob)));
  }

  async init() {
    if (this.initialized) return this;
    await this.store.init();
    const spectrumMetaHandle = await this.store.openMetadataNamespace(
      EntityTypeTag.Spectrum,
    );
    if (spectrumMetaHandle.hasMetadata()) {
      this.spectrumMetadata =
        await SpectrumMetadata.fromNamespace(spectrumMetaHandle);
    }

    const chromatogramMetaHandle = await this.store.openMetadataNamespace(
      EntityTypeTag.Chromatogram
    );
    if (chromatogramMetaHandle.hasMetadata()) {
      this.chromatogramMetadata = await ChromatogramMetadata.fromNamespace(
        chromatogramMetaHandle,
      );
    }

    const wavelengthMetadataHandle = await this.store.openMetadataNamespace(EntityTypeTag.WavelengthSpectrum)
    if (wavelengthMetadataHandle) {
      this.wavelengthMetadata = await SpectrumMetadata.fromNamespace(
        wavelengthMetadataHandle,
      );
    }

    this.initialized = true;
    return this;
  }

  async spectrumData() {
    if (this._spectrumDataReader) return this._spectrumDataReader;
    if (!this.initialized) await this.init();
    const handle = await this.store.spectrumData();
    if (!handle) return null;
    const dataReader = await fromParquetOrNull(handle, BufferContext.Spectrum);
    if (!dataReader) return null;
    if (this.spectrumMetadata)
      dataReader.spacingModels = this.spectrumMetadata.loadSpacingModelIndex();
    this._spectrumDataReader = dataReader;
    return dataReader;
  }

  async *enumerateSpectra() {
    if (!this.spectrumMetadata) return;
    const dataReader = await this.spectrumData();
    const peakReader = await this.spectrumPeaks();
    const dataIter = dataReader?.enumerate();
    const peakIter = peakReader?.enumerate();
    const n = this.spectrumMetadata.length;
    const dpCounts = this.spectrumMetadata.dataPointCount();
    const peakCounts = this.spectrumMetadata.peakCount();
    for (let i = 0; i < n; i++) {
      const meta = this.spectrumMetadata.get(i);
      const bigIndex = BigInt(i);
      let hadData = 0

      const dpCount = dpCounts?.get(i)
      if (
        dpCount &&
        dataIter
      ) {
        await dataIter.seek(bigIndex)
        let { done, value: data } = await dataIter.next();
        if (!done) {
          hadData++;
        }

        data = data[1];
        if (data) {
          Object.assign(meta["dataArrays"], packTableIntoDataArrays(data));
        }
      }

      const peakCount = peakCounts?.get(i)
      if (peakCount && peakIter && (await peakIter.seek(bigIndex))) {
        let { done, value: data } = await peakIter.next();
        if (!done) {
          hadData++;
        }
        data = data[1];
        const peaks = packTableIntoPeaks(data) as any as PointLike[];
        meta.centroids = peaks;
      }

      if (hadData == 0) {
        console.log("No data for ", i)
      };
      yield meta;
    }
  }

  async spectrumPeaks() {
    if (this._spectrumPeaksReader) return this._spectrumPeaksReader;
    if (!this.initialized) await this.init();
    const handle = await this.store.spectrumPeaks();
    if (!handle) return null;
    this._spectrumPeaksReader = await fromParquetOrNull(handle, BufferContext.Spectrum);
    return this._spectrumPeaksReader;
  }

  async chromatogramData() {
    if (this._chromatogramDataReader) return this._chromatogramDataReader;
    if (!this.initialized) await this.init();
    const handle = await this.store.chromatogramData();
    if (!handle) return null;
    this._chromatogramDataReader = await DataArraysReader.fromParquet(
      handle,
      BufferContext.Chromatogram,
    );
    return this._chromatogramDataReader;
  }

  async wavelengthSpectrumData() {
    if (this._wavelengthSpectrumDataReader)
      return this._wavelengthSpectrumDataReader;
    if (!this.initialized) await this.init();
    const handle = await this.store.wavelengthSpectrumData();
    if (!handle) return null;
    const dataReader = await DataArraysReader.fromParquet(
      handle,
      BufferContext.WavelengthSpectrum,
    );
    // Mirror spectrumData(): install spacing models so chunked / delta-encoded
    // wavelength arrays decode (point-layout files don't need them, but PDA files
    // written with the chunked layout do).
    if (this.wavelengthMetadata)
      dataReader.spacingModels = this.wavelengthMetadata.loadSpacingModelIndex();
    this._wavelengthSpectrumDataReader = dataReader;
    return this._wavelengthSpectrumDataReader;
  }

  async getSpectrum(index_: bigint | number) {
    const index = BigInt(index_);
    const meta = this.spectrumMetadata?.get(index);
    if (meta) {
      const indexNum = bigIntToNumber(index);
      // A count of 0 means "known empty, skip"; null/undefined means "unknown" — the
      // converter left number_of_data_points/number_of_peaks unpopulated (seen on SciEX
      // MRM exports), so attempt the facet read rather than silently returning 0 points.
      const dpCount = this.spectrumMetadata?.dataPointCount(indexNum)
      if (dpCount == null || dpCount > 0) {
        const handle = await this.spectrumData();
        const data = await handle?.get(index);
        if (data) {
          Object.assign(meta["dataArrays"], packTableIntoDataArrays(data));
        }
      }
      const peakCount = this.spectrumMetadata?.peakCount(indexNum);
      if (peakCount == null || peakCount > 0) {
        const peakHandle = await this.spectrumPeaks();
        const peakData = await peakHandle?.get(index);
        if (peakData && peakData.numRows > 0) {
          const peaks = packTableIntoPeaks(peakData) as any as PointLike[];
          meta.centroids = peaks;
        }
      }
      return meta;
    }
  }

  async extractXIC(
    timeRange: Span1D | null,
    mzRange: Span1D | null = null,
    useProfile: boolean = true,
  ): Promise<XIC | null> {
    if (!this.spectrumMetadata) return null;
    let indexRange: Span1DBigInt | null = null;
    if (timeRange)
      indexRange = this.spectrumMetadata?.timeRangeToIndices(
        timeRange.start,
        timeRange.end,
      );
    const reader = await (useProfile ? this.spectrumData() : this.spectrumPeaks());
    if (!reader) return null;
    const points = (await reader.extractRangeFor(
      indexRange,
      mzRange,
    )) as XICPoint[];
    const timeArray = this.spectrumMetadata.spectra?.getChild(
      "time",
    ) as Arrow.Vector<Arrow.Float64> | null;
    if (timeArray) {
      return {
        points: points.map((entry: XICPoint) => {
          entry["time"] = timeArray.at(bigIntToNumber(entry.index));
          return entry;
        }),
        target: {
          timeRange,
          mzRange,
        },
      };
    } else {
      return {
        points: points.map((entry: XICPoint) => {
          entry["time"] = null;
          return entry;
        }),
        target: {
          timeRange,
          mzRange,
        },
      };
    }
  }

  get numSpectra() {
    return this.spectrumMetadata?.length ?? 0;
  }

  async getChromatogram(index_: bigint | number) {
    const index = BigInt(index_);
    const meta = this.chromatogramMetadata?.get(index);
    if (meta) {
      const handle = await this.chromatogramData();
      const data = await handle?.get(index);
      if (data) {
        Object.assign(meta["dataArrays"], packTableIntoDataArrays(data));
      }
      return meta;
    }
  }

  get numChromatograms() {
    return this.chromatogramMetadata?.length ?? 0;
  }

  async getWavelengthSpectrum(index_: bigint | number) {
    const index = BigInt(index_);
    const meta = this.wavelengthMetadata?.get(index);
    if (meta) {
      const handle = await this.wavelengthSpectrumData();
      const data = await handle?.get(index);
      if (data) {
        Object.assign(meta["dataArrays"], packTableIntoDataArrays(data));
      }
      return meta;
    }
  }

  get numWavelengthSpectra() {
    return this.wavelengthMetadata?.length ?? 0;
  }

  async at(index: bigint | number) {
    return await this.getSpectrum(index);
  }

  async get(index: bigint | number) {
    return await this.getSpectrum(index);
  }

  get length() {
    return this.numSpectra;
  }

  async *[Symbol.asyncIterator]() {
    for await (let value of this.enumerateSpectra()) {
      yield value;
    }
  }
}
