import dns from "node:dns/promises"
import dnsCallback from "node:dns"
import os from "node:os"
import { Agent } from "undici"

/** Maximum redirect chain length to prevent infinite loops */
const MAX_REDIRECTS = 10

/**
 * Undici Agent that validates all DNS resolutions against SSRF rules at lookup time.
 * This eliminates DNS rebinding attacks because the validated IP is the same one
 * used for the TCP connection — there is no second DNS resolution.
 */
const ssrfSafeDispatcher = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsCallback.lookup(hostname, { ...options, all: true }, (err, results) => {
        if (err) {
          return callback(err, "", 4)
        }
        const localIps = getLocalIps()
        for (const entry of results) {
          if (isPrivateOrReservedIp(entry.address)) {
            return callback(
              new Error(`Blocked request: ${hostname} resolves to private/reserved IP ${entry.address}`) as NodeJS.ErrnoException,
              "", 4
            )
          }
          if (localIps.has(entry.address)) {
            return callback(
              new Error(`Blocked request: ${hostname} resolves to local machine IP ${entry.address}`) as NodeJS.ErrnoException,
              "", 4
            )
          }
        }
        if (results.length === 0) {
          return callback(new Error(`DNS lookup returned no addresses for ${hostname}`) as NodeJS.ErrnoException, "", 4)
        }
        if (options.all) {
          return callback(null, results)
        }
        callback(null, results[0].address, results[0].family)
      })
    }
  }
})

/**
 * Performs a fetch that prevents SSRF and infinite redirects.
 * Uses a custom undici dispatcher so DNS validation and connection use the same
 * resolved IP (no TOCTOU / DNS rebinding gap). Handles redirects manually to
 * validate each URL in the redirect chain.
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @param redirectCount - Current redirect depth (internal, for recursion tracking)
 * @returns Standard Response object
 * @throws Error if redirect limit exceeded or SSRF validation fails
 */
export async function safeFetch(
  url: string,
  options?: RequestInit,
  redirectCount: number = 0
): Promise<Response> {
  if (redirectCount >= MAX_REDIRECTS) {
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
  }

  // Fast-fail on obviously bad URLs (protocol, IP literals, localhost) before fetch
  validateUrlPreFetch(url)

  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    dispatcher: ssrfSafeDispatcher
  } as any)

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (location) {
      const redirectUrl = new URL(location, url).toString()
      return safeFetch(redirectUrl, options, redirectCount + 1)
    }
  }

  return response
}


// ============================================================================
// SSRF Protection
// ============================================================================

/** Cache of local IP addresses, refreshed periodically */
let localIpsCache: Set<string> | null = null
let localIpsCacheTime = 0
const LOCAL_IPS_CACHE_TTL = 60000 // 1 minute

/**
 * Gets all IP addresses assigned to the local machine's network interfaces.
 * Results are cached for 1 minute to avoid repeated system calls.
 */
function getLocalIps(): Set<string> {
  const now = Date.now()
  if (localIpsCache && now - localIpsCacheTime < LOCAL_IPS_CACHE_TTL) {
    return localIpsCache
  }

  const ips = new Set<string>()
  const interfaces = os.networkInterfaces()

  for (const name in interfaces) {
    const netInterface = interfaces[name]
    if (netInterface) {
      for (const info of netInterface) {
        ips.add(info.address)
        // Also store IPv4-mapped IPv6 form so we match DNS responses in either format
        if (info.family === "IPv4") {
          ips.add(`::ffff:${info.address}`)
        }
      }
    }
  }

  localIpsCache = ips
  localIpsCacheTime = now
  return ips
}

/**
 * Checks if an IP address is in a private/reserved range that should be blocked.
 * @param ip - The IP address to check (IPv4 or IPv6)
 * @returns true if the IP should be blocked
 */
function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x or ::ffff:XXXX:XXXX)
  // These map directly to IPv4 addresses and must be checked against IPv4 rules.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mappedMatch) {
    return isPrivateOrReservedIp(mappedMatch[1])
  }
  // Hex form: ::ffff:7f00:1 -> 127.0.0.1
  const mappedHexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (mappedHexMatch) {
    const high = parseInt(mappedHexMatch[1], 16)
    const low = parseInt(mappedHexMatch[2], 16)
    const reconstructed = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
    return isPrivateOrReservedIp(reconstructed)
  }

  // IPv4 checks
  if (ip === "localhost") {
    return true
  }

  // 127.0.0.0/8 - Loopback
  if (ip.startsWith("127.")) {
    return true
  }

  // 0.0.0.0/8 - "This" network (routes locally on Linux)
  if (ip.startsWith("0.")) {
    return true
  }

  // 10.0.0.0/8 - Private
  if (ip.startsWith("10.")) {
    return true
  }

  // 192.168.0.0/16 - Private
  if (ip.startsWith("192.168.")) {
    return true
  }

  // 172.16.0.0/12 - Private (172.16.x.x - 172.31.x.x)
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) {
    return true
  }

  // 169.254.0.0/16 - Link-local and cloud metadata (169.254.169.254)
  if (ip.startsWith("169.254.")) {
    return true
  }

  // 100.64.0.0/10 - Carrier-grade NAT
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(ip)) {
    return true
  }

  // IPv6 checks
  // ::1 - Localhost
  if (ip === "::1") {
    return true
  }

  // fc00::/7 - Unique local address (fc00:: - fdff::)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(ip)) {
    return true
  }

  // fe80::/10 - Link-local
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) {
    return true
  }

  // :: - Unspecified address
  if (ip === "::") {
    return true
  }

  return false
}

/** Strips brackets from IPv6 hostnames returned by the WHATWG URL parser (e.g. `[::1]` → `::1`). */
function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1)
  }
  return hostname
}

/**
 * Lightweight pre-fetch validation: checks protocol, hostname literals, and
 * obvious private IPs. Does NOT resolve DNS — DNS-level SSRF blocking is
 * handled by the custom undici dispatcher in {@link safeFetch}.
 * @param url - The URL to validate
 * @throws Error if the URL has a bad protocol or targets an obviously private address
 */
function validateUrlPreFetch(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed.`)
  }

  const hostname = stripIpv6Brackets(parsed.hostname)

  if (hostname === "localhost" || isPrivateOrReservedIp(hostname)) {
    throw new Error(`Blocked request to private/reserved address: ${hostname}`)
  }
}

/**
 * Validates a URL for SSRF protection.
 * Resolves DNS and checks that the target IP is not private/reserved or local.
 * @param url - The URL to validate
 * @throws Error if the URL targets a blocked IP address
 */
export async function validateUrlForSsrf(url: string): Promise<void> {
  validateUrlPreFetch(url)

  const parsed = new URL(url)
  const hostname = stripIpv6Brackets(parsed.hostname)

  let addresses: string[]
  try {
    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname)
    ])

    addresses = []
    if (ipv4Results.status === "fulfilled") {
      addresses.push(...ipv4Results.value)
    }
    if (ipv6Results.status === "fulfilled") {
      addresses.push(...ipv6Results.value)
    }

    if (addresses.length === 0) {
      const lookupResult = await dns.lookup(hostname, { all: true })
      addresses = lookupResult.map(r => r.address)
    }
  } catch (err) {
    addresses = [hostname]
  }

  const localIps = getLocalIps()

  for (const ip of addresses) {
    if (isPrivateOrReservedIp(ip)) {
      throw new Error(`Blocked request: ${hostname} resolves to private/reserved IP ${ip}`)
    }

    if (localIps.has(ip)) {
      throw new Error(`Blocked request: ${hostname} resolves to local machine IP ${ip}`)
    }
  }
}
