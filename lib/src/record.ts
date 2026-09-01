import { DataArrays } from "./data";
import { Param } from "./metadata";
import { MetadataColumn } from "./store";
import * as Arrow from "apache-arrow";

export class MetadataTree {
  prefix: string[];
  columns: Map<string, MetadataColumn>;
  children: Map<string, MetadataTree>;

  constructor(
    prefix: string[],
    columns: Map<string, MetadataColumn>,
    children: Map<string, MetadataTree>,
  ) {
    this.prefix = prefix;
    this.columns = columns;
    this.children = children;
  }

  mapColumn(name: string) {
    return this.columns.get(name);
  }

  mapChild(name: string) {
    return this.children.get(name);
  }

  columnForCURIE(accession: string) {
    return this.columns.entries().find(([_, v]) => v.accession == accession);
  }

  static empty() {
    return MetadataTree.fromMetadataMap([]);
  }

  static fromMetadataMap(columns: MetadataColumn[]) {
    const nodes = new Map<string, MetadataColumn[]>();

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const path = col.path.slice(0, col.path.length - 1).join(".");
      const members = nodes.get(path);
      if (!members) {
        nodes.set(path, [col]);
      } else {
        members.push(col);
      }
    }
    const nodesSorted = Array.from(nodes.entries()).sort();
    const root = new MetadataTree([], new Map(), new Map());
    for (let i = 0; i < nodesSorted.length; i++) {
      const [k, v] = nodesSorted[i];
      let node = root;
      const path = k.split(".").filter((c) => c != "");
      for (let j = 0; j < path.length; j++) {
        let tmp = node.children.get(path[j]);
        if (tmp) {
          node = tmp;
        } else {
          tmp = new MetadataTree(path.slice(0, j), new Map(), new Map());
          node.children.set(path[j], tmp);
          node = tmp;
        }
      }
      v.forEach((c) => {
        node.columns.set(c.leaf, c);
      });
    }
    return root;
  }
}

abstract class RecordVisitor<T extends ParamDescribed> {
  members: (T | null)[];
  mapping: MetadataTree;

  constructor(mapping: MetadataTree) {
    this.members = [];
    this.mapping = mapping;
  }

  abstract visit(array: Arrow.Vector<Arrow.Struct>): ThisType<this>;

  finish(): (T | null)[] {
    return this.members;
  }

  visitParameters(colArray: Arrow.Vector) {
    for (let j = 0; j < colArray.length; j++) {
      const val = colArray.at(j);
      const member = this.members[j];
      if (val && member) member.parameters.push(...Param.fromArrow(val));
    }
  }

  visitAsParameter(colArray: Arrow.Vector, metaCol: MetadataColumn) {
    for (let j = 0; j < colArray.length; j++) {
      const val = colArray.at(j);
      const member = this.members[j];
      if (val && member) {
        if (metaCol.termMarker) {
          member.parameters.push(metaCol.param(null))
        }
        else {
          member.parameters.push(metaCol.param(val))
        }
      };
    }
  }
}

abstract class RecordHasIonMobilityVisitor<
  T extends HasIonMobility,
> extends RecordVisitor<T> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIonMobilityValue(colArray: Arrow.Vector) {
    for (let j = 0; j < colArray.length; j++) {
      const val = colArray.at(j) as number | null;
      const member = this.members[j];
      if (val && member) member.ionMobilityValue = val;
    }
  }

  visitIonMobilityType(colArray: Arrow.Vector) {
    for (let j = 0; j < colArray.length; j++) {
      const val = colArray.at(j) as string | null;
      const member = this.members[j];
      if (val && member) member.ionMobilityType = val;
    }
  }
}

export class PrecursorBuilder extends RecordVisitor<Precursor> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIndex(
    sourceIndex: Arrow.Vector<Arrow.Uint64>,
    precursorIndex: Arrow.Vector<Arrow.Uint64>,
  ) {
    for (let i = 0; i < sourceIndex?.length; i++) {
      this.members.push(
        sourceIndex.isValid(i)
          ? new Precursor(
              sourceIndex.at(i) as bigint,
              precursorIndex.at(i) as bigint,
              new Activation([]),
              new IsolationWindow(0, 0, 0),
              "",
            )
          : null,
      );
    }
  }

  visitActivation(array: Arrow.Vector<Arrow.Struct>, mapping: MetadataTree) {
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      const metaCol = mapping.mapColumn(field.name);
      if (!colArray) continue;
      if (metaCol) {
        switch (metaCol.accession) {
          default:
            this.visitAsParameter(colArray, metaCol);
        }
        continue;
      }

      switch (field.name) {
        case "parameters":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j);
            const member = this.members[j];
            if (val && member)
              member.activation.parameters.push(...Param.fromArrow(val));
          }
          break;
        default:
      }
    }
  }

  visitIsolationWindow(
    array: Arrow.Vector<Arrow.Struct>,
    mapping: MetadataTree,
  ) {
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (!colArray) continue;

      const metaCol = mapping.mapColumn(field.name);
      if (metaCol) {
        switch (metaCol.accession) {
          case "MS:1000827":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member?.isolationWindow)
                member.isolationWindow.target = val;
            }
            break;
          case "MS:1000828":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member?.isolationWindow)
                member.isolationWindow.lowerOffset = val;
            }
            break;
          case "MS:1000829":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member?.isolationWindow)
                member.isolationWindow.upperOffset = val;
            }
            break;
          default:
            console.warn("No handler for", metaCol);
            this.visitAsParameter(colArray, metaCol);
        }
        continue;
      }
      this.visitAsParameter(colArray, new MetadataColumn(field.name, []));
    }
  }

  visit(array: Arrow.Vector<Arrow.Struct>): PrecursorBuilder {
    const sourceIndex = array.getChild("source_index");
    const precursorIndex = array.getChild("precursor_index");
    if (!sourceIndex || !precursorIndex) return this;
    this.visitIndex(sourceIndex, precursorIndex);
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (
        field.name == "source_index" ||
        field.name == "precursor_index" ||
        !colArray
      )
        continue;

      switch (field.name) {
        case "activation":
          this.visitActivation(
            colArray,
            this.mapping.mapChild(field.name) ?? MetadataTree.empty(),
          );
          break;
        case "isolation_window":
          this.visitIsolationWindow(
            colArray,
            this.mapping.mapChild("isolation_window") ?? MetadataTree.empty(),
          );
          break;
        case "precursor_id":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j) as string | null;
            const member = this.members[j];
            if (val && member) member.precursorId = val;
          }
          break;
          break;
        default:
          this.visitAsParameter(colArray, new MetadataColumn(field.name, []));
      }
    }
    return this;
  }
}

export class SelectedIonBuilder extends RecordHasIonMobilityVisitor<SelectedIon> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIndex(
    sourceIndex: Arrow.Vector<Arrow.Uint64>,
    precursorIndex: Arrow.Vector<Arrow.Uint64>,
  ) {
    for (let i = 0; i < sourceIndex?.length; i++) {
      this.members.push(
        sourceIndex.isValid(i)
          ? new SelectedIon(
              sourceIndex.at(i) as bigint,
              precursorIndex.at(i) as bigint,
            )
          : null,
      );
    }
  }

  visit(array: Arrow.Vector<Arrow.Struct>) {
    const sourceIndex = array.getChild("source_index");
    const precursorIndex = array.getChild("precursor_index");
    if (!sourceIndex || !precursorIndex) return this;
    this.visitIndex(sourceIndex, precursorIndex);

    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (
        field.name == "source_index" ||
        field.name == "precursor_index" ||
        !colArray
      )
        continue;

      const metaCol = this.mapping.mapColumn(field.name);
      if (metaCol) {
        switch (metaCol.accession) {
          case "MS:1000744":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member) member.mz = val;
            }
            break;
          case "MS:1000041":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member) member.chargeState = val;
            }
            break;
          case "MS:1000042":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number | null;
              const member = this.members[j];
              if (val && member) member.intensity = val;
            }
            break;
          default:
            this.visitAsParameter(colArray, metaCol);
        }
        continue;
      }

      const isChild = this.mapping.mapChild(field.name);
      if (isChild) {
        continue;
      }

      switch (field.name) {
        case "ion_mobility_value":
          this.visitIonMobilityValue(colArray);
          break;
        case "ion_mobility_type":
          this.visitIonMobilityType(colArray);
          break;
        case "parameters":
          this.visitParameters(colArray);
          break;
        default:
          this.visitAsParameter(colArray, new MetadataColumn(field.name, []));
      }
    }
    return this;
  }
}

export class ScanBuilder extends RecordHasIonMobilityVisitor<Scan> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIndex(sourceIndex: Arrow.Vector<Arrow.Uint64>) {
    for (let i = 0; i < sourceIndex?.length; i++) {
      this.members.push(
        sourceIndex.isValid(i)
          ? new Scan(sourceIndex.at(i) as bigint, 0, [])
          : null,
      );
    }
  }

  visit(array: Arrow.Vector<Arrow.Struct>) {
    const sourceIndex = array.getChild("source_index");
    if (!sourceIndex) return this;
    this.visitIndex(sourceIndex);
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (field.name == "source_index" || !colArray) continue;

      const metaCol = this.mapping.mapColumn(field.name);
      if (metaCol) {
        switch (metaCol.accession) {
          case "MS:1000016":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.parameters.push(metaCol.param(val));
            }
            break;
          case "MS:1000616":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number;
              const member = this.members[j];
              if (val && member) member.presetScanConfiguration = val;
            }
            break;
          case "MS:1000512":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.parameters.push(metaCol.param(val));
            }
            break;
          case "MS:1000927":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as number;
              const member = this.members[j];
              if (val && member) member.injectionTime = val;
            }
            break;
          default:
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.parameters.push(metaCol.param(val));
            }
        }
        continue;
      }
      const isChild = this.mapping.mapChild(field.name);
      if (isChild) {
        if (field.name == "scan_windows") {
          this.visitScanWindows(
            colArray as Arrow.Vector<Arrow.List<Arrow.Struct>>,
            isChild,
          );
        }
        continue;
      }

      switch (field.name) {
        case "scan_index":
          break;
        case "ion_mobility_value":
          this.visitIonMobilityValue(colArray);
          break;
        case "ion_mobility_type":
          this.visitIonMobilityType(colArray);
          break;
        case "instrument_configuration_id":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j) as number | null;
            const member = this.members[j];
            if (val && member) member.instrumentConfigurationRef = val;
          }
          break;
        case "parameters":
          this.visitParameters(colArray);
          break;
      }
    }
    return this;
  }

  visitScanWindows(
    array: Arrow.Vector<Arrow.List<Arrow.Struct>>,
    mapping: MetadataTree,
  ) {
    for (let i = 0; i < array.length; i++) {
      const rowVec = array.get(i);
      const member = this.members[i];
      if (!rowVec || !member) continue;
      const windows = [];
      for (let j = 0; j < rowVec.length; j++) {
        windows.push(new ScanWindow(0, 0));
      }
      for (let j = 0; j < rowVec.type.children.length; j++) {
        const f = rowVec.type.children[j];
        const colArr = rowVec.getChildAt(j);
        const metaCol = mapping.mapColumn(f.name);
        if (metaCol && colArr) {
          switch (metaCol.accession) {
            case "MS:1000501": // lower
              for (let k = 0; k < rowVec.length; k++) {
                const val = colArr.get(k) as number | null;
                if (val != null) windows[k].lowerBound = val;
              }
              break;
            case "MS:1000500": // upper
              for (let k = 0; k < rowVec.length; k++) {
                const val = colArr.get(k) as number | null;
                if (val != null) windows[k].upperBound = val;
              }
              break;
            default:
              break;
          }
        }
      }
      member.scanWindows = windows;
    }
  }
}

interface HasAuxiliaryArrays {
  auxiliaryArrays: AuxiliaryArray[];
}

function visitAuxiliaryArrays<T extends HasAuxiliaryArrays>(
  members: (T | null)[],
  array: Arrow.Vector<Arrow.List<Arrow.Struct>>,
) {
  for (let i = 0; i < array.length; i++) {
    const rowVec = array.get(i);
    const member = members[i];
    if (!rowVec || !member) continue;
    member.auxiliaryArrays = AuxiliaryArrayBuilder.decode(rowVec);
  }
}

export class SpectrumBuilder extends RecordVisitor<Spectrum> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIndex(sourceIndex: Arrow.Vector<Arrow.Uint64>) {
    for (let i = 0; i < sourceIndex?.length; i++) {
      this.members.push(
        sourceIndex.isValid(i)
          ? new Spectrum("", sourceIndex.get(i) as bigint, 0, false, 0, 0, [])
          : null,
      );
    }
  }

  visitAuxiliaryArrays(array: Arrow.Vector<Arrow.List<Arrow.Struct>>) {
    visitAuxiliaryArrays(this.members, array);
  }

  visit(array: Arrow.Vector<Arrow.Struct>) {
    const sourceIndex = array.getChild("index");
    if (!sourceIndex) return this;
    this.visitIndex(sourceIndex);
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (field.name == "index" || !colArray) continue;
      const metaCol = this.mapping.mapColumn(field.name);
      if (metaCol) {
        switch (metaCol.accession) {
          case "MS:1000465": // scan polarity
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) {
                member.polarity = val;
              }
            }
            break;
          case "MS:1000511": // ms level
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.msLevel = val;
            }
            break;
          case "MS:1000525": // spectrum representation
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j) as string | null;
              const member = this.members[j];
              if (val && member) member.isProfile = val == "MS:1000128"; // profile spectrum
            }
            break;
          case "MS:1000559":
          case "MS:1000504":
          case "MS:1000505":
          case "MS:1000285":
          case "MS:1000527":
          case "MS:1000528":
          case "MS:1003060":
          case "MS:1003059":
            this.visitAsParameter(colArray, metaCol);
            break;
          default:
            this.visitAsParameter(colArray, metaCol);
        }
        continue;
      }
      const isChild = this.mapping.mapChild(field.name);
      if (isChild) {
        continue;
      }

      switch (field.name) {
        case "id":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j);
            const member = this.members[j];
            if (val && member) member.id = val;
          }
          break;
        case "time":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j);
            const member = this.members[j];
            if (val && member) member.time = val;
          }
          break;
        case "parameters":
          this.visitParameters(colArray);
          break;
        case "data_processing_id":
        case "number_of_auxiliary_arrays":
        case "mz_delta_model":
          break;
        case "auxiliary_arrays":
          this.visitAuxiliaryArrays(colArray);
          break;
        default:
          this.visitAsParameter(
            colArray,
            new MetadataColumn(field.name, [field.name]),
          );
      }
    }
    return this;
  }
}

export class ChromatogramBuilder extends RecordVisitor<Chromatogram> {
  constructor(mapping: MetadataTree) {
    super(mapping);
  }

  visitIndex(sourceIndex: Arrow.Vector<Arrow.Uint64>) {
    for (let i = 0; i < sourceIndex?.length; i++) {
      this.members.push(
        sourceIndex.isValid(i)
          ? new Chromatogram("", sourceIndex.get(i) as bigint, [])
          : null,
      );
    }
  }

  visitAuxiliaryArrays(array: Arrow.Vector<Arrow.List<Arrow.Struct>>) {
    visitAuxiliaryArrays(this.members, array);
  }

  visit(array: Arrow.Vector<Arrow.Struct>) {
    const sourceIndex = array.getChild("index");
    if (!sourceIndex) return this;
    this.visitIndex(sourceIndex);
    for (let i = 0; i < array.type.children.length; i++) {
      const field = array.type.children[i];
      const colArray = array.getChildAt(i);
      if (field.name == "index" || !colArray) continue;
      const metaCol = this.mapping.mapColumn(field.name);
      if (metaCol) {
        switch (metaCol.accession) {
          case "MS:1000626":
          case "MS:1000559":
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.parameters.push(metaCol.param(val));
            }
            break;
          default:
            for (let j = 0; j < colArray.length; j++) {
              const val = colArray.at(j);
              const member = this.members[j];
              if (val && member) member.parameters.push(metaCol.param(val));
            }
        }
        continue;
      }
      const isChild = this.mapping.mapChild(field.name);
      if (isChild) {
        console.log(field.name, isChild, colArray);
        continue;
      }

      switch (field.name) {
        case "id":
          for (let j = 0; j < colArray.length; j++) {
            const val = colArray.at(j);
            const member = this.members[j];
            if (val && member) member.id = val;
          }
          break;
        case "parameters":
          this.visitParameters(colArray);
          break;
        case "data_processing_id":
        case "number_of_auxiliary_arrays":
          break;
        case "auxiliary_arrays":
          this.visitAuxiliaryArrays(colArray);
          break;
        default:
          this.visitAsParameter(
            colArray,
            new MetadataColumn(field.name, [field.name]),
          );
      }
    }
    return this;
  }
}

export class ParamDescribed {
  params: Param[];

  constructor(params: Param[]) {
    this.params = params;
  }

  get parameters() {
    return this.params;
  }

  getParamByAccession(accession: string): Param | undefined {
    let value = this.params.find((p) => p.accession == accession);
    if (value != undefined) return value;
  }
}

export class HasIonMobility extends ParamDescribed {
  ionMobilityValue: number | null;
  ionMobilityType: string | null;

  constructor(
    params: Param[],
    ionMobilityValue: number | null,
    ionMobilityType: string | null,
  ) {
    super(params);
    this.ionMobilityValue = ionMobilityValue;
    this.ionMobilityType = ionMobilityType;
  }
}

export class ScanWindow {
  lowerBound: number;
  upperBound: number;

  constructor(lowerBound: number, upperBound: number) {
    this.lowerBound = lowerBound;
    this.upperBound = upperBound;
  }
}

export class Scan extends HasIonMobility {
  sourceIndex: bigint;
  instrumentConfigurationRef: number;
  params: Param[];
  scanWindows: ScanWindow[];
  injectionTime?: number;
  presetScanConfiguration?: number;

  constructor(
    sourceIndex: bigint,
    instrumentConfigurationRef: number,
    params: Param[],
    scanWindows?: ScanWindow[],
    injectionTime?: number,
    presetScanConfiguration?: number,
  ) {
    super(params, null, null);
    this.sourceIndex = sourceIndex;
    this.instrumentConfigurationRef = instrumentConfigurationRef;
    this.params = params;
    this.scanWindows = scanWindows ?? [];
    this.injectionTime = injectionTime;
    this.presetScanConfiguration = presetScanConfiguration;
  }
}

export class IsolationWindow {
  target: number;
  lowerOffset: number;
  upperOffset: number;

  constructor(target: number, lower: number, upper: number) {
    this.target = target;
    this.lowerOffset = lower;
    this.upperOffset = upper;
  }

  get lowerBound() {
    return this.target - this.lowerOffset;
  }

  get upperBound() {
    return this.target + this.upperOffset;
  }
}

export class Activation extends ParamDescribed {
  constructor(parameters: Param[]) {
    super(parameters);
  }
}

export class Precursor extends ParamDescribed {
  sourceIndex: bigint;
  precursorIndex: bigint;
  precursorId: string;
  activation: Activation;
  isolationWindow: IsolationWindow | null;

  constructor(
    sourceIndex: bigint,
    precursorIndex: bigint,
    activation: Activation,
    isolationWindow: IsolationWindow | null,
    precursorId: string,
  ) {
    super([]);
    this.sourceIndex = sourceIndex;
    this.precursorIndex = precursorIndex;
    this.activation = activation;
    this.isolationWindow = isolationWindow;
    this.precursorId = precursorId;
  }
}

export class SelectedIon extends HasIonMobility {
  sourceIndex: bigint;
  precursorIndex: bigint;
  chargeState: number | null;
  intensity: number | null;
  mz: number | null;

  constructor(
    sourceIndex: bigint,
    precursorIndex: bigint,
    mz?: number,
    intensity?: number,
    chargeState?: number | null,
    ionMobilityValue?: number | null,
    ionMobilityType?: string | null,
    parameters?: Param[],
  ) {
    super(parameters ?? [], ionMobilityValue ?? null, ionMobilityType ?? null);
    this.sourceIndex = sourceIndex;
    this.precursorIndex = precursorIndex;
    this.chargeState = chargeState ?? null;
    this.mz = mz ?? null;
    this.intensity = intensity ?? null;
  }
}

export interface PointLike {
  mz: number;
  intensity: number;
}

export class Spectrum extends ParamDescribed {
  id: string;
  index: bigint;
  msLevel: number;
  isProfile: boolean;
  polarity: number;
  time: number;
  params: Param[];
  scans: Scan[];
  precursors: Precursor[];
  selectedIons: SelectedIon[];
  dataArrays: DataArrays;
  centroids: PointLike[] | null;
  auxiliaryArrays: AuxiliaryArray[];

  constructor(
    id: string,
    index: bigint,
    msLevel: number,
    isProfile: boolean,
    polarity: number,
    time: number,
    params: Param[],
    scans?: any[],
    precursors?: any[],
    selectedIons?: any[],
    dataArrays: DataArrays | null = null,
    centroids: PointLike[] | null = null,
    auxiliaryArrays: AuxiliaryArray[] | null = null,
  ) {
    super(params);
    this.id = id;
    this.index = index;
    this.msLevel = msLevel;
    this.isProfile = isProfile;
    this.polarity = polarity;
    this.time = time;
    this.params = params;
    this.scans = scans ?? [];
    this.precursors = precursors ?? [];
    this.selectedIons = selectedIons ?? [];
    this.dataArrays = dataArrays ?? {};
    this.centroids = centroids;
    this.auxiliaryArrays = auxiliaryArrays ?? [];
    if (this.auxiliaryArrays) {
      this.auxiliaryArrays.forEach((aux) => {
        this.dataArrays[aux.name] = aux.values;
      });
    }
  }

  get rawArrays() {
    return this.dataArrays;
  }

  centroidPeaks() {
    if (this.centroids) return this.centroids;
    if (!this.isProfile) {
      if (this.dataArrays) {
        const intensityArr = this.dataArrays["intensity array"] as Float32Array;
        const mzArr = this.dataArrays["m/z array"] as Float64Array;
        this.centroids = [];
        for (let i = 0; i < mzArr.length; i++) {
          this.centroids.push({
            mz: mzArr[i],
            intensity: intensityArr[i],
          });
        }
        return this.centroids;
      }
    }
  }
}

export class Chromatogram extends ParamDescribed {
  id: string;
  index: bigint;
  params: Param[];
  precursors: Precursor[];
  selectedIons: SelectedIon[];
  dataArrays: DataArrays;
  auxiliaryArrays: AuxiliaryArray[];

  constructor(
    id: string,
    index: bigint,
    params: Param[],
    precursors?: any[],
    selectedIons?: any[],
    dataArrays?: DataArrays,
    auxiliaryArrays: AuxiliaryArray[] | null = null,
  ) {
    super(params);
    this.id = id;
    this.index = index;
    this.params = params;
    this.precursors = precursors ?? [];
    this.selectedIons = selectedIons ?? [];
    this.dataArrays = dataArrays ?? {};
    this.auxiliaryArrays = auxiliaryArrays ?? [];
    if (this.auxiliaryArrays) {
      this.auxiliaryArrays.forEach((aux) => {
        this.dataArrays[aux.name] = aux.values;
      });
    }
  }

  get rawArrays() {
    return this.dataArrays;
  }
}

export class AuxiliaryArray {
  name: string;
  values: Int32Array | Float32Array | Float64Array | BigInt64Array | string[];
  parameters: Param[];
  unit: string | null;

  constructor(
    name: string,
    values: Int32Array | Float32Array | Float64Array | BigInt64Array | string[],
    parameters?: Param[],
    unit: string | null = null,
  ) {
    this.name = name;
    this.values = values;
    this.parameters = parameters || [];
    this.unit = unit;
  }
}

export class AuxiliaryArrayBuilder {
  static ArrayTypes: Record<
    string,
    | Int32ArrayConstructor
    | Float32ArrayConstructor
    | BigInt64ArrayConstructor
    | Float64ArrayConstructor
  > = {
    "MS:1000519": Int32Array,
    "MS:1000521": Float32Array,
    "MS:1000522": BigInt64Array,
    "MS:1000523": Float64Array,
  };

  static StringType = "MS:1001479";

  static decode(states: Arrow.Vector) {
    const namesArrow = states.getChild("name");
    if (namesArrow == null)
      throw new TypeError(`Auxiliary arrays must have a "name" field!`);
    const names = Param.fromArrow(namesArrow);
    const auxArrays = [];
    for (let i = 0; i < names.length; i++) {
      const nameOf = names[i];
      const record: {
        name: any;
        data: Arrow.Vector;
        data_type: string;
        unit: string | null;
        compression: string;
        parameters: Arrow.Vector;
      } = states.at(i).toJSON();
      const valuesBytes = record.data.toArray();
      const buf = new Uint8Array(valuesBytes.length);
      buf.set(valuesBytes, 0);
      const arrayType = AuxiliaryArrayBuilder.ArrayTypes[record.data_type];
      let values;
      if (arrayType) {
        values = new arrayType(buf.buffer);
      } else if (record.data_type == AuxiliaryArrayBuilder.StringType) {
        const decoder = new TextDecoder("utf8");
        values = decoder.decode(buf.buffer).split("\0");
      } else {
        throw Error(`Data type ${record.data_type} not implemented`);
      }
      const params = Param.fromArrow(record.parameters);
      auxArrays.push(
        new AuxiliaryArray(nameOf.name, values, params, record.unit),
      );
    }
    return auxArrays;
  }
}
