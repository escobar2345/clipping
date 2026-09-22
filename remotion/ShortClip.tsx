import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from "remotion";
import type { CaptionCue, ClipPlan } from "../lib/types";
import { segmentFrames } from "../lib/timeline";

export type ShortClipProps = {
  sourceVideoPath: string;
  clip: ClipPlan;
};

// 9:16, standard short-form dimensions
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
export const SHORT_FPS = 30;

function useZoomTransform(clip: ClipPlan, localSec: number) {
  const kfs = clip.zoomKeyframes.length
    ? clip.zoomKeyframes
    : [{ atSec: 0, scale: 1, focusX: 0.5, focusY: 0.5 }];

  let prev = kfs[0];
  let next = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (localSec >= kfs[i].atSec && localSec <= kfs[i + 1].atSec) {
      prev = kfs[i];
      next = kfs[i + 1];
      break;
    }
  }

  const span = Math.max(next.atSec - prev.atSec, 0.001);
  const t = Math.min(Math.max((localSec - prev.atSec) / span, 0), 1);
  const scale = interpolate(t, [0, 1], [prev.scale, next.scale]);
  const focusX = interpolate(t, [0, 1], [prev.focusX, next.focusX]);
  const focusY = interpolate(t, [0, 1], [prev.focusY, next.focusY]);
  return { scale, focusX, focusY };
}

// Smart reframing: where to place the 9:16 window over a wider source so it
// follows the speaker. Returns null when the clip has no crop track (=> the
// old centred crop). `x`/`y` are the subject's position as fractions of the
// SOURCE frame.
function useCropPlacement(clip: ClipPlan, relSec: number) {
  const crop = clip.crop;
  if (!crop || !crop.keyframes.length || !(crop.aspect > 0)) return null;

  const kfs = crop.keyframes;
  let x = kfs[0].x;
  let y = kfs[0].y;
  if (relSec >= kfs[kfs.length - 1].atSec) {
    x = kfs[kfs.length - 1].x;
    y = kfs[kfs.length - 1].y;
  } else if (relSec > kfs[0].atSec) {
    for (let i = 0; i < kfs.length - 1; i++) {
      if (relSec >= kfs[i].atSec && relSec <= kfs[i + 1].atSec) {
        const span = Math.max(kfs[i + 1].atSec - kfs[i].atSec, 0.001);
        const t = (relSec - kfs[i].atSec) / span;
        x = interpolate(t, [0, 1], [kfs[i].x, kfs[i + 1].x]);
        y = interpolate(t, [0, 1], [kfs[i].y, kfs[i + 1].y]);
        break;
      }
    }
  }

  const frameAspect = SHORT_WIDTH / SHORT_HEIGHT;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  if (crop.aspect >= frameAspect) {
    // wider than 9:16 (the normal case): video fills the height, slide sideways
    const fullW = SHORT_HEIGHT * crop.aspect;
    const overflow = fullW - SHORT_WIDTH;
    const left = clamp(x * fullW - SHORT_WIDTH / 2, 0, Math.max(overflow, 0));
    return {
      objectPosition: `${overflow > 0 ? (left / overflow) * 100 : 50}% 50%`,
      // where the face sits inside the visible frame => zoom in around it
      focusX: clamp((x * fullW - left) / SHORT_WIDTH, 0.2, 0.8),
      focusY: clamp(y, 0.25, 0.65),
    };
  }
  // taller than 9:16: video fills the width, slide up/down
  const fullH = SHORT_WIDTH / crop.aspect;
  const overflow = fullH - SHORT_HEIGHT;
  const top = clamp(y * fullH - SHORT_HEIGHT / 2, 0, Math.max(overflow, 0));
  return {
    objectPosition: `50% ${overflow > 0 ? (top / overflow) * 100 : 50}%`,
    focusX: 0.5,
    focusY: clamp((y * fullH - top) / SHORT_HEIGHT, 0.25, 0.65),
  };
}

const CAPTION_FONT = "Inter, Arial, sans-serif";
const ACTIVE_COLOR = "#FFE14D"; // currently spoken word
const IDLE_COLOR = "#FFFFFF";

// TikTok / Reels / Shorts cover the bottom ~20% (caption + buttons) and the
// right edge with their own UI, so captions sit above that band.
const CAPTION_BOTTOM_PX = 400;
const CAPTION_SIDE_PX = 90;

const Captions: React.FC<{ clip: ClipPlan; localSec: number }> = ({ clip, localSec }) => {
  const { fps } = useVideoConfig();

  const cues: CaptionCue[] = clip.captions ?? [];
  const active = cues.find((c) => localSec >= c.startSec && localSec < c.endSec);
  if (!active) return null;

  // Pop-in: quick scale + fade on the first frames of every cue.
  const sinceStart = Math.max(0, (localSec - active.startSec) * fps);
  const pop = spring({
    frame: sinceStart,
    fps,
    config: { damping: 14, stiffness: 220, mass: 0.6 },
    durationInFrames: 8,
  });
  const scale = interpolate(pop, [0, 1], [0.82, 1]);
  const opacity = interpolate(sinceStart, [0, 3], [0, 1], { extrapolateRight: "clamp" });

  // Word highlight: the last word whose start time has passed.
  let activeWordIdx = -1;
  if (active.words?.length) {
    active.words.forEach((w, i) => {
      if (localSec >= w.startSec) activeWordIdx = i;
    });
  } else if (typeof active.emphasizeWordIndex === "number") {
    activeWordIdx = active.emphasizeWordIndex;
  }

  const wordStyle = (isActive: boolean): React.CSSProperties => ({
    color: isActive ? ACTIVE_COLOR : IDLE_COLOR,
    display: "inline-block",
    transform: isActive ? "scale(1.08)" : "scale(1)",
    margin: "0 0.14em",
  });

  return (
    <div
      style={{
        position: "absolute",
        bottom: CAPTION_BOTTOM_PX,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: `0 ${CAPTION_SIDE_PX}px`,
      }}
    >
      <span
        style={{
          fontFamily: CAPTION_FONT,
          fontWeight: 900,
          fontSize: 72,
          lineHeight: 1.15,
          textAlign: "center",
          textShadow: "0 4px 18px rgba(0,0,0,0.7)",
          // Solid outline drawn BEHIND the fill (paintOrder) so the highlight
          // colour stays readable over bright / busy footage.
          WebkitTextStroke: "7px rgba(0,0,0,0.9)",
          paintOrder: "stroke fill",
          strokeLinejoin: "round",
          opacity,
          transform: `scale(${scale})`,
        }}
      >
        {active.words?.length
          ? active.words.map((w, i) => (
              <span key={i} style={wordStyle(i === activeWordIdx)}>
                {w.text}
              </span>
            ))
          : active.text.split(" ").map((t, i) => (
              <span key={i} style={wordStyle(i === activeWordIdx)}>
                {t}
              </span>
            ))}
      </span>
    </div>
  );
};

export const ShortClipComposition: React.FC<ShortClipProps> = ({ sourceVideoPath, clip }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Time on the FINISHED clip (after any silence / filler cuts) — captions,
  // zoom and crop are all authored on this timeline.
  const relativeSec = frame / fps;

  const zoom = useZoomTransform(clip, relativeSec);
  const placement = useCropPlacement(clip, relativeSec);
  // when the crop follows a face, zoom in around the face, not the frame centre
  const scale = zoom.scale;
  const focusX = placement ? placement.focusX : zoom.focusX;
  const focusY = placement ? placement.focusY : zoom.focusY;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${focusX * 100}% ${focusY * 100}%`,
        }}
      >
        {/* One piece per kept segment, laid end to end. An untightened clip is
            a single piece, exactly as before. */}
        {segmentFrames(clip, fps).map((seg, i) => (
          <Sequence key={i} from={seg.outFrom} durationInFrames={seg.frames}>
            <OffthreadVideo
              src={sourceVideoPath}
              startFrom={seg.srcFrom}
              endAt={seg.srcFrom + seg.frames}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: placement ? placement.objectPosition : "50% 50%",
              }}
            />
          </Sequence>
        ))}
      </AbsoluteFill>

      <Captions clip={clip} localSec={relativeSec} />

      <Sequence from={0} durationInFrames={Math.round(30 * fps)}>
        <div
          style={{
            position: "absolute",
            top: 90,
            left: 40,
            right: 40,
            fontFamily: "Inter, Arial, sans-serif",
            fontWeight: 900,
            fontSize: 52,
            color: "white",
            textShadow: "0 4px 18px rgba(0,0,0,0.6)",
          }}
        >
          {clip.hookTitle}
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};
