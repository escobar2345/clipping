#!/usr/bin/env node
/**
 * Download Remotion's matching Chrome Headless Shell during image installation,
 * not during the first user's /api/render request. This avoids a ~92 MB network
 * download in the synchronous render request and makes deployment fail early if
 * the browser asset cannot be prepared.
 */
import { ensureBrowser } from "@remotion/renderer";

console.log("[install-remotion-browser] Ensuring Remotion Chrome Headless Shell is present...");
await ensureBrowser({
  onBrowserDownload: () => ({
    version: null,
    onProgress: ({ percent }) => {
      if (percent !== null) {
        console.log(`[install-remotion-browser] ${Math.round(percent * 100)}%`);
      }
    },
  }),
});
console.log("[install-remotion-browser] Remotion browser is ready.");