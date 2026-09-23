import path from "path";
import fs from "fs";
import os from "os";

/**
 * Returns the directory for persistent server-side data storage
 * (prompt overrides, account keys, transcript cache, etc.).
 *
 * Uses `data/` relative to the project root locally; falls back to a
 * temp directory on read-only filesystems (e.g. Vercel serverless).
 */
export function getStore(): { dir: string } {
  const localDir = path.join(process.cwd(), "data");
  try {
    fs.mkdirSync(localDir, { recursive: true });
    // Test write access
    const testFile = path.join(localDir, ".write-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return { dir: localDir };
  } catch {
    const tmpDir = path.join(os.tmpdir(), "long2short");
    fs.mkdirSync(tmpDir, { recursive: true });
    return { dir: tmpDir };
  }
}
