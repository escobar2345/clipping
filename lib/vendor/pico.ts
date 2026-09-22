/*
 * Pico face detector — TypeScript port of pico.js.
 * Original: https://github.com/nenadmarkus/picojs
 * Copyright (c) 2013 Nenad Markus. Released under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * The face model ("facefinder") ships in the same MIT-licensed repository:
 * https://github.com/nenadmarkus/pico
 */

/** [row, col, size, score] — centre of the detection in pixels. */
export type Detection = [number, number, number, number];

export interface GrayImage {
  pixels: Uint8Array;
  nrows: number;
  ncols: number;
  /** row stride (== ncols for a tightly packed image) */
  ldim: number;
}

export type Classifier = (r: number, c: number, s: number, pixels: Uint8Array, ldim: number) => number;

export interface CascadeParams {
  shiftfactor: number;
  minsize: number;
  maxsize: number;
  scalefactor: number;
}

export function unpackCascade(bytes: Uint8Array): Classifier {
  const dview = new DataView(new ArrayBuffer(4));
  // skip the first 8 bytes (cascade version + training bookkeeping)
  let p = 8;

  dview.setUint8(0, bytes[p + 0]);
  dview.setUint8(1, bytes[p + 1]);
  dview.setUint8(2, bytes[p + 2]);
  dview.setUint8(3, bytes[p + 3]);
  const tdepth = dview.getInt32(0, true);
  p += 4;

  dview.setUint8(0, bytes[p + 0]);
  dview.setUint8(1, bytes[p + 1]);
  dview.setUint8(2, bytes[p + 2]);
  dview.setUint8(3, bytes[p + 3]);
  const ntrees = dview.getInt32(0, true);
  p += 4;

  const tcodesLs: number[] = [];
  const tpredsLs: number[] = [];
  const threshLs: number[] = [];
  const nodes = Math.pow(2, tdepth);

  for (let t = 0; t < ntrees; ++t) {
    // binary tests placed in the internal tree nodes
    tcodesLs.push(0, 0, 0, 0);
    for (let i = p; i < p + 4 * nodes - 4; ++i) tcodesLs.push(bytes[i]);
    p += 4 * nodes - 4;
    // predictions in the leaf nodes
    for (let i = 0; i < nodes; ++i) {
      dview.setUint8(0, bytes[p + 0]);
      dview.setUint8(1, bytes[p + 1]);
      dview.setUint8(2, bytes[p + 2]);
      dview.setUint8(3, bytes[p + 3]);
      tpredsLs.push(dview.getFloat32(0, true));
      p += 4;
    }
    // the stage threshold
    dview.setUint8(0, bytes[p + 0]);
    dview.setUint8(1, bytes[p + 1]);
    dview.setUint8(2, bytes[p + 2]);
    dview.setUint8(3, bytes[p + 3]);
    threshLs.push(dview.getFloat32(0, true));
    p += 4;
  }

  const tcodes = new Int8Array(tcodesLs);
  const tpreds = new Float32Array(tpredsLs);
  const thresh = new Float32Array(threshLs);

  return function classifyRegion(r, c, s, pixels, ldim) {
    r = 256 * r;
    c = 256 * c;
    let root = 0;
    let o = 0.0;
    const pow2tdepth = nodes >> 0;

    for (let i = 0; i < ntrees; ++i) {
      let idx = 1;
      for (let j = 0; j < tdepth; ++j) {
        // '>> 8' is an integer division and matters for performance
        const a = pixels[((r + tcodes[root + 4 * idx + 0] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)];
        const b = pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)];
        idx = 2 * idx + (a <= b ? 1 : 0);
      }
      o += tpreds[pow2tdepth * i + idx - pow2tdepth];
      if (o <= thresh[i]) return -1;
      root += 4 * pow2tdepth;
    }
    return o - thresh[ntrees - 1];
  };
}

export function runCascade(image: GrayImage, classify: Classifier, params: CascadeParams): Detection[] {
  const { pixels, nrows, ncols, ldim } = image;
  const { shiftfactor, minsize, maxsize, scalefactor } = params;

  let scale = minsize;
  const detections: Detection[] = [];
  while (scale <= maxsize) {
    const step = Math.max(shiftfactor * scale, 1) >> 0;
    const offset = (scale / 2 + 1) >> 0;
    for (let r = offset; r <= nrows - offset; r += step) {
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classify(r, c, scale, pixels, ldim);
        if (q > 0.0) detections.push([r, c, scale, q]);
      }
    }
    scale = scale * scalefactor;
  }
  return detections;
}

/** Non-maximum suppression: merges overlapping detections into clusters. */
export function clusterDetections(dets: Detection[], iouThreshold: number): Detection[] {
  dets = dets.sort((a, b) => b[3] - a[3]);

  const iou = (d1: Detection, d2: Detection) => {
    const [r1, c1, s1] = d1;
    const [r2, c2, s2] = d2;
    const overr = Math.max(0, Math.min(r1 + s1 / 2, r2 + s2 / 2) - Math.max(r1 - s1 / 2, r2 - s2 / 2));
    const overc = Math.max(0, Math.min(c1 + s1 / 2, c2 + s2 / 2) - Math.max(c1 - s1 / 2, c2 - s2 / 2));
    return (overr * overc) / (s1 * s1 + s2 * s2 - overr * overc);
  };

  const assigned = new Array(dets.length).fill(0);
  const clusters: Detection[] = [];
  for (let i = 0; i < dets.length; ++i) {
    if (assigned[i] !== 0) continue;
    let r = 0, c = 0, s = 0, q = 0, n = 0;
    for (let j = i; j < dets.length; ++j) {
      if (iou(dets[i], dets[j]) > iouThreshold) {
        assigned[j] = 1;
        r += dets[j][0];
        c += dets[j][1];
        s += dets[j][2];
        q += dets[j][3];
        n += 1;
      }
    }
    clusters.push([r / n, c / n, s / n, q]);
  }
  return clusters;
}
