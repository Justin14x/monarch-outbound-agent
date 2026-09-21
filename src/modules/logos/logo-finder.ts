import { load } from "cheerio";
import sharp from "sharp";

import {
  createSafeHttpClient,
  LogoHttpError,
  type LogoHttpClient,
} from "./safe-http.js";

const THIRD_PARTY_TERMS = [
  "apple-pay",
  "bbb",
  "facebook",
  "google-pay",
  "instagram",
  "mastercard",
  "mindbody",
  "opentable",
  "paypal",
  "pinterest",
  "shopify-pay",
  "tiktok",
  "tripadvisor",
  "twitter",
  "visa",
  "yelp",
  "youtube",
] as const;

const PLACEHOLDER_TERMS = [
  "blank",
  "loader",
  "loading",
  "placeholder",
  "spacer",
  "spinner",
  "tracking",
  "transparent.gif",
] as const;

type LogoFormat = "gif" | "jpeg" | "png" | "svg" | "webp";

interface LogoCandidate {
  altText: string;
  businessSignal: boolean;
  context: string;
  favicon: boolean;
  header: boolean;
  homepageLink: boolean;
  logoSignal: boolean;
  metadata: boolean;
  score: number;
  url: string;
}

interface ValidatedCandidate extends LogoCandidate {
  body: Uint8Array;
  contentType: string;
  extension: string;
  finalScore: number;
  format: LogoFormat;
  hasAlpha: boolean | null;
  height: number | null;
  sourceUrl: string;
  width: number | null;
}

export interface DetectedLogo {
  body: Uint8Array;
  confidence: "HIGH" | "MEDIUM";
  contentType: string;
  extension: string;
  hasAlpha: boolean | null;
  height: number | null;
  score: number;
  sourceUrl: string;
  width: number | null;
}

export interface LogoFinder {
  find(input: { businessName: string; website: string }): Promise<DetectedLogo>;
}

export class LogoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoNotFoundError";
  }
}

export class LogoFinderTechnicalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogoFinderTechnicalError";
  }
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function businessTerms(businessName: string): string[] {
  const ignored = new Set(["and", "co", "company", "inc", "llc", "the"]);
  return businessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !ignored.has(term));
}

function containsBusinessSignal(value: string, businessName: string): boolean {
  const compactValue = compact(value);
  const compactBusiness = compact(businessName);
  if (compactBusiness.length >= 4 && compactValue.includes(compactBusiness)) {
    return true;
  }
  const terms = businessTerms(businessName);
  return terms.length > 0 && terms.some((term) => compactValue.includes(term));
}

function hasAnyTerm(value: string, terms: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function resolveAssetUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^(?:data|blob|javascript):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function bestSrcsetUrl(srcset: string): string | null {
  const choices = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url = "", descriptor = ""] = entry.split(/\s+/);
      const numeric = Number.parseFloat(descriptor);
      const weight = descriptor.endsWith("w")
        ? numeric
        : descriptor.endsWith("x")
          ? numeric * 1000
          : 0;
      return { url, weight: Number.isFinite(weight) ? weight : 0 };
    })
    .sort((left, right) => right.weight - left.weight);
  return choices[0]?.url ?? null;
}

function scoreCandidate(
  candidate: Omit<LogoCandidate, "score">,
  businessName: string,
): LogoCandidate {
  const urlPath = new URL(candidate.url).pathname.toLowerCase();
  const combined = `${candidate.altText} ${candidate.context} ${urlPath}`;
  const extension = urlPath.split(".").pop() ?? "";
  const logoSignal = /(?:^|[^a-z])(logo|brand|wordmark)(?:[^a-z]|$)/i.test(combined);
  const businessSignal = containsBusinessSignal(combined, businessName);
  let score = 0;

  if (extension === "svg") score += 30;
  else if (extension === "png") score += 20;
  else if (extension === "webp") score += 14;
  else if (extension === "jpg" || extension === "jpeg") score += 8;
  else if (extension === "gif") score += 2;
  if (candidate.header) score += 35;
  if (candidate.homepageLink) score += 10;
  if (candidate.metadata) score += 30;
  if (logoSignal) score += 28;
  if (businessSignal) score += 25;
  if (candidate.favicon) score -= 35;

  return { ...candidate, businessSignal, logoSignal, score };
}

function extractStructuredLogoUrls(value: unknown, urls: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) extractStructuredLogoUrls(item, urls);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "logo") {
      if (typeof child === "string") urls.push(child);
      else if (typeof child === "object" && child !== null) {
        const possibleUrl =
          "url" in child && typeof child.url === "string"
            ? child.url
            : "contentUrl" in child && typeof child.contentUrl === "string"
              ? child.contentUrl
              : null;
        if (possibleUrl) urls.push(possibleUrl);
      }
    }
    extractStructuredLogoUrls(child, urls);
  }
}

function extractCandidates(
  html: string,
  pageUrl: string,
  businessName: string,
): LogoCandidate[] {
  const $ = load(html);
  const candidates: LogoCandidate[] = [];
  const seen = new Set<string>();

  function addCandidate(
    rawUrl: string | null | undefined,
    details: {
      altText?: string;
      context?: string;
      favicon?: boolean;
      header?: boolean;
      homepageLink?: boolean;
      metadata?: boolean;
    } = {},
  ): void {
    if (!rawUrl) return;
    const url = resolveAssetUrl(rawUrl, pageUrl);
    if (!url || seen.has(url)) return;
    const combined = `${url} ${details.altText ?? ""} ${details.context ?? ""}`;
    if (
      hasAnyTerm(combined, THIRD_PARTY_TERMS) ||
      hasAnyTerm(combined, PLACEHOLDER_TERMS)
    ) {
      return;
    }
    seen.add(url);
    candidates.push(
      scoreCandidate(
        {
          altText: details.altText ?? "",
          businessSignal: false,
          context: details.context ?? "",
          favicon: details.favicon ?? false,
          header: details.header ?? false,
          homepageLink: details.homepageLink ?? false,
          logoSignal: false,
          metadata: details.metadata ?? false,
          url,
        },
        businessName,
      ),
    );
  }

  $("img").each((_, element) => {
    const image = $(element);
    const source =
      bestSrcsetUrl(image.attr("srcset") ?? "") ??
      image.attr("src") ??
      image.attr("data-src") ??
      image.attr("data-lazy-src");
    const context = [
      image.attr("class"),
      image.attr("id"),
      image.parent().attr("class"),
      image.closest("a").attr("class"),
    ]
      .filter(Boolean)
      .join(" ");
    const nearestLink = image.closest("a").attr("href");
    const resolvedLink = nearestLink
      ? resolveAssetUrl(nearestLink, pageUrl)
      : null;
    const homepageLink = resolvedLink
      ? new URL(resolvedLink).hostname === new URL(pageUrl).hostname &&
        ["", "/"].includes(new URL(resolvedLink).pathname)
      : false;
    addCandidate(source, {
      altText: image.attr("alt") ?? image.attr("aria-label") ?? "",
      context,
      header: image.closest("header, nav, [role='navigation']").length > 0,
      homepageLink,
    });
  });

  $("picture source").each((_, element) => {
    const source = $(element);
    const picture = source.closest("picture");
    const image = picture.find("img").first();
    addCandidate(bestSrcsetUrl(source.attr("srcset") ?? ""), {
      altText: image.attr("alt") ?? "",
      context: `${picture.attr("class") ?? ""} ${image.attr("class") ?? ""}`,
      header: picture.closest("header, nav, [role='navigation']").length > 0,
      homepageLink: picture.closest("a[href='/']").length > 0,
    });
  });

  $("object[type='image/svg+xml'], embed[type='image/svg+xml']").each(
    (_, element) => {
      const asset = $(element);
      addCandidate(asset.attr("data") ?? asset.attr("src"), {
        altText: asset.attr("aria-label") ?? asset.attr("title") ?? "",
        context: `${asset.attr("class") ?? ""} ${asset.attr("id") ?? ""}`,
        header: asset.closest("header, nav, [role='navigation']").length > 0,
      });
    },
  );

  $("svg").each((_, element) => {
    const svg = $(element);
    const context = `${svg.attr("class") ?? ""} ${svg.attr("id") ?? ""}`;
    const altText = svg.attr("aria-label") ?? svg.attr("title") ?? "";
    svg.find("image[href], image[xlink\\:href], use[href], use[xlink\\:href]").each(
      (_, referencedElement) => {
        const reference = $(referencedElement);
        const rawUrl =
          reference.attr("href") ?? reference.attr("xlink:href") ?? null;
        if (!rawUrl || rawUrl.startsWith("#")) return;
        addCandidate(rawUrl, {
          altText,
          context: `${context} inline-svg-reference`,
          header: svg.closest("header, nav, [role='navigation']").length > 0,
          homepageLink: svg.closest("a[href='/']").length > 0,
        });
      },
    );
  });

  $("[style*='background']").each((_, element) => {
    const asset = $(element);
    const context = `${asset.attr("class") ?? ""} ${asset.attr("id") ?? ""}`;
    if (!/(?:logo|brand|header|nav)/i.test(context)) return;
    const style = asset.attr("style") ?? "";
    const match = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style);
    addCandidate(match?.[1], {
      context,
      header: asset.closest("header, nav, [role='navigation']").length > 0,
    });
  });

  $("meta[property='og:logo'], meta[itemprop='logo'], link[rel='logo']").each(
    (_, element) => {
      const metadata = $(element);
      addCandidate(metadata.attr("content") ?? metadata.attr("href"), {
        context: "structured logo metadata",
        metadata: true,
      });
    },
  );

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      const urls: string[] = [];
      extractStructuredLogoUrls(JSON.parse(raw) as unknown, urls);
      for (const url of urls) {
        addCandidate(url, {
          context: "structured logo metadata",
          metadata: true,
        });
      }
    } catch {
      // Invalid third-party JSON-LD does not make the page itself unusable.
    }
  });

  $("link[rel~='icon'], link[rel='apple-touch-icon']").each((_, element) => {
    const icon = $(element);
    addCandidate(icon.attr("href"), {
      context: `favicon ${icon.attr("sizes") ?? ""}`,
      favicon: true,
    });
  });

  return candidates.sort((left, right) => right.score - left.score);
}

function detectFormat(body: Uint8Array): LogoFormat | null {
  const prefix = body.subarray(0, 1024);
  const textPrefix = new TextDecoder().decode(prefix).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(textPrefix)) return "svg";
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47
  ) {
    return "png";
  }
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "jpeg";
  if (
    body.length >= 12 &&
    new TextDecoder().decode(body.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(body.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  const gifPrefix = new TextDecoder().decode(body.subarray(0, 6));
  if (gifPrefix === "GIF87a" || gifPrefix === "GIF89a") return "gif";
  return null;
}

function formatDetails(format: LogoFormat): {
  contentType: string;
  extension: string;
  score: number;
} {
  switch (format) {
    case "svg":
      return { contentType: "image/svg+xml", extension: "svg", score: 30 };
    case "png":
      return { contentType: "image/png", extension: "png", score: 20 };
    case "webp":
      return { contentType: "image/webp", extension: "webp", score: 14 };
    case "jpeg":
      return { contentType: "image/jpeg", extension: "jpg", score: 8 };
    case "gif":
      return { contentType: "image/gif", extension: "gif", score: 2 };
  }
}

function svgDimensions(body: Uint8Array): {
  height: number | null;
  width: number | null;
} {
  const text = new TextDecoder().decode(body.subarray(0, 16_384));
  const svgTag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const width = Number.parseFloat(/\bwidth=['"]([^'"]+)/i.exec(svgTag)?.[1] ?? "");
  const height = Number.parseFloat(/\bheight=['"]([^'"]+)/i.exec(svgTag)?.[1] ?? "");
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  const viewBox = /\bviewBox=['"]\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(
    svgTag,
  );
  const viewWidth = Number.parseFloat(viewBox?.[1] ?? "");
  const viewHeight = Number.parseFloat(viewBox?.[2] ?? "");
  return {
    width: Number.isFinite(viewWidth) ? viewWidth : null,
    height: Number.isFinite(viewHeight) ? viewHeight : null,
  };
}

async function validateCandidate(
  candidate: LogoCandidate,
  http: LogoHttpClient,
): Promise<ValidatedCandidate | null> {
  const resource = await http.getBinary(candidate.url);
  if (resource.body.byteLength < 80) return null;
  const format = detectFormat(resource.body);
  if (!format) {
    throw new LogoHttpError(
      `Candidate at ${resource.finalUrl} is not a supported image format`,
    );
  }

  let width: number | null;
  let height: number | null;
  let hasAlpha: boolean | null;
  if (format === "svg") {
    const dimensions = svgDimensions(resource.body);
    width = dimensions.width;
    height = dimensions.height;
    hasAlpha = true;
  } else {
    try {
      const metadata = await sharp(resource.body, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
      }).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
      hasAlpha = metadata.hasAlpha ?? null;
    } catch (error) {
      throw new LogoHttpError(
        `Candidate at ${resource.finalUrl} could not be decoded as an image`,
        { cause: error },
      );
    }
  }

  if (width !== null && height !== null) {
    if (width <= 2 && height <= 2) return null;
    if (Math.max(width, height) < 24) return null;
  }

  const details = formatDetails(format);
  let finalScore = candidate.score + details.score;
  if (hasAlpha) finalScore += 8;
  if (width !== null && height !== null) {
    const area = width * height;
    const aspectRatio = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (area >= 1_000_000) finalScore += 10;
    else if (area >= 100_000) finalScore += 6;
    else if (area >= 10_000) finalScore += 2;
    if (!candidate.favicon && aspectRatio >= 1.5 && aspectRatio <= 12) {
      finalScore += 4;
    } else if (aspectRatio > 25) {
      finalScore -= 8;
    }
  }

  return {
    ...candidate,
    body: resource.body,
    contentType: details.contentType,
    extension: details.extension,
    finalScore,
    format,
    hasAlpha,
    height,
    sourceUrl: resource.finalUrl,
    width,
  };
}

function appearsJavascriptOnly(html: string): boolean {
  const $ = load(html);
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();
  const hasAppRoot = $("#__next, #root, #app, [data-reactroot]").length > 0;
  return visibleText.length < 80 && hasAppRoot && $("script[src]").length > 0;
}

function isConfident(candidate: ValidatedCandidate): boolean {
  const semanticSignal =
    candidate.logoSignal ||
    candidate.metadata ||
    (candidate.header && (candidate.businessSignal || candidate.homepageLink)) ||
    (candidate.businessSignal && candidate.homepageLink);
  return !candidate.favicon && semanticSignal && candidate.finalScore >= 55;
}

export function createLogoFinder(
  http: LogoHttpClient = createSafeHttpClient(),
): LogoFinder {
  return {
    async find({ businessName, website }) {
      let page: Awaited<ReturnType<LogoHttpClient["getHtml"]>>;
      try {
        page = await http.getHtml(website);
      } catch (error) {
        throw new LogoFinderTechnicalError(
          `Website could not be inspected: ${error instanceof Error ? error.message : "unknown network error"}`,
          { cause: error },
        );
      }

      const contentType = page.contentType?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        contentType &&
        contentType !== "text/html" &&
        contentType !== "application/xhtml+xml"
      ) {
        throw new LogoFinderTechnicalError(
          `Website returned unsupported content type ${contentType}`,
        );
      }

      const html = new TextDecoder().decode(page.body);
      const candidates = extractCandidates(html, page.finalUrl, businessName);
      if (candidates.length === 0) {
        if (appearsJavascriptOnly(html)) {
          throw new LogoFinderTechnicalError(
            "Website appears to require JavaScript and exposed no inspectable logo assets",
          );
        }
        throw new LogoNotFoundError(
          "Website was inspected, but no credible logo candidates were found",
        );
      }

      const validated: ValidatedCandidate[] = [];
      let downloadFailures = 0;
      for (const candidate of candidates.slice(0, 15)) {
        try {
          const asset = await validateCandidate(candidate, http);
          if (asset) validated.push(asset);
        } catch (error) {
          const strongCandidate =
            candidate.logoSignal ||
            candidate.businessSignal ||
            candidate.metadata ||
            (candidate.header && candidate.homepageLink);
          if (
            strongCandidate &&
            (error instanceof LogoHttpError || error instanceof Error)
          ) {
            downloadFailures += 1;
          }
        }
      }

      validated.sort((left, right) => right.finalScore - left.finalScore);
      let selected = validated.find(isConfident);
      if (!selected) {
        selected = validated.find((candidate) => {
          return (
            candidate.favicon &&
            candidate.width !== null &&
            candidate.height !== null &&
            Math.max(candidate.width, candidate.height) >= 64
          );
        });
      }

      if (!selected) {
        if (downloadFailures > 0) {
          throw new LogoFinderTechnicalError(
            "Logo candidates were found, but none could be downloaded as usable images",
          );
        }
        throw new LogoNotFoundError(
          "Website was inspected, but no candidate was strong enough to identify as the official logo",
        );
      }

      const runnerUp = validated.find((candidate) => candidate !== selected);
      const confidence =
        selected.favicon ||
        (runnerUp !== undefined && selected.finalScore - runnerUp.finalScore < 8)
          ? "MEDIUM"
          : "HIGH";

      return {
        body: selected.body,
        confidence,
        contentType: selected.contentType,
        extension: selected.extension,
        hasAlpha: selected.hasAlpha,
        height: selected.height,
        score: selected.finalScore,
        sourceUrl: selected.sourceUrl,
        width: selected.width,
      };
    },
  };
}
