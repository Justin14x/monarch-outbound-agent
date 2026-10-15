import { load } from "cheerio";

import {
  createLogoFinder,
  type DetectedLogo,
  type LogoFinder,
} from "../logos/logo-finder.js";
import {
  createSafeHttpClient,
  type LogoHttpClient,
} from "../logos/safe-http.js";

export interface StitchBrandReference {
  logo: DetectedLogo | null;
  logoIssue: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  paletteSourceUrl: string | null;
}

function normalizeHex(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const digits = match[1]!.toUpperCase();
  return digits.length === 3
    ? `#${[...digits].map((digit) => digit + digit).join("")}`
    : `#${digits}`;
}

function cssToken(css: string, names: readonly string[]): string | null {
  for (const name of names) {
    const match = css.match(new RegExp(`(?:^|[;{\\s])--${name}\\s*:\\s*(#[\\da-f]{3}(?:[\\da-f]{3})?)(?=\\s*[;}])`, "i"));
    const color = normalizeHex(match?.[1]);
    if (color) return color;
  }
  return null;
}

export function paletteFromCss(css: string): { primaryColor: string | null; secondaryColor: string | null } {
  return {
    primaryColor: cssToken(css, [
      "e-global-color-primary",
      "brand-primary",
      "primary-color",
      "color-primary",
      "theme-primary",
    ]),
    secondaryColor: cssToken(css, [
      "e-global-color-secondary",
      "e-global-color-accent",
      "brand-accent",
      "accent-color",
      "color-accent",
    ]),
  };
}

export async function discoverWebsitePalette(
  website: string,
  http: Pick<LogoHttpClient, "getHtml"> = createSafeHttpClient(),
): Promise<Pick<StitchBrandReference, "primaryColor" | "secondaryColor" | "paletteSourceUrl">> {
  const page = await http.getHtml(website);
  const html = new TextDecoder().decode(page.body);
  const $ = load(html);
  const baseUrl = new URL(page.finalUrl);
  const kitIds = new Set(
    [...($("body").attr("class") ?? "").matchAll(/elementor-kit-(\d+)/g)].map((match) => match[1]),
  );
  const stylesheets = $("link[rel~=stylesheet][href]").map((_, link) => {
    try {
      const url = new URL($(link).attr("href")!, baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (url.hostname !== baseUrl.hostname) return null;
      if (!url.pathname.endsWith(".css")) return null;
      const kitMatch = url.pathname.match(/\/post-(\d+)\.css$/);
      const score = kitMatch && kitIds.has(kitMatch[1])
        ? 100
        : url.pathname.includes("/elementor/css/post-")
          ? 60
          : /(?:theme|style|brand|global)/i.test(url.pathname)
            ? 20
            : 0;
      return score > 0 ? { score, url: url.toString() } : null;
    } catch {
      return null;
    }
  }).get().filter((value): value is { score: number; url: string } => value !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  for (const stylesheet of stylesheets) {
    try {
      const resource = await http.getHtml(stylesheet.url);
      const palette = paletteFromCss(new TextDecoder().decode(resource.body));
      if (palette.primaryColor || palette.secondaryColor) {
        return { ...palette, paletteSourceUrl: resource.finalUrl };
      }
    } catch {
      // A missing stylesheet is not a reason to prevent app generation.
    }
  }

  const inline = paletteFromCss($("style").map((_, element) => $(element).html() ?? "").get().join("\n"));
  if (inline.primaryColor || inline.secondaryColor) {
    return { ...inline, paletteSourceUrl: page.finalUrl };
  }
  return {
    primaryColor: normalizeHex($("meta[name='theme-color']").attr("content")),
    secondaryColor: null,
    paletteSourceUrl: page.finalUrl,
  };
}

export async function discoverStitchBrandReference(options: {
  businessName: string;
  finder?: LogoFinder;
  http?: LogoHttpClient;
  website: string;
}): Promise<StitchBrandReference> {
  const http = options.http ?? createSafeHttpClient();
  const finder = options.finder ?? createLogoFinder(http);
  const [logoResult, paletteResult] = await Promise.allSettled([
    finder.find({ businessName: options.businessName, website: options.website }),
    discoverWebsitePalette(options.website, http),
  ]);
  const detectedLogo = logoResult.status === "fulfilled" ? logoResult.value : null;
  const highConfidenceLogo = detectedLogo?.confidence === "HIGH" ? detectedLogo : null;
  return {
    logo: highConfidenceLogo,
    logoIssue: logoResult.status === "rejected"
      ? (logoResult.reason instanceof Error ? logoResult.reason.message : "Official logo could not be verified")
      : detectedLogo?.confidence === "MEDIUM"
        ? "Official logo candidate had only medium confidence"
        : null,
    primaryColor: paletteResult.status === "fulfilled" ? paletteResult.value.primaryColor : null,
    secondaryColor: paletteResult.status === "fulfilled" ? paletteResult.value.secondaryColor : null,
    paletteSourceUrl: paletteResult.status === "fulfilled" ? paletteResult.value.paletteSourceUrl : null,
  };
}
