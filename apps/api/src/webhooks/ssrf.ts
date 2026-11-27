/**
 * Webhook URLs are chosen by merchants, so without care they're a way to make our servers call
 * our own network: the cloud metadata service (169.254.169.254), Redis on localhost, the
 * database on 10.x. Every webhook request therefore goes only to public addresses:
 *
 * 1. When an endpoint is saved, its URL is checked (scheme, no credentials, the host resolves
 *    only to public addresses), so a merchant gets a clear error at once.
 * 2. At delivery, the check is made again, inside the connection itself: the HTTP agent's DNS
 *    lookup refuses private answers, and connects to exactly the address it checked. A hostname
 *    that resolved to a public address when saved and to 127.0.0.1 later (DNS rebinding) is
 *    caught there; there's no gap between checking and connecting.
 * 3. Redirects aren't followed (a 3xx is a failed delivery), so a public URL can't bounce the
 *    request to a private one.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent } from "undici";

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

/** Same shape as dns.lookup with { all: true }; tests pass a fake. */
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

export const systemLookup: Lookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: "verbatim" }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64: maps onto IPv4, could reach private ones
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped (::ffff:10.0.0.1) is the IPv4 address in disguise
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

/** The checks that don't need DNS. Returns the parsed URL. */
export function checkUrlShape(raw: string, { production }: { production: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !production)) {
    throw new UnsafeUrlError(production ? "Must be an https:// URL" : "Must be http(s)://");
  }
  if (url.username || url.password)
    throw new UnsafeUrlError("Credentials in the URL aren't allowed");
  if (url.hash) throw new UnsafeUrlError("Fragments (#...) aren't allowed");
  return url;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1"); // [::1] → ::1
}

/** Resolves the host and refuses it unless every address is public. */
export async function publicAddresses(hostname: string, lookup: Lookup): Promise<LookupAddress[]> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new UnsafeUrlError("Points at a private address");
    return [{ address: hostname, family: isIP(hostname) }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new UnsafeUrlError(`Can't resolve ${hostname}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Can't resolve ${hostname}`);
  // All of them: a client may connect to any, and an attacker controls which
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    throw new UnsafeUrlError(`${hostname} resolves to a private address`);
  }
  return addresses;
}

/** For saving an endpoint: the whole check, with a clear error. */
export async function checkWebhookUrl(
  raw: string,
  options: { production: boolean; allowPrivate: boolean; lookup: Lookup },
): Promise<URL> {
  const url = checkUrlShape(raw, options);
  if (!options.allowPrivate) await publicAddresses(hostOf(url), options.lookup);
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * The HTTP agent webhook requests go through. Its DNS lookup is the guard: it only ever
 * returns addresses it has checked, and the socket connects to those.
 */
export function createWebhookAgent(options: {
  allowPrivate: boolean;
  lookup: Lookup;
  timeoutMs: number;
}): Agent {
  return new Agent({
    connect: {
      timeout: options.timeoutMs,
      lookup: (hostname: string, lookupOptions: { all?: boolean }, callback: LookupCallback) => {
        const resolved = options.allowPrivate
          ? options.lookup(hostname)
          : publicAddresses(hostname, options.lookup);
        resolved.then(
          (addresses) => {
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, addresses[0]?.address ?? "", addresses[0]?.family);
          },
          (err: unknown) => {
            const error = (
              err instanceof Error ? err : new Error(String(err))
            ) as NodeJS.ErrnoException;
            error.code ??= "EUNSAFEADDRESS";
            callback(error, "");
          },
        );
      },
    },
    // No keep-alive pooling across merchants' servers worth having; keep sockets short
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 5000,
  });
}

/** IP-literal URLs never go through DNS, so they're checked before connecting. */
export function checkLiteralHost(url: URL, allowPrivate: boolean): void {
  const host = hostOf(url);
  if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
    throw new UnsafeUrlError("Points at a private address");
  }
}
