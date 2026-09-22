import { execFile } from "child_process";
import { promisify } from "util";
import type { ClipPlan, CropKeyframe } from "./types";
import { clipSegments, editedDurationSec, sourceToEdited } from "./timeline";
import { clusterDetections, runCascade, unpackCascade, type Classifier } from "./vendor/pico";
import { FACEFINDER_B64 } from "./vendor/facefinder";

const execFileAsync = promisify(execFile);

// Smart reframing: a 16:9 video turned into 9:16 loses two thirds of the
// picture. Instead of always keeping the middle, find the speaker's face and
// slide the 9:16 window to follow it.
//
// Free and light: a tiny face detector (pico, ~200 lines of plain JS, MIT) run
// on a couple of small grayscale frames per second. No API, no Python, no
// native install. It only finds roughly front-facing faces — so whenever it
// isn't confident (no face, screen recording, too few detections) it steps
// aside and the ordinary centred crop is used. It can never make a clip worse
// than before by failing.
//
//   SMART_REFRAME=0   turn it off (always centre crop)

export function reframeEnabled(): boolean {
  return process.env.SMART_REFRAME !== "0";
}

// Detection runs on small grayscale frames. 800 px wide is a good balance:
// measured ~40-60 ms per frame, and it still finds faces down to ~10% of the
// frame height (a wide shot of one person), where 320 px was unreliable.
const FRAME_W = 800;
const SAMPLE_FPS = 2;
const LONG_CLIP_SEC = 90; // sample once a second beyond this, to stay light
const MIN_DETECTION_RATE = 0.25; // fewer sampled frames with a face than this => don't reframe
const MIN_FACE_SCORE = 5.0; // pico's usual acceptance threshold
const FRAME_ASPECT = 1080 / 1920;

let _classifier: Classifier | null = null;
function classifier(): Classifier {
  if (!_classifier) _classifier = unpackCascade(new Uint8Array(Buffer.from(FACEFINDER_B64, "base64")));
  return _classifier;
}

export interface Face {
  /** centre, as a fraction of the frame */
  x: number;
  y: number;
  /** face height as a fraction of frame height */
  size: number;
}

/** Faces in one tightly packed 8-bit grayscale frame. */
export function detectFaces(pixels: Uint8Array, width: number, height: number): Face[] {
  const dets = runCascade({ pixels, nrows: height, ncols: width, ldim: width }, classifier(), {
    shiftfactor: 0.1,
    minsize: Math.max(16, Math.round(height * 0.06)),
    maxsize: Math.round(height * 0.9),
    scalefactor: 1.1,
  });
  return clusterDetections(dets, 0.2)
    .filter((d) => d[3] >= MIN_FACE_SCORE)
    .map((d) => ({ x: d[1] / width, y: d[0] / height, size: d[2] / height }));
}

// ---- subject tracking ------------------------------------------------------

export interface FrameSample {
  /** source-video seconds */
  t: number;
  faces: Face[];
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Turns per-frame face detections into a smooth camera path, or null when the
 * detections aren't reliable enough to trust.
 */
export function buildSubjectPath(
  samples: FrameSample[],
  fps: number = SAMPLE_FPS
): { t: number; x: number; y: number }[] | null {
  if (samples.length < 3) return null;
  const withFace = samples.filter((s) => s.faces.length).length;
  if (withFace / samples.length < MIN_DETECTION_RATE) return null;

  // 1) follow ONE subject: prefer big faces, stay with whoever we were on
  let prev: { x: number; y: number } | null = null;
  const chosen: (Face | null)[] = samples.map((s) => {
    if (!s.faces.length) return null;
    let best = s.faces[0];
    let bestScore = -Infinity;
    for (const f of s.faces) {
      const score = f.size - (prev ? 0.8 * Math.hypot(f.x - prev.x, f.y - prev.y) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    prev = { x: best.x, y: best.y };
    return best;
  });

  // 2) fill gaps: hold the last known spot (up to ~2s), else use the next
  //    known one, else the speaker's usual position
  const known = chosen.filter((c): c is Face => !!c);
  const usual = { x: median(known.map((k) => k.x)), y: median(known.map((k) => k.y)) };
  const holdSamples = Math.max(1, Math.round(2 * fps));
  const filled = chosen.map((c, i) => {
    if (c) return { x: c.x, y: c.y };
    for (let k = 1; k <= holdSamples; k++) {
      const b = chosen[i - k];
      if (b) return { x: b.x, y: b.y };
    }
    for (let k = 1; k <= holdSamples; k++) {
      const f = chosen[i + k];
      if (f) return { x: f.x, y: f.y };
    }
    return usual;
  });

  // 3) drop single-frame glitches
  const med = filled.map((_, i) => {
    const win = filled.slice(Math.max(0, i - 1), Math.min(filled.length, i + 2));
    return { x: median(win.map((w) => w.x)), y: median(win.map((w) => w.y)) };
  });

  // 4) virtual camera: ignore small movements (a still camera on a person who
  //    fidgets), follow real ones, and ease into the new position
  const DEAD_X = 0.045;
  const DEAD_Y = 0.06;
  const EASE = 0.6;
  const cam = { x: med[0].x, y: med[0].y };
  const out = { x: cam.x, y: cam.y };
  return samples.map((s, i) => {
    const m = med[i];
    if (Math.abs(m.x - cam.x) > DEAD_X) cam.x = m.x - Math.sign(m.x - cam.x) * DEAD_X * 0.4;
    if (Math.abs(m.y - cam.y) > DEAD_Y) cam.y = m.y - Math.sign(m.y - cam.y) * DEAD_Y * 0.4;
    out.x += EASE * (cam.x - out.x);
    out.y += EASE * (cam.y - out.y);
    return { t: s.t, x: +out.x.toFixed(4), y: +out.y.toFixed(4) };
  });
}

// ---- video plumbing --------------------------------------------------------

/** Display size of the first video stream (rotation-aware), or null. */
async function probeSize(videoPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
        "-of", "json",
        videoPath,
      ],
      { timeout: 30_000, windowsHide: true }
    );
    const st = JSON.parse(stdout)?.streams?.[0];
    if (!st?.width || !st?.height) return null;
    const rot = Math.abs(Number(st.side_data_list?.[0]?.rotation ?? st.tags?.rotate ?? 0));
    return rot % 180 === 90 ? { width: st.height, height: st.width } : { width: st.width, height: st.height };
  } catch {
    return null;
  }
}

async function grabGrayFrames(
  videoPath: string,
  startSec: number,
  durSec: number,
  w: number,
  h: number,
  fps: number
): Promise<Uint8Array[]> {
  const { stdout } = (await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      "-ss", startSec.toFixed(3),
      "-t", durSec.toFixed(3),
      "-i", videoPath,
      "-vf", `fps=${fps},scale=${w}:${h},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: 180_000, windowsHide: true } as any
  )) as unknown as { stdout: Buffer };
  const frameBytes = w * h;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + frameBytes <= stdout.length; off += frameBytes) {
    frames.push(new Uint8Array(stdout.buffer, stdout.byteOffset + off, frameBytes));
  }
  return frames;
}

/**
 * Works out where the 9:16 window should sit for every moment of the clip.
 * Returns null (=> use the normal centred crop) when the source is already
 * tall, no face is reliably found, or anything at all goes wrong.
 */
export async function computeCrop(videoPath: string, clip: ClipPlan): Promise<ClipPlan["crop"] | null> {
  try {
    const size = await probeSize(videoPath);
    if (!size) return null;
    const aspect = size.width / size.height;
    // a source that is already (nearly) 9:16 has no sideways room to slide into
    if (aspect < FRAME_ASPECT * 1.15) return null;

    const h = Math.max(2, Math.round((FRAME_W * size.height) / size.width / 2) * 2);
    const segs = clipSegments(clip);
    const fps = editedDurationSec(clip) > LONG_CLIP_SEC ? 1 : SAMPLE_FPS;

    const samples: FrameSample[] = [];
    for (const seg of segs) {
      const frames = await grabGrayFrames(videoPath, seg.startSec, seg.endSec - seg.startSec, FRAME_W, h, fps);
      frames.forEach((px, k) => {
        samples.push({ t: seg.startSec + k / fps, faces: detectFaces(px, FRAME_W, h) });
      });
    }

    const path = buildSubjectPath(samples, fps);
    if (!path) return null;

    const dur = editedDurationSec(clip);
    const keyframes: CropKeyframe[] = path.map((p) => ({
      atSec: +Math.min(Math.max(sourceToEdited(segs, p.t), 0), dur).toFixed(3),
      x: p.x,
      y: p.y,
    }));
    // cover the whole clip so the window never jumps at the start / end
    if (keyframes[0].atSec > 0.001) keyframes.unshift({ ...keyframes[0], atSec: 0 });
    const last = keyframes[keyframes.length - 1];
    if (last.atSec < dur - 0.001) keyframes.push({ ...last, atSec: +dur.toFixed(3) });

    return { aspect, keyframes };
  } catch (err) {
    console.warn("[reframe] skipped, using centred crop:", String(err).slice(0, 200));
    return null;
  }
}
