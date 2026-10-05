import { NextResponse } from "next/server";
import { getConfigStatus } from "../../../lib/config";
import { withAuth } from "../../../lib/withAuth";

export const runtime = "nodejs";

/** Tells the UI which env vars are set / missing so setup problems are obvious. */
export const GET = withAuth(async () => {
  return NextResponse.json({ status: getConfigStatus() });
});