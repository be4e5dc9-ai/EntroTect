// =====================================================================
// SSRF 防护:webfetch 的私网/回环/链路本地/云元数据 IP 拦截
// 设计依据:审查 P0-2——webfetch 免审批,必须封死对私网与云元数据
// (169.254.169.254) 的访问,否则模型可经零审批通道读本机内网。
// 纯函数实现,不引额外依赖。
// 已知限制:DNS 解析与连接之间存在 TOCTOU(DNS rebinding);彻底修复
// 需把连接钉死在已校验 IP 上(undici 自定义 dispatcher),列为后续。
// =====================================================================

import net from "node:net";
import { lookup } from "node:dns/promises";

/** IPv4 字符串 → 32 位无符号整数;非法返回 null */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** 网段数值比较:ip 是否落在 base/prefix 网段内 */
function inCidr(ip: string, base: string, prefix: number): boolean {
  const a = ipv4ToNumber(ip);
  const b = ipv4ToNumber(base);
  if (a === null || b === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** 私网/回环/链路本地/云元数据/保留地址(IPv4 数值比较) */
function isPrivateIpv4(ip: string): boolean {
  return (
    inCidr(ip, "0.0.0.0", 8) ||
    inCidr(ip, "10.0.0.0", 8) ||
    inCidr(ip, "100.64.0.0", 10) ||
    inCidr(ip, "127.0.0.0", 8) ||
    inCidr(ip, "169.254.0.0", 16) ||
    inCidr(ip, "172.16.0.0", 12) ||
    inCidr(ip, "192.168.0.0", 16)
  );
}

/** 私网/回环/链路本地/未指定(::1 / fc00::/7 / fe80::/10 / ::) */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // fc00::/7 唯一本地地址(前缀 fc|fd)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 链路本地(前缀 fe8|fe9|fea|feb)
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

/** 私网/回环/链路本地/云元数据 IP 判断(含 IPv4-mapped IPv6 回退) */
export function isPrivateIp(ip: string): boolean {
  let candidate = ip.trim();
  // ::ffff:a.b.c.d 映射回 IPv4 再判
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(candidate);
  if (mapped) candidate = mapped[1]!;
  const kind = net.isIP(candidate);
  if (kind === 4) return isPrivateIpv4(candidate);
  if (kind === 6) return isPrivateIpv6(candidate);
  return false;
}

/**
 * 校验 URL 是否可安全抓取:协议必须 http/https;host 为字面量 IP 时直接判,
 * 否则 dns.lookup 解析,任一 IP 命中私网即抛错。解析失败也抛错。
 */
export async function assertSafeUrl(url: URL): Promise<URL> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("目标地址不可访问(仅支持 http/https)");
  }
  const hostname = url.hostname;
  // 去掉 IPv6 字面量的方括号
  const bareHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (net.isIP(bareHost) !== 0) {
    if (isPrivateIp(bareHost)) throw new Error("目标地址不可访问(已拦截)");
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bareHost, { all: true });
  } catch {
    throw new Error("目标地址不可访问(域名无法解析)");
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error("目标地址不可访问(已拦截)");
  }
  return url;
}
