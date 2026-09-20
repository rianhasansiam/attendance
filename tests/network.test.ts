import { describe, expect, it } from "vitest";
import {
  extractClientIp,
  isValidNetwork,
  matchesNetwork,
  normalizeIp,
  verifyOfficeNetwork,
} from "../src/modules/network/service";

describe("office networks", () => {
  it("matches IPv4, IPv6 and mapped IPv4", () => {
    expect(matchesNetwork("203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(matchesNetwork("::ffff:203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(matchesNetwork("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(matchesNetwork("203.0.114.7", "203.0.113.0/24")).toBe(false);
    expect(matchesNetwork("203.0.113.7", "2001:db8::/32")).toBe(false);
  });
  it("accepts active approved networks only", () => {
    expect(() =>
      verifyOfficeNetwork("203.0.113.7", [
        { publicIpOrCidr: "203.0.113.0/24", active: true },
      ]),
    ).not.toThrow();
    expect(() =>
      verifyOfficeNetwork("203.0.113.7", [
        { publicIpOrCidr: "203.0.113.0/24", active: false },
      ]),
    ).toThrow("network");
    expect(() => verifyOfficeNetwork(null, [])).toThrow("network");
  });
  it("rejects malformed networks and IP header lists", () => {
    expect(isValidNetwork("203.0.113.0/33")).toBe(false);
    expect(normalizeIp("203.0.113.1, 203.0.113.2")).toBeNull();
    expect(normalizeIp("fe80::1%eth0")).toBeNull();
  });
  it("never trusts arbitrary forwarded headers", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
    });
    expect(extractClientIp(headers, { TRUSTED_PROXY_MODE: "none" })).toBeNull();
    expect(
      extractClientIp(headers, {
        TRUSTED_PROXY_MODE: "nginx",
        TRUSTED_PROXY_SECRET: "server-secret",
      }),
    ).toBeNull();
  });
  it("accepts only the authenticated ingress's overwritten real-ip", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.1.1.1",
      "x-real-ip": "203.0.113.7",
      "x-attendance-proxy-secret": "server-secret",
    });
    expect(
      extractClientIp(headers, {
        TRUSTED_PROXY_MODE: "nginx",
        TRUSTED_PROXY_SECRET: "server-secret",
      }),
    ).toBe("203.0.113.7");
    expect(
      extractClientIp(headers, {
        TRUSTED_PROXY_MODE: "nginx",
        TRUSTED_PROXY_SECRET: "wrong",
      }),
    ).toBeNull();
  });
});
