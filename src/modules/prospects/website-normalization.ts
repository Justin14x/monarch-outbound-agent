export interface NormalizedWebsite {
  normalizedDomain: string;
  website: string;
}

export class InvalidWebsiteError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidWebsiteError";
  }
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function isValidHostname(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes(".")) return false;

  return hostname.split(".").every((label) => {
    return label.length > 0 && label.length <= 63 && DOMAIN_LABEL.test(label);
  });
}

export function normalizeWebsite(value: string): NormalizedWebsite {
  const input = value.trim();
  if (!input) throw new InvalidWebsiteError("website is required");

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new InvalidWebsiteError("website is not a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidWebsiteError("website must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new InvalidWebsiteError("website must not include credentials");
  }

  let normalizedDomain = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (normalizedDomain.startsWith("www.")) {
    normalizedDomain = normalizedDomain.slice(4);
  }

  if (!isValidHostname(normalizedDomain)) {
    throw new InvalidWebsiteError("website must contain a valid public domain");
  }

  return {
    normalizedDomain,
    website: parsed.toString(),
  };
}
