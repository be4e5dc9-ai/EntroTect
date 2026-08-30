import { describe, expect, it } from "vitest";
import { isPrivateIp, assertSafeUrl } from "../src/tools/ssrf.js";

describe("isPrivateIp", () => {
  const privates = [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ];
  const publics = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "11.0.0.1",
    "169.255.0.1",
    "2606:4700:4700::1111",
  ];
  for (const ip of privates) {
    it(`拦截私网 ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }
  for (const ip of publics) {
    it(`放行公网 ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe("assertSafeUrl", () => {
  it("公网字面量 IP 通过(不依赖 DNS)", async () => {
    await expect(assertSafeUrl(new URL("https://8.8.8.8/"))).resolves.toBeTruthy();
  });

  it("公网域名通过", async () => {
    await expect(assertSafeUrl(new URL("https://example.com/"))).resolves.toBeTruthy();
  });

  it("localhost 抛错", async () => {
    await expect(assertSafeUrl(new URL("http://localhost/"))).rejects.toThrow("已拦截");
  });

  it("127.0.0.1 抛错", async () => {
    await expect(assertSafeUrl(new URL("http://127.0.0.1/"))).rejects.toThrow("已拦截");
  });

  it("云元数据 169.254.169.254 抛错", async () => {
    await expect(assertSafeUrl(new URL("http://169.254.169.254/"))).rejects.toThrow("已拦截");
  });

  it("内网 10.0.0.1 抛错", async () => {
    await expect(assertSafeUrl(new URL("http://10.0.0.1/"))).rejects.toThrow("已拦截");
  });

  it("非 http/https 协议抛错", async () => {
    await expect(assertSafeUrl(new URL("ftp://example.com/"))).rejects.toThrow("http/https");
  });
});
