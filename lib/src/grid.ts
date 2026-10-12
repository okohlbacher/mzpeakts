
export interface GridLike {
    accesion: string,
    name: string,

    toParameters(): Float64Array
    fromParameters(accession: string, parameters: Float64Array): GridLike

    toIndex(value: number): number;
    fromIndex(index: number): number;
    maxError(values: Float64Array): number;
}

const UINT32_MAX = 0xFFFFFFFF;
const UINT32_MAX_INDEX = UINT32_MAX - 1;

/** Round to the nearest index, clamped to a valid uint32. */
function clampU32(value: number): number {
    if (Number.isNaN(value) || value < 0) return 0;
    if (value >= UINT32_MAX_INDEX) return UINT32_MAX_INDEX;
    return Math.round(value);
}

/** Ordinary least squares fit of `y = intercept + slope * x`. */
function fitSimpleLinearRegression(x: Float64Array, y: Float64Array): { intercept: number, slope: number } {
    const n = x.length;
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < n; i++) {
        meanX += x[i];
        meanY += y[i];
    }
    meanX /= n;
    meanY /= n;

    let covXY = 0;
    let varX = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        covXY += dx * (y[i] - meanY);
        varX += dx * dx;
    }

    const slope = covXY / varX;
    const intercept = meanY - slope * meanX;
    return { intercept, slope };
}

export function gridFromParameters(accession: string, parameters: Float64Array): GridLike {
    switch (accession) {
        case LinearGrid.accesion:
            return new LinearGrid(parameters[0], parameters[1], parameters[2]);
        case SquareRootLinearGrid.accesion:
            return new SquareRootLinearGrid(parameters[0], parameters[1], parameters[2]);
        case BrukerTimsTOFTimsLinearGrid2.accesion:
            return new BrukerTimsTOFTimsLinearGrid2(
                parameters[0], parameters[1], parameters[2], parameters[3]);
        case BrukerTimsTOFMzGrid2.accesion:
            return new BrukerTimsTOFMzGrid2(
                parameters[0], parameters[1], parameters[2], parameters[3],
                parameters[4], parameters[5], parameters[6],
            );
        default:
            throw new Error(`Unknown grid accession: ${accession}`);
    }
}

export class LinearGrid implements GridLike {
    static readonly accesion = "MS:1003824";
    static readonly name = "linear grid interpolation";

    accesion = LinearGrid.accesion;
    name = LinearGrid.name;

    constructor(public intercept: number, public slope: number, public scale: number = 1.0) { }

    /** Fits the grid by regressing raw values against the quantized index they fall into over [low, high]. */
    static fit(values: Float64Array, low: number, high: number, scale: number = 1.0): LinearGrid {
        const stepSize = (high * scale - low * scale) / UINT32_MAX;
        const n = values.length;
        const scaledValues = new Float64Array(n);
        const indices = new Float64Array(n);
        const scaledLow = low * scale;
        for (let i = 0; i < n; i++) {
            const scaled = values[i] * scale;
            scaledValues[i] = scaled;
            indices[i] = Math.trunc((scaled - scaledLow) / stepSize);
        }
        const { intercept, slope } = fitSimpleLinearRegression(indices, scaledValues);
        return new LinearGrid(intercept, slope, scale);
    }

    toParameters(): Float64Array {
        return new Float64Array([this.intercept, this.slope, this.scale]);
    }

    fromParameters(accession: string, parameters: Float64Array): GridLike {
        return gridFromParameters(accession, parameters);
    }

    toIndex(value: number): number {
        const index = (value * this.scale - this.intercept) / this.slope;
        return Math.round(index);
    }

    fromIndex(index: number): number {
        return (this.intercept + index * this.slope) / this.scale;
    }

    maxError(values: Float64Array): number {
        let maxErr = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const yhat = this.fromIndex(this.toIndex(value));
            const err = Math.abs(value - yhat);
            if (err > maxErr) maxErr = err;
        }
        return maxErr;
    }
}

export class SquareRootLinearGrid implements GridLike {
    static readonly accesion = "MS:1003825";
    static readonly name = "square root grid interpolation";

    accesion = SquareRootLinearGrid.accesion;
    name = SquareRootLinearGrid.name;

    constructor(public intercept: number, public slope: number, public scale: number = 1.0) { }

    /** Fits the grid by regressing sqrt(value) against the quantized index it falls into over [low, high]. */
    static fit(values: Float64Array, low: number, high: number, scale: number = 1.0): SquareRootLinearGrid {
        const stepSize = (high * scale - low * scale) / UINT32_MAX;
        const n = values.length;
        const sqrtValues = new Float64Array(n);
        const indices = new Float64Array(n);
        const sqrtLow = Math.sqrt(low * scale);
        for (let i = 0; i < n; i++) {
            const sqrtScaled = Math.sqrt(values[i] * scale);
            sqrtValues[i] = sqrtScaled;
            indices[i] = Math.trunc((sqrtScaled - sqrtLow) / stepSize);
        }
        const { intercept, slope } = fitSimpleLinearRegression(indices, sqrtValues);
        return new SquareRootLinearGrid(intercept, slope, scale);
    }

    toParameters(): Float64Array {
        return new Float64Array([this.intercept, this.slope, this.scale]);
    }

    fromParameters(accession: string, parameters: Float64Array): GridLike {
        return gridFromParameters(accession, parameters);
    }

    toIndex(value: number): number {
        const index = (Math.sqrt(value * this.scale) - this.intercept) / this.slope;
        return Math.round(index);
    }

    fromIndex(index: number): number {
        const value = this.intercept + index * this.slope;
        return (value * value) / this.scale;
    }

    maxError(values: Float64Array): number {
        let maxErr = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const yhat = this.fromIndex(this.toIndex(value));
            const err = Math.abs(value - yhat);
            if (err > maxErr) maxErr = err;
        }
        return maxErr;
    }
}

/** Approximated Bruker timsTOF ion mobility (scan -> 1/K0) grid, model type 2. */
export class BrukerTimsTOFTimsLinearGrid2 implements GridLike {
    static readonly accesion = "MS:9999001";
    static readonly name = "rustims-approximated Bruker timsTOF ion mobility grid model";

    accesion = BrukerTimsTOFTimsLinearGrid2.accesion;
    name = BrukerTimsTOFTimsLinearGrid2.name;

    constructor(
        public c6: number,
        public c7: number,
        public offset: number,
        public slope: number,
    ) { }

    toParameters(): Float64Array {
        return new Float64Array([this.c6, this.c7, this.offset, this.slope]);
    }

    fromParameters(accession: string, parameters: Float64Array): GridLike {
        return gridFromParameters(accession, parameters);
    }

    fromIndex(index: number): number {
        const value = Number(index);
        return 1.0 / (this.c6 + this.c7 / (this.offset + this.slope * value));
    }

    toIndex(value: number): number {
        const denom = (1.0 / value) - this.c6;
        const index = ((this.c7 / denom) - this.offset) / this.slope;
        return clampU32(index);
    }

    maxError(values: Float64Array): number {
        let maxErr = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const yhat = this.fromIndex(this.toIndex(value));
            const err = Math.abs(value - yhat);
            if (err > maxErr) maxErr = err;
        }
        return maxErr;
    }
}

/** Approximated Bruker timsTOF m/z (TOF -> m/z) grid, model type 2ish
 * , including the cubic/quadratic correction terms. */
export class BrukerTimsTOFMzGrid2 implements GridLike {
    static readonly accesion = "MS:9999002";
    static readonly name = "rustims-approximated Bruker timsTOF m/z grid model";

    accesion = BrukerTimsTOFMzGrid2.accesion;
    name = BrukerTimsTOFMzGrid2.name;

    constructor(
        public c0: number,
        public beta: number,
        public c2: number,
        public c3: number,
        public c4: number,
        public slope: number,
        public intercept: number,
    ) { }

    toParameters(): Float64Array {
        return new Float64Array([this.c0, this.beta, this.c2, this.c3, this.c4, this.slope, this.intercept]);
    }

    fromParameters(accession: string, parameters: Float64Array): GridLike {
        return gridFromParameters(accession, parameters);
    }

    fromIndex(index: number): number {
        const tof = Number(index) * this.slope + this.intercept;
        let s = (tof - this.c0) / this.beta;

        if (this.c3 !== 0) {
            for (let i = 0; i < 8; i++) {
                const s2 = s * s;
                const f = this.c0 + this.beta * s + this.c2 * s2 + this.c3 * s2 * s - tof;
                const df = this.beta + 2.0 * this.c2 * s + 3.0 * this.c3 * s2;
                if (df === 0) break;
                const step = f / df;
                s -= step;
                if (Math.abs(step) < 1e-12) break;
            }
        } else if (this.c2 !== 0) {
            const d = this.beta * this.beta - 4.0 * this.c2 * (this.c0 - tof);
            if (d >= 0) {
                const q = -0.5 * (this.beta + Math.sqrt(d));
                s = (this.c0 - tof) / q;
            }
        }
        return s * s - this.c4;
    }

    toIndex(value: number): number {
        const lin = Math.sqrt(Math.max(value + this.c4, 0));
        const tof = this.c0 + this.beta * lin + this.c2 * lin * lin + this.c3 * lin * lin * lin;
        const index = (tof - this.intercept) / this.slope;
        return clampU32(index);
    }

    maxError(values: Float64Array): number {
        let maxErr = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const yhat = this.fromIndex(this.toIndex(value));
            const err = Math.abs(value - yhat);
            if (err > maxErr) maxErr = err;
        }
        return maxErr;
    }
}

