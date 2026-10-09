import fs from "fs";
import path from "path";

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

function fileResponse(request: Request, { userId, file }: RouteContext["params"], headOnly: boolean) {
  if (!UUID_RE.test(userId) || path.basename(file) !== file || !VIDEO_EXT.test(file)) {
    return new Response("Invalid media path", { status: 400 });
  }

  const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
  const filePath = path.resolve(uploadsRoot, userId, file);
  if (!filePath.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(filePath)) {
    return new Response("Source video file is not present on this server", { status: 404 });
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
        headers: { "Content-Range": `bytes */${size}` },
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
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    status = 206;
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(end - start + 1),
    "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const body = headOnly
    ? null
    : (() => {
        let fileStream: fs.ReadStream | undefined;
        return new ReadableStream<Uint8Array>({
        start(controller) {
          fileStream = fs.createReadStream(filePath, { start, end });
          fileStream.on("data", (chunk: Buffer | string) => {
            controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
          });
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (error) => controller.error(error));
        },
        cancel() {
          fileStream?.destroy();
        },
      });
    })();
  return new Response(body, { status, headers });
}

export function GET(request: Request, context: RouteContext) {
  return fileResponse(request, context.params, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return fileResponse(request, context.params, true);
}