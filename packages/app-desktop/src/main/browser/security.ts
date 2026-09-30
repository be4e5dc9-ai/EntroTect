import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001:db8::", 32], ["2001::", 32], ["2002::", 16],
] as const) blocked.addSubnet(address, prefix, "ipv6");

/** Conservatively accept globally-routable addresses, never loopback/LAN/metadata. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6 || address.includes("%")) return false;
  // Excludes mapped IPv4, NAT64, link-local, unique-local and multicast IPv6.
  if (!/^[23][0-9a-f]{0,3}:/i.test(address)) return false;
  return !blocked.check(address, "ipv6");
}

export function normalizeBrowserUrl(input: string): URL {
  const trimmed = input.trim();
  const value = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("内置浏览器只允许 HTTP/HTTPS 网页，不允许本地文件、脚本或外部应用协议。");
  if (url.username || url.password) throw new Error("网址不能包含用户名或密码，请在网页中手动登录。");
  return url;
}

export type HostResolver = (hostname: string) => Promise<Array<{ address: string }>>;
const resolveHost: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Trusted application UI may offer an origin-scoped exception for this failure only. */
export class BrowserPrivateAddressError extends Error {
  readonly code = "PRIVATE_DESTINATION";
  constructor(readonly origin: string) {
    super("已阻止访问本机、内网或保留地址。若这是你的开发服务器，请先在浏览器界面单独授权该来源。");
    this.name = "BrowserPrivateAddressError";
  }
}

export async function assertBrowserDestination(
  input: string,
  privateOrigins: ReadonlySet<string> = new Set(),
  resolve: HostResolver = resolveHost,
): Promise<URL> {
  const url = normalizeBrowserUrl(input);
  if (privateOrigins.has(url.origin)) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localName = !hostname.includes(".") || hostname === "localhost" || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(hostname);
  if (isIP(hostname)) {
    if (isPublicAddress(hostname)) return url;
  } else if (!localName) {
    const addresses = await resolve(hostname);
    if (addresses.length > 0 && addresses.every((item) => isPublicAddress(item.address))) return url;
  }
  throw new BrowserPrivateAddressError(url.origin);
}

export function isAllowedEmbeddedScheme(raw: string): boolean {
  // Data/blob are permitted only as subresources, never top-level navigation.
  return raw.startsWith("data:") || raw.startsWith("blob:") || raw === "about:blank";
}
