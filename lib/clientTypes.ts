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

/** Result of a single Buffer post attempt. */
export interface PostResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Tunnel info for serving rendered videos to Buffer. */
export interface TunnelInfo {
  mode: "ngrok" | "domain" | "none";
  url?: string;
  note?: string;
}
