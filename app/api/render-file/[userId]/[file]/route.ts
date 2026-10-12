import fs from "fs";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpg|mpeg|flv|ts)$/i;
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
};

type RouteContext = { params: { userId: string; file: string } };

function mediaCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
  };
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: mediaCorsHeaders() });
}

/**
 * Serves a rendered clip from public/renders/<userId>/<file>.
 *
 * WHY THIS EXISTS: in production `next start` snapshots the `public/` folder
 * once at boot (see next/dist/server/lib/router-utils/filesystem.js — the
 * `if (!opts.dev) recursiveReadDir(publicFolderPath)` loop) and only serves
 * files in that snapshot. Clips rendered AFTER boot aren't in it, so the plain
 * static URL /renders/<userId>/<file> 404s on a live server (but works in
 * `next dev`, which serves the folder live). Reading the file here in a route
 * handler bypasses that snapshot entirely, so runtime-written renders play.
 */
function fileResponse(request: Request, { userId, file }: RouteContext["params"], headOnly: boolean) {
  if (!UUID_RE.test(userId) || path.basename(file) !== file || !VIDEO_EXT.test(file)) {
    return new Response("Invalid media path", { status: 400, headers: mediaCorsHeaders() });
  }

  const rendersRoot = path.resolve(process.cwd(), "public", "renders");
  const filePath = path.resolve(rendersRoot, userId, file);
  if (!filePath.startsWith(`${rendersRoot}${path.sep}`) || !fs.existsSync(filePath)) {
    return new Response("Rendered clip is not present on this server", {
      status: 404,
      headers: mediaCorsHeaders(),
    });
  }

  const size = fs.statSync(filePath).size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, {
        status: 416,
        headers: { ...mediaCorsHeaders(), "Content-Range": `bytes */${size}` },
      });
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, size - suffixLength);
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...mediaCorsHeaders(), "Content-Range": `bytes */${size}` },
      });
    }
    status = 206;
  }

  const headers = new Headers({
    ...mediaCorsHeaders(),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(end - start + 1),
    "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const body = headOnly
    ? null
    : (Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}

export function GET(request: Request, context: RouteContext) {
  return fileResponse(request, context.params, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return fileResponse(request, context.params, true);
}
