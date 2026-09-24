import type { BufferChannel } from "./types";

/**
 * Buffer GraphQL client — SERVER-SIDE ONLY (handles personal API keys, never
 * send these responses containing raw tokens to the browser).
 *
 * Every request goes to a single endpoint: POST https://api.buffer.com with
 * `Authorization: Bearer <personal API key>` (buffer.com → Settings → API).
 * See https://developers.buffer.com/guides/authentication.html
 */
const BUFFER_ENDPOINT = "https://api.buffer.com";
const BUFFER_TIMEOUT_MS = 15_000;

export interface BufferOrg {
  id: string;
  name: string;
}

export interface BufferAccountInfo {
  id: string;
  name?: string | null;
  email?: string | null;
  organizations: BufferOrg[];
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

/** Minimal GraphQL caller: returns `data` or throws the first error message. */
async function bufferGraphql<T>(token: string, query: string): Promise<T> {
  const res = await fetch(BUFFER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
    cache: "no-store",
    signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(BUFFER_TIMEOUT_MS)
      : undefined,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Buffer rejected this API key (401 Unauthorized) — generate a fresh personal key at buffer.com → Settings → API."
    );
  }

  const body = (await res.json().catch(() => null)) as GraphqlEnvelope<T> | null;
  if (!body) throw new Error(`Buffer returned a non-JSON response (HTTP ${res.status}).`);
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).filter(Boolean).join("; ") || "Buffer GraphQL error.");
  }
  if (!body.data) throw new Error(`Buffer returned no data (HTTP ${res.status}).`);
  return body.data;
}

/** GraphQL string literal for an interpolated value (org/channel ids). */
function gqlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Validate a personal API key live against Buffer and resolve which
 * organization it should post through. The org is auto-detected from the
 * token via Buffer's `account` query (organizations list); an explicit
 * `organizationId` wins only when the token can actually reach it.
 */
export async function resolveBufferAccount(
  token: string,
  organizationId?: string
): Promise<{ info: BufferAccountInfo; organizationId: string }> {
  const data = await bufferGraphql<{ account: BufferAccountInfo | null }>(
    token,
    `query { account { id name email organizations { id name } } }`
  );
  const account = data.account;
  if (!account) throw new Error("Buffer returned no account for this API key.");
  const orgs = account.organizations ?? [];

  if (organizationId) {
    if (!orgs.some((o) => o.id === organizationId)) {
      throw new Error(
        `Organization "${organizationId}" is not reachable with this API key. Leave it blank to auto-detect.`
      );
    }
    return { info: account, organizationId };
  }
  if (orgs.length === 0) {
    throw new Error("This Buffer account has no organizations — connect a channel in buffer.com first.");
  }
  return { info: account, organizationId: orgs[0].id };
}

interface RawChannel {
  id: string;
  name?: string | null;
  displayName?: string | null;
  service?: string | null;
}

/**
 * Channels (social profiles) connected to one organization — this is what the
 * posting UI checks off per clip. Query mirrors Buffer's "Get Channels" example:
 * channels(input: { organizationId }) { id name displayName service }
 */
export async function fetchBufferChannels(token: string, organizationId: string): Promise<BufferChannel[]> {
  const query = `query GetChannels { channels(input: { organizationId: ${gqlString(
    organizationId
  )} }) { id name displayName service } }`;
  const data = await bufferGraphql<{ channels: RawChannel[] | null }>(token, query);
  return (data.channels ?? []).map((c) => ({
    id: String(c.id),
    service: String(c.service ?? "").toLowerCase(),
    displayName: c.displayName || c.name || String(c.service ?? ""),
  }));
}
