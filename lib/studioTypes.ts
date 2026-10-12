// Shared contracts for the Editing Studio (the Premiere-style tab).
// Kept in lib/ so both the React component and the API routes agree on shape.

export type StudioMedia = {
  mediaId: string; // stored file name, e.g. "st-abc123.mp4"
  name: string; // original filename shown in the bin
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type StudioTransition = "none" | "fade" | "dissolve";

export type StudioClip = {
  id: string;
  mediaId: string;
  srcStart: number; // in-point within the source (seconds)
  srcEnd: number; // out-point within the source (seconds)
  speed: number; // 0.5..2
  volume: number; // 0..2
  text: string; // overlay title burned into the clip
  transition: StudioTransition;
};

export type StudioTimeline = { clips: StudioClip[]; fps: number };

// The operations the AI (or you, manually) can perform. This is the "full
// control" surface — the model returns an ordered list of these.
export type StudioAction =
  | { op: "addMedia"; mediaId: string; at?: number }
  | { op: "split"; atSec: number }
  | { op: "trim"; clipId: string; srcStart?: number; srcEnd?: number }
  | { op: "setSpeed"; clipId: string; speed: number }
  | { op: "setVolume"; clipId: string; volume: number }
  | { op: "setText"; clipId: string; text: string }
  | { op: "setTransition"; clipId: string; transition: StudioTransition }
  | { op: "removeClip"; clipId: string }
  | { op: "moveClip"; clipId: string; toIndex: number }
  | { op: "clearTimeline" }
  | { op: "setPlayhead"; atSec: number };

export type StudioChatMsg = { role: "user" | "assistant"; content: string };

export type StudioAIRequest = {
  instruction: string;
  history: StudioChatMsg[];
  context: {
    media: StudioMedia[];
    timeline: StudioTimeline;
    playhead: number;
    selectedClipId: string | null;
  };
};

export type StudioAIResponse = { reply: string; actions: StudioAction[] };
