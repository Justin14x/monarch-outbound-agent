import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface HttpResource {
  body: Uint8Array;
  contentType: string | null;
  finalUrl: string;
}

export interface LogoHttpClient {
  getBinary(url: string): Promise<HttpResource>;
  getHtml(url: string): Promise<HttpResource>;
}

export interface SafeHttpClientOptions {
  assetMaxBytes?: number;
  fetchImplementation?: typeof fetch;
  htmlMaxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

export class LogoHttpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogoHttpError";
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function assertSafePublicUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LogoHttpError(`Invalid URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LogoHttpError(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new LogoHttpError("URLs containing credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new LogoHttpError("Private network hosts are not allowed");
  }

  if (isIP(hostname)) {
    if (isPrivateNetworkAddress(hostname)) {
      throw new LogoHttpError("Private network addresses are not allowed");
    }
    return url;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "DNS lookup failed";
    throw new LogoHttpError(`Could not resolve ${hostname}: ${reason}`);
  }

  if (addresses.length === 0) {
    throw new LogoHttpError(`Could not resolve ${hostname}`);
  }
  if (addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new LogoHttpError("Resolved address is on a private network");
  }

  return url;
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new LogoHttpError(`Response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) throw new LogoHttpError("Response had no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new LogoHttpError(`Response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createSafeHttpClient(
  options: SafeHttpClientOptions = {},
): LogoHttpClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const htmlMaxBytes = options.htmlMaxBytes ?? 3 * 1024 * 1024;
  const assetMaxBytes = options.assetMaxBytes ?? 15 * 1024 * 1024;

  async function request(
    input: string,
    accept: string,
    maximumBytes: number,
  ): Promise<HttpResource> {
    let currentUrl = input;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const safeUrl = await assertSafePublicUrl(currentUrl);
      let response: Response;
      try {
        response = await fetchImplementation(safeUrl, {
          headers: {
            accept,
            "user-agent":
              "MonarchOutboundAgent-LogoFinder/1.0 (+https://monarchsystems.io)",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "network error";
        throw new LogoHttpError(`Could not fetch ${safeUrl.toString()}: ${reason}`);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new LogoHttpError("Redirect response had no location");
        if (redirectCount === maxRedirects) {
          throw new LogoHttpError("Too many redirects");
        }
        currentUrl = new URL(location, safeUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new LogoHttpError(
          `Request failed with HTTP ${response.status} for ${safeUrl.toString()}`,
        );
      }

      return {
        body: await readLimitedBody(response, maximumBytes),
        contentType: response.headers.get("content-type"),
        finalUrl: response.url || safeUrl.toString(),
      };
    }

    throw new LogoHttpError("Too many redirects");
  }

  return {
    getBinary(url) {
      return request(
        url,
        "image/svg+xml,image/png,image/webp,image/jpeg,image/gif;q=0.8,*/*;q=0.1",
        assetMaxBytes,
      );
    },
    getHtml(url) {
      return request(
        url,
        "text/html,application/xhtml+xml;q=0.9",
        htmlMaxBytes,
      );
    },
  };
}
