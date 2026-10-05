/** A single missing environment-variable entry. */
export interface ConfigEntry {
  key: string;
  label: string;
  hint: string;
}

/** Server-side configuration status — which required env vars are missing. */
export interface ConfigStatus {
  ok: boolean;
  missing: ConfigEntry[];
}

/** One row in the config report. */
export interface ConfigItem extends ConfigEntry {
  /** Whether the env var is present and non-empty. */
  set: boolean;
  /** True for vars the pipeline can run without. */
  optional: boolean;
}

const REQUIRED: ConfigEntry[] = [
  {
    key: "APIFY_TOKEN",
    label: "Apify API token",
    hint: "console.apify.com → Settings → Integrations → API tokens",
  },
  {
    key: "APIFY_YOUTUBE_ACTOR_ID",
    label: "Apify YouTube actor ID",
    hint: "apify.com/store — e.g. a transcript + video-download actor",
  },
  {
    key: "NVIDIA_API_KEY",
    label: "NVIDIA build API key",
    hint: "build.nvidia.com → your API key (used by the AI edit-plan step)",
  },
];

const OPTIONAL: ConfigEntry[] = [
  {
    key: "DEEPGRAM_API_KEY",
    label: "Deepgram API key",
    hint: "deepgram.com → speech-to-text when a video has no captions",
  },
  {
    key: "BUFFER_ACCESS_TOKEN",
    label: "Buffer personal API key",
    hint: "buffer.com → Settings → API (posting is skipped without it)",
  },
  {
    key: "NGROK_AUTHTOKEN",
    label: "ngrok authtoken",
    hint: "dashboard.ngrok.com → Your Authtoken (auto-tunnel for local posting)",
  },
];

/**
 * Which env vars are configured and which are still missing, so the UI can say
 * exactly what to set instead of showing a bare 500. Reports whether a variable
 * holds a real value rather than the `your_…` placeholder from the example file.
 */
export function getConfigStatus(): {
  items: ConfigItem[];
  missing: ConfigEntry[];
  ok: boolean;
  complete: boolean;
} {
  const isSet = (key: string) => {
    const v = (process.env[key] ?? "").trim();
    return Boolean(v) && !v.startsWith("your_");
  };

  const items: ConfigItem[] = [
    ...REQUIRED.map((r) => ({ ...r, set: isSet(r.key), optional: false })),
    ...OPTIONAL.map((r) => ({ ...r, set: isSet(r.key), optional: true })),
  ];

  const missing = items.filter((i) => !i.set && !i.optional).map(({ key, label, hint }) => ({ key, label, hint }));

  return { items, missing, ok: missing.length === 0, complete: missing.length === 0 };
}
