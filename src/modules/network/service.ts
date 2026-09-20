import { timingSafeEqual } from "node:crypto";
import ipaddr from "ipaddr.js";
import { DomainError } from "@/lib/errors";

export function normalizeIp(value: string): string | null {
  try {
    // Reject lists, ports, zone identifiers and surrounding junk.
    if (value !== value.trim() || /[%\[\],]/.test(value)) return null;
    return ipaddr.process(value).toString();
  } catch {
    return null;
  }
}

export function matchesNetwork(ip: string, network: string): boolean {
  try {
    const address = ipaddr.process(ip);
    if (!network.includes("/"))
      return address.toString() === ipaddr.process(network).toString();
    const [range, bits] = ipaddr.parseCIDR(network);
    if (address.kind() !== range.kind()) return false;
    return address.match(range, bits);
  } catch {
    return false;
  }
}

export function isValidNetwork(network: string): boolean {
  try {
    if (network.includes("/")) ipaddr.parseCIDR(network);
    else if (!normalizeIp(network)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface ProxyConfiguration {
  TRUSTED_PROXY_MODE: string;
  TRUSTED_PROXY_SECRET?: string;
}
export function extractClientIp(
  headers: Headers,
  config: ProxyConfiguration,
): string | null {
  // Fetch Request does not expose the TCP peer. An authenticated, isolated ingress
  // must overwrite both headers; X-Forwarded-For is intentionally ignored.
  if (config.TRUSTED_PROXY_MODE !== "nginx" || !config.TRUSTED_PROXY_SECRET)
    return null;
  const supplied = headers.get("x-attendance-proxy-secret") ?? "";
  const expectedBytes = Buffer.from(config.TRUSTED_PROXY_SECRET);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  )
    return null;
  return normalizeIp(headers.get("x-real-ip") ?? "");
}

export function verifyOfficeNetwork(
  ip: string | null,
  networks: { publicIpOrCidr: string; active: boolean }[],
): void {
  if (
    !ip ||
    !networks.some(
      (network) => network.active && matchesNetwork(ip, network.publicIpOrCidr),
    )
  ) {
    throw new DomainError(
      "WRONG_NETWORK",
      "Connect to an approved office network and try again.",
    );
  }
}
