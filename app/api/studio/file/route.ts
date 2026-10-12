import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
};

function studioRoot(): string {
  const dir = path.join(process.cwd(), "data", "studio");
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

// Streams a studio file (upload or export) to the browser. Supports HTTP Range
// so the <video> preview can seek and scrub.
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") ?? "";
  // Only allow "<uploads|exports>/<safe-name>" — never arbitrary paths.
  if (!/^(uploads|exports)\/[A-Za-z0-9._-]+$/.test(name)) {
    return new Response("Bad file name", { status: 400 });
  }
  const file = path.join(studioRoot(), name);
  if (!fs.existsSync(file)) {
    return new Response("Not found", { status: 404 });
  }

  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const download = req.nextUrl.searchParams.get("download") === "1";

  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
  }

  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat.size}` },
      });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["Content-Length"] = String(end - start + 1);
    const nodeStream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(nodeStream) as any, { status: 206, headers });
  }

  headers["Content-Length"] = String(stat.size);
  const nodeStream = fs.createReadStream(file);
  return new Response(Readable.toWeb(nodeStream) as any, { status: 200, headers });
}
