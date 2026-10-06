import dns from "dns";
import https from "https";
import net from "net";

// WHY THIS EXISTS
// The router on this machine (192.168.18.1, DHCP-assigned DNS) intermittently
// SERVFAILs or stalls outbound hostname lookups — getaddrinfo EAI_AGAIN /
// ENOTFOUND seconds after a successful flush, working again minutes later.
// Retrying the SAME resolver just fails again. This module resolves A-records
// directly against public resolvers (bypassing the router's resolver
// entirely), caches results for 60 seconds, and falls back to the system
// resolver only when every public path is unreachable — so it is never
// more fragile than the previous behavior.

dns.setDefaultResultOrder("ipv4first");

const publicDns = new dns.Resolver({ timeout: 2500, tries: 1 });
publicDns.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);

const ipCache = new Map<string, { ips: string[]; at: number }>();
const IP_TTL_MS = 60_000;

/**
 * DNS-over-HTTPS (Google JSON API) against a BARE IP — reaching 8.8.8.8
 * requires no DNS at all, so this works even when every UDP resolver AND the
 * system resolver are unusable. Verified live 2026-09-03: node TLS to 8.8.8.8
 * answers even while 1.1.1.1 and integrate.api.nvidia.com stall. (Google's
 * JSON endpoint is /resolve — its /dns-query returns an HTML error page;
 * 9.9.9.9 requires HTTP/2, which node's https module doesn't speak.)
 */
function dohJson(ip: string, host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        path: `/resolve?name=${encodeURIComponent(host)}&type=A`,
        method: "GET",
        headers: { accept: "application/dns-json" },
        timeout: 8000,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString("utf8")));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            const ips: string[] = (j.Answer ?? [])
              .filter((a: any) => a.type === 1 && typeof a.data === "string")
              .map((a: any) => a.data);
            resolve(ips);
          } catch (err) {
            reject(err as Error);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("DoH timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function resolveViaPublicDns(host: string): Promise<string[]> {
  const hit = ipCache.get(host);
  if (hit && Date.now() - hit.at < IP_TTL_MS) return hit.ips;

  // 1) DNS-over-HTTPS against bare IPs FIRST. Reaching 8.8.8.8 requires no
  // DNS at all, so this cannot be hijacked or swallowed by the router.
  // (UDP-first was removed after live evidence: the router returned bogus
  // A-records for integrate.api.nvidia.com, and pinning curl to that dead IP
  // made every TLS attempt stall. DoH resolved the correct pair in ~350ms.)
  for (const ip of ["8.8.8.8", "8.8.4.4"]) {
    try {
      const ips = await dohJson(ip, host);
      if (ips.length) {
        ipCache.set(host, { ips, at: Date.now() });
        console.log(`[long2short] DoH ${host} -> ${ips.join(", ")}`);
        return ips;
      }
    } catch {
      /* try the next DoH server */
    }
  }

  // 2) Plain UDP against public resolvers — fallback only, since its answers
  // are not trustworthy on this network.
  try {
    // dns.Resolver has no promise overload in this @types/node version —
    // wrap the callback form manually.
    const ips = await new Promise<string[]>((resolve, reject) => {
      publicDns.resolve4(host, (err, addresses) =>
        err ? reject(err) : resolve(addresses ?? [])
      );
    });
    if (ips.length) {
      ipCache.set(host, { ips, at: Date.now() });
      console.log(`[long2short] UDP ${host} -> ${ips.join(", ")}`);
      return ips;
    }
  } catch {
    /* fall through */
  }

  // 3) Every public path failed — caller falls back to the system resolver.
  return [];
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number
) => void;

// Remembers the TRUE original dns.lookup even if this module is re-evaluated
// by dev-mode HMR and patchDnsLookup() runs again — prevents wrapper-around-
// wrapper recursion (the fallback must always reach the real system call).
const DNS_ORIG = Symbol.for("long2short.originalDnsLookup");

function origLookup(
  hostname: string,
  opts: any,
  cb: LookupCb
): unknown {
  const d = dns as any;
  return (d[DNS_ORIG] ?? d.lookup).call(d, hostname, opts, cb);
}

/**
 * Drop-in `lookup` for node:http/https request options, and the function
 * patchDnsLookup() installs process-wide. Signature-compatible with
 * dns.lookup: accepts (hostname, cb) and (hostname, options, cb), honors
 * { all: true } and { family }, and NEVER throws synchronously.
 */
export function resilientLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | LookupCb,
  maybeCb?: LookupCb
): void {
  let opts: any;
  let cb: LookupCb | undefined;
  if (typeof options === "function") {
    cb = options as LookupCb;
    opts = {};
  } else {
    opts = options ?? {};
    cb = maybeCb;
  }
  if (typeof cb !== "function") return;

  const family = Number(opts.family ?? 0);

  // IP literals resolve trivially, and we only do A-records here — anything
  // else (explicit IPv6, literals) goes straight to the system resolver.
  if (net.isIP(hostname) !== 0 || family === 6) {
    origLookup(hostname, opts, cb);
    return;
  }

  resolveViaPublicDns(hostname)
    .then((ips) => {
      if (ips.length) {
        if (opts.all) {
          cb(null, ips.map((a) => ({ address: a, family: 4 as const })));
        } else {
          cb(null, ips[Math.floor(Math.random() * ips.length)], 4);
        }
        return;
      }
      origLookup(hostname, opts, cb);
    })
    .catch(() => origLookup(hostname, opts, cb));
}

/**
 * Installs resilientLookup as the process-wide dns.lookup. Node's net/http/
 * https (and undici's fetch) read dns.lookup per connection, so EVERY
 * outbound connection in the server picks this up — NVIDIA, Apify, Buffer,
 * YouTube CDNs, everything. Public-DNS-first, system resolver as fallback.
 */
export function patchDnsLookup(): void {
  const d = dns as any;
  if (!d[DNS_ORIG]) d[DNS_ORIG] = d.lookup;
  d.lookup = (hostname: string, options: any, callback?: any) => {
    if (typeof options === "function") {
      return resilientLookup(hostname, {} as any, options);
    }
    return resilientLookup(hostname, options, callback);
  };
}