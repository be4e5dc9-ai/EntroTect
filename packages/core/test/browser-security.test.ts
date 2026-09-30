import { describe, expect, it, vi } from "vitest";
import {
  assertBrowserDestination, BrowserPrivateAddressError, isAllowedEmbeddedScheme,
  isPublicAddress, normalizeBrowserUrl,
} from "../../app-desktop/src/main/browser/security.js";

describe("browser destination isolation", () => {
  it("accepts HTTP(S), normalizes hostnames and rejects file, script and credential URLs", () => {
    expect(normalizeBrowserUrl(" example.com/a ").href).toBe("https://example.com/a");
    for (const value of ["file:///C:/private.txt", "javascript:alert(1)", "data:text/html,test", "ftp://example.com", "https://user:secret@example.com"]) {
      expect(() => normalizeBrowserUrl(value)).toThrow();
    }
  });

  it("recognizes public addresses and rejects LAN, loopback, metadata and encoded IPv6 routes", () => {
    for (const value of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicAddress(value), value).toBe(true);
    for (const value of ["0.0.0.0", "10.3.2.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.0.1", "192.168.0.1", "192.0.2.1", "198.18.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "64:ff9b::808:808", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "2002:7f00:1::", "bad address"]) {
      expect(isPublicAddress(value), value).toBe(false);
    }
  });

  it("checks every resolved address so public DNS cannot hide a private route", async () => {
    const resolve = vi.fn(async () => [{ address: "1.1.1.1" }, { address: "10.0.0.1" }]);
    await expect(assertBrowserDestination("https://mixed.example", new Set(), resolve)).rejects.toBeInstanceOf(BrowserPrivateAddressError);
    expect(resolve).toHaveBeenCalledWith("mixed.example");
    await expect(assertBrowserDestination("https://public.example", new Set(), async () => [{ address: "8.8.8.8" }])).resolves.toMatchObject({ hostname: "public.example" });
    await expect(assertBrowserDestination("https://empty.example", new Set(), async () => [])).rejects.toBeInstanceOf(BrowserPrivateAddressError);
  });

  it("does not resolve local names and canonicalizes alternate numeric localhost spellings", async () => {
    const resolve = vi.fn(async () => [{ address: "8.8.8.8" }]);
    for (const value of ["http://localhost:3000", "http://printer", "http://app.local", "http://service.internal", "http://127.1", "http://2130706433", "http://0x7f000001", "http://[::1]"]) {
      await expect(assertBrowserDestination(value, new Set(), resolve), value).rejects.toBeInstanceOf(BrowserPrivateAddressError);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("explicit private grants apply only to the exact origin including scheme and port", async () => {
    const grants = new Set(["http://localhost:3000"]);
    await expect(assertBrowserDestination("http://localhost:3000/course", grants)).resolves.toMatchObject({ pathname: "/course" });
    await expect(assertBrowserDestination("http://localhost:3001", grants)).rejects.toMatchObject({ code: "PRIVATE_DESTINATION", origin: "http://localhost:3001" });
    await expect(assertBrowserDestination("https://localhost:3000", grants)).rejects.toBeInstanceOf(BrowserPrivateAddressError);
    await expect(assertBrowserDestination("http://user:secret@localhost:3000", grants)).rejects.not.toBeInstanceOf(BrowserPrivateAddressError);
  });

  it("DNS failures are not mislabeled as user-authorizable private destination exceptions", async () => {
    const failure = new Error("ENOTFOUND");
    await expect(assertBrowserDestination("https://missing.example", new Set(), async () => { throw failure; })).rejects.toBe(failure);
  });

  it("allows data/blob only through the explicit embedded-resource predicate", () => {
    for (const value of ["data:image/png;base64,AA", "blob:https://example.com/id", "about:blank"]) expect(isAllowedEmbeddedScheme(value)).toBe(true);
    for (const value of ["javascript:alert(1)", "file:///C:/secret", "about:config", "https://example.com"]) expect(isAllowedEmbeddedScheme(value)).toBe(false);
  });
});
