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
