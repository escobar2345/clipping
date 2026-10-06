// Higgsfield asset downloader. Downloads generated media (video clips, images)
// from Higgsfield URLs to local storage so Remotion can composite them into
// the final render. Follows the same lazy-download pattern as the video file
// fetching in the render route.
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Download a remote file (Higgsfield-generated video or image) to local storage.
 * Files are cached in public/uploads so repeated renders don't re-download.
 * Returns the local path that Remotion can read.
 */
export async function downloadHiggsfieldAsset(
  url: string,
  assetId: string,
  type: "video" | "image"
): Promise<string> {
  const ext = type === "video" ? ".mp4" : ".png";
  const localName = `hf-${assetId}${ext}`;
  const outDir = path.join(process.cwd(), "public", "uploads");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, localName);

  // Already cached — return immediately
  if (fs.existsSync(outPath)) {
    return `/uploads/${localName}`;
  }

  // Download the file
  await downloadFile(url, outPath);
  return `/uploads/${localName}`;
}

/**
 * Download a file from a URL to a local path.
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, (response) => {
        // Handle redirects
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          downloadFile(response.headers.location, dest).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

/**
 * Download all Higgsfield-generated assets in an edit plan.
 * Returns the plan with localPath populated on each asset.
 */
export async function downloadEditPlanAssets(editPlan: any): Promise<any> {
  if (!editPlan?.generatedAssets?.length) return editPlan;

  const updated = { ...editPlan };
  updated.generatedAssets = await Promise.all(
    editPlan.generatedAssets.map(async (asset: any) => {
      if (!asset.url || asset.localPath) return asset;
      try {
        const localPath = await downloadHiggsfieldAsset(
          asset.url,
          asset.assetId,
          asset.type
        );
        return { ...asset, localPath };
      } catch (err) {
        console.error(`[Higgsfield] Failed to download asset ${asset.assetId}:`, err);
        return asset; // Return without localPath — render will skip it
      }
    })
  );

  return updated;
}
