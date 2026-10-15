import { load } from "cheerio";

import {
  createSafeHttpClient,
  type LogoHttpClient,
} from "../logos/safe-http.js";

const EMAIL_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const PRIORITY_LINK =
  /(?:about|contact|connect|leadership|location|management|meet|owner|staff|team)/i;
const REJECTED_LOCAL_PARTS = new Set([
  "example",
  "firstname.lastname",
  "name",
  "no-reply",
  "noreply",
  "test",
  "your-email",
  "youremail",
]);

export interface VerifiedEmail {
  contactName: string | null;
  email: string;
  sourceUrl: string;
  type: "DECISION_MAKER" | "MANAGEMENT" | "GENERAL";
}

export interface PublicEmailPage {
  html: string;
  url: string;
}

export interface PublicEmailSearchProvider {
  search(input: {
    businessName: string;
    website: string;
  }): Promise<PublicEmailPage[]>;
}

export interface VerifiedEmailFinder {
  find(input: {
    businessName: string;
    website: string;
  }): Promise<VerifiedEmail>;
}

export interface WebsiteEmailFinderOptions {
  httpClient?: Pick<LogoHttpClient, "getHtml">;
  maxPages?: number;
  publicSearch?: PublicEmailSearchProvider;
}

export class EmailNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailNotFoundError";
  }
}

export class EmailFinderTechnicalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmailFinderTechnicalError";
  }
}

interface EmailCandidate extends VerifiedEmail {
  score: number;
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().replace(/[),.;:>]+$/g, "").toLowerCase();
  const match = new RegExp(`^(?:${EMAIL_PATTERN.source})$`, "i").exec(email);
  if (!match) return null;
  const [local = "", domain = ""] = email.split("@");
  if (
    !local ||
    !domain ||
    REJECTED_LOCAL_PARTS.has(local) ||
    domain === "example.com" ||
    domain.endsWith(".example")
  ) {
    return null;
  }
  return email;
}

function compactDomain(value: string): string {
  return value.toLowerCase().replace(/^www\./, "");
}

function explicitContactName(context: string): string | null {
  const normalized = context.replace(/\s+/g, " ").trim();
  const beforeRole =
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[,|–—-]?\s*(?:Owner|Founder|Co-Founder|CEO|President)\b/.exec(
      normalized,
    );
  if (beforeRole?.[1]) return beforeRole[1];
  const afterRole =
    /\b(?:Owner|Founder|Co-Founder|CEO|President)\s*[:|–—-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/.exec(
      normalized,
    );
  return afterRole?.[1] ?? null;
}

function candidateType(context: string, localPart: string): VerifiedEmail["type"] {
  const semanticContext = context.replace(EMAIL_PATTERN, " ");
  if (/\b(?:owner|founder|co-founder|ceo|president|principal)\b/i.test(semanticContext)) {
    return "DECISION_MAKER";
  }
  if (
    /\b(?:admin|business|director|manager|management|office|operations)\b/i.test(
      semanticContext,
    ) ||
    /^(?:admin|business|director|manager|office|operations)[._-]?/.test(localPart)
  ) {
    return "MANAGEMENT";
  }
  return "GENERAL";
}

function scoreCandidate(
  email: string,
  context: string,
  sourceUrl: string,
  website: string,
  mailto: boolean,
): EmailCandidate {
  const [localPart = "", emailDomain = ""] = email.split("@");
  const type = candidateType(context, localPart);
  const contactName = type === "DECISION_MAKER" ? explicitContactName(context) : null;
  let score = type === "DECISION_MAKER" ? 300 : type === "MANAGEMENT" ? 200 : 100;
  const websiteDomain = compactDomain(new URL(website).hostname);
  if (compactDomain(emailDomain) === websiteDomain) score += 60;
  if (mailto) score += 20;
  if (/\b(?:contact|email|e-mail|mail)\b/i.test(context)) score += 10;
  if (/^(?:info|hello|contact|services|team|support|frontdesk|booking)s?$/.test(localPart)) {
    score += 15;
  }
  if (/^(?:privacy|legal|billing|careers|jobs|webmaster)$/.test(localPart)) score -= 80;
  return { contactName, email, score, sourceUrl, type };
}

function extractCandidates(
  html: string,
  sourceUrl: string,
  website: string,
): EmailCandidate[] {
  const $ = load(html);
  $("script, style, noscript").remove();
  const candidates: EmailCandidate[] = [];
  const seen = new Set<string>();

  function add(raw: string, context: string, mailto: boolean): void {
    const email = normalizeEmail(raw);
    if (!email) return;
    const key = `${email}|${sourceUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(scoreCandidate(email, context, sourceUrl, website, mailto));
  }

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (!href.toLowerCase().startsWith("mailto:")) return;
    const address = href.slice(href.indexOf(":") + 1).split(/[?&#]/)[0] ?? "";
    const container = anchor
      .closest("address, li, p, section, article, div")
      .first();
    const context = (container.html() ?? container.text())
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
    add(decodeURIComponent(address), context, true);
  });

  $("address, li, p, section, article, footer, header, div").each((_, element) => {
    const context = $(element).text().replace(/\s+/g, " ").trim();
    if (!context || context.length > 1_500) return;
    for (const match of context.matchAll(EMAIL_PATTERN)) {
      add(match[0], context.slice(0, 600), false);
    }
  });

  return candidates;
}

function prioritizedSameSiteLinks(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const origin = new URL(pageUrl).origin;
  const links: Array<{ score: number; url: string }> = [];
  const seen = new Set<string>();
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const raw = anchor.attr("href")?.trim();
    if (!raw || raw.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(raw)) return;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return;
    url.hash = "";
    const normalized = url.toString();
    if (seen.has(normalized)) return;
    const signal = `${url.pathname} ${anchor.text()} ${anchor.attr("aria-label") ?? ""}`;
    if (!PRIORITY_LINK.test(signal)) return;
    seen.add(normalized);
    links.push({ score: /contact|location/i.test(signal) ? 2 : 1, url: normalized });
  });
  return links.sort((a, b) => b.score - a.score).map(({ url }) => url);
}

function bestCandidate(candidates: EmailCandidate[]): VerifiedEmail | null {
  const best = [...candidates].sort(
    (left, right) => right.score - left.score || left.email.localeCompare(right.email),
  )[0];
  if (!best) return null;
  return {
    contactName: best.contactName,
    email: best.email,
    sourceUrl: best.sourceUrl,
    type: best.type,
  };
}

export function createWebsiteEmailFinder(
  options: WebsiteEmailFinderOptions = {},
): VerifiedEmailFinder {
  const httpClient = options.httpClient ?? createSafeHttpClient();
  const maxPages = options.maxPages ?? 8;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new RangeError("maxPages must be an integer between 1 and 20");
  }

  return {
    async find({ businessName, website }) {
      const queue = [website];
      const visited = new Set<string>();
      const candidates: EmailCandidate[] = [];
      let inspected = 0;
      while (queue.length > 0 && inspected < maxPages) {
        const page = queue.shift();
        if (!page || visited.has(page)) continue;
        visited.add(page);
        try {
          const resource = await httpClient.getHtml(page);
          inspected += 1;
          const html = new TextDecoder().decode(resource.body);
          candidates.push(
            ...extractCandidates(html, resource.finalUrl, website),
          );
          for (const link of prioritizedSameSiteLinks(html, resource.finalUrl)) {
            if (!visited.has(link)) queue.push(link);
          }
        } catch (error) {
          if (inspected === 0 && queue.length === 0) {
            throw new EmailFinderTechnicalError(
              `Could not inspect ${website}: ${error instanceof Error ? error.message : "network error"}`,
              { cause: error },
            );
          }
        }
      }

      const official = bestCandidate(candidates);
      if (official) return official;

      if (options.publicSearch) {
        const pages = await options.publicSearch.search({ businessName, website });
        const publicCandidates = pages.flatMap((page) =>
          extractCandidates(page.html, page.url, website),
        );
        const publicResult = bestCandidate(publicCandidates);
        if (publicResult) return publicResult;
      }

      throw new EmailNotFoundError(
        `No publicly listed email was found after inspecting ${inspected} official website page${inspected === 1 ? "" : "s"}`,
      );
    },
  };
}
