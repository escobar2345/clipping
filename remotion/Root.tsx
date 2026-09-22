import React from "react";
import { Composition, getInputProps } from "remotion";
import { ShortClipComposition, SHORT_WIDTH, SHORT_HEIGHT, SHORT_FPS } from "./ShortClip";
import type { EditPlan } from "../lib/types";
import { totalFrames } from "../lib/timeline";

// When rendering via @remotion/renderer (see app/api/render/route.ts) we pass
// the full EditPlan as inputProps and pick which clip index to render.
export const RemotionRoot: React.FC = () => {
  const inputProps = getInputProps() as { editPlan?: EditPlan; clipIndex?: number };
  const editPlan = inputProps.editPlan;
  const clipIndex = inputProps.clipIndex ?? 0;
  const clip = editPlan?.clips?.[clipIndex];

  if (!editPlan || !clip) {
    // Fallback so `remotion studio` still opens without props for local dev
    return (
      <Composition
        id="ShortClip"
        component={ShortClipComposition}
        durationInFrames={SHORT_FPS * 15}
        fps={SHORT_FPS}
        width={SHORT_WIDTH}
        height={SHORT_HEIGHT}
        defaultProps={{
          sourceVideoPath: "",
          clip: {
            clipId: "preview",
            sourceStartSec: 0,
            sourceEndSec: 15,
            hookTitle: "Preview",
            captions: [],
            zoomKeyframes: [],
          },
        }}
      />
    );
  }

  return (
    <Composition
      id="ShortClip"
      component={ShortClipComposition}
      durationInFrames={totalFrames(clip, SHORT_FPS)}
      fps={SHORT_FPS}
      width={SHORT_WIDTH}
      height={SHORT_HEIGHT}
      defaultProps={{ sourceVideoPath: editPlan.sourceVideoPath, clip }}
    />
  );
};
