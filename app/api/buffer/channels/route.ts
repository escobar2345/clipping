import { NextResponse } from "next/server";
import { listAccounts } from "../../../../lib/accounts";
import { fetchBufferChannels, resolveBufferAccount } from "../../../../lib/buffer";
import type { AccountChannels } from "../../../../lib/clientTypes";

/**
 * Channels (social profiles) for every account the app can post through,
 * grouped per account for the posting UI. One account failing (revoked key,
 * Buffer down) only marks THAT account with an error — the rest still load.
 *
 * Response: { accounts: AccountChannels[] }
 */
export async function GET() {
  const accounts = listAccounts();

  const results: AccountChannels[] = await Promise.all(
    accounts.map(async (acc): Promise<AccountChannels> => {
      try {
        // Saved accounts always have an org (resolved at add time); the env
        // fallback may not — resolve it from the token on the fly.
        const orgId = acc.organizationId || (await resolveBufferAccount(acc.accessToken)).organizationId;
        const channels = await fetchBufferChannels(acc.accessToken, orgId);
        return { account: { id: acc.id, name: acc.name }, channels };
      } catch (err) {
        return {
          account: { id: acc.id, name: acc.name },
          channels: [],
          error: err instanceof Error ? err.message : "Could not load channels from Buffer.",
        };
      }
    })
  );

  return NextResponse.json({ accounts: results });
}
