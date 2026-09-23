import type { BufferChannel } from "./types";

/** A saved Buffer account as sent to the browser (tokens are masked). */
export interface PublicAccount {
  id: string;
  name: string;
  organizationId: string;
}

/** Channels loaded for one account — grouped for the posting UI. */
export interface AccountChannels {
  account: { id: string; name: string };
  channels: BufferChannel[];
  error?: string;
}

/** Result of posting to Buffer — one request fans out to every selected
 *  channel across every selected account (see /api/buffer/post), so the
 *  response carries an aggregate summary plus per-target details. */
export interface PostResponse {
  ok: boolean;
  /** Aggregate outcome across all targeted channels. */
  summary: {
    succeeded: number;
    failed: number;
    total: number;
  };
  /** Id of a single post (kept for single-target responses). */
  id?: string;
  error?: string;
}

/** Tunnel info for serving rendered videos to Buffer. */
export interface TunnelInfo {
  mode: "ngrok" | "domain" | "none";
  url?: string;
  note?: string;
}
