import { describe, expect, it, vi } from "vitest";

import type { DetectedLogo } from "../src/modules/logos/logo-finder.js";
import type { LogoHttpClient } from "../src/modules/logos/safe-http.js";
import {
  discoverStitchBrandReference,
  discoverWebsitePalette,
  paletteFromCss,
} from "../src/modules/stitch/brand-reference.js";

const WEBSITE = "https://skinhubmedspa.com/";
const CSS_URL = "https://skinhubmedspa.com/wp-content/uploads/elementor/css/post-7.css";

function resource(body: string, finalUrl: string) {
  return {
    body: new TextEncoder().encode(body),
    contentType: finalUrl.endsWith(".css") ? "text/css" : "text/html",
    finalUrl,
  };
}

function siteHttp(): LogoHttpClient {
  return {
    getBinary: vi.fn(),
    getHtml: vi.fn(async (url) => url === CSS_URL
      ? resource(".elementor-kit-7{--e-global-color-primary:#C19557;--e-global-color-secondary:#CB9D4A;}", CSS_URL)
      : resource(`<html><head><link rel="stylesheet" href="${CSS_URL}"></head><body class="elementor-kit-7"></body></html>`, WEBSITE)),
  };
}

describe("Stitch website branding", () => {
  it("extracts explicit primary and secondary website CSS tokens", () => {
    expect(paletteFromCss(".kit{--e-global-color-primary:#c19557;--e-global-color-secondary:#cb9d4a;}")).toEqual({
      primaryColor: "#C19557",
      secondaryColor: "#CB9D4A",
    });
  });

  it("prioritizes the site's Elementor kit stylesheet over generic theme colors", async () => {
    const http = siteHttp();
    const palette = await discoverWebsitePalette(WEBSITE, http);
    expect(palette).toEqual({
      primaryColor: "#C19557",
      secondaryColor: "#CB9D4A",
      paletteSourceUrl: CSS_URL,
    });
    expect(http.getHtml).toHaveBeenCalledWith(CSS_URL);
  });

  it("does not pass a medium-confidence or invented logo into Stitch", async () => {
    const logo = { confidence: "MEDIUM", sourceUrl: `${WEBSITE}logo.png` } as DetectedLogo;
    const brand = await discoverStitchBrandReference({
      businessName: "Skin Hub Med Spa",
      website: WEBSITE,
      http: siteHttp(),
      finder: { find: vi.fn(async () => logo) },
    });
    expect(brand.logo).toBeNull();
    expect(brand.logoIssue).toMatch(/medium confidence/);
    expect(brand.primaryColor).toBe("#C19557");
  });

  it("accepts a high-confidence official logo and continues when colors are unavailable", async () => {
    const logo = {
      confidence: "HIGH",
      sourceUrl: `${WEBSITE}official-logo.png`,
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    } as DetectedLogo;
    const brand = await discoverStitchBrandReference({
      businessName: "Skin Hub Med Spa",
      website: WEBSITE,
      http: { getBinary: vi.fn(), getHtml: vi.fn().mockRejectedValue(new Error("CSS unavailable")) },
      finder: { find: vi.fn(async () => logo) },
    });
    expect(brand.logo).toBe(logo);
    expect(brand.primaryColor).toBeNull();
    expect(brand.paletteSourceUrl).toBeNull();
  });
});
