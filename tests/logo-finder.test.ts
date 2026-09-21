import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createLogoFinder,
  LogoFinderTechnicalError,
  LogoNotFoundError,
} from "../src/modules/logos/logo-finder.js";
import type {
  HttpResource,
  LogoHttpClient,
} from "../src/modules/logos/safe-http.js";

const htmlResource = (html: string, finalUrl: string): HttpResource => ({
  body: new TextEncoder().encode(html),
  contentType: "text/html; charset=utf-8",
  finalUrl,
});

const imageResource = (
  body: Uint8Array,
  contentType: string,
  finalUrl: string,
): HttpResource => ({ body, contentType, finalUrl });

function fakeHttp(
  html: string,
  website: string,
  assets: Record<string, HttpResource>,
): LogoHttpClient {
  return {
    async getHtml() {
      return htmlResource(html, website);
    },
    async getBinary(url) {
      const asset = assets[url];
      if (!asset) throw new Error(`missing fixture: ${url}`);
      return asset;
    },
  };
}

let transparentPng: Uint8Array;
let opaquePng: Uint8Array;
let webp: Uint8Array;
let jpeg: Uint8Array;

beforeAll(async () => {
  transparentPng = await sharp({
    create: {
      background: { alpha: 0, b: 0, g: 0, r: 0 },
      channels: 4,
      height: 180,
      width: 600,
    },
  })
    .png()
    .toBuffer();
  opaquePng = await sharp({
    create: {
      background: { b: 30, g: 20, r: 10 },
      channels: 3,
      height: 120,
      width: 400,
    },
  })
    .png()
    .toBuffer();
  webp = await sharp({
    create: {
      background: { b: 80, g: 50, r: 20 },
      channels: 3,
      height: 160,
      width: 500,
    },
  })
    .webp()
    .toBuffer();
  jpeg = await sharp({
    create: {
      background: { b: 10, g: 100, r: 200 },
      channels: 3,
      height: 200,
      width: 700,
    },
  })
    .jpeg()
    .toBuffer();
});

describe("official logo finder fixtures", () => {
  it("finds an official SVG logo in the header", async () => {
    const website = "https://svg.example/";
    const logoUrl = "https://svg.example/assets/acme-logo.svg";
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120"><rect width="600" height="120" fill="navy"/><text x="20" y="80" fill="white">ACME</text></svg>',
    );
    const finder = createLogoFinder(
      fakeHttp(
        '<header><a href="/"><img class="site-logo" alt="Acme logo" src="/assets/acme-logo.svg"></a></header>',
        website,
        { [logoUrl]: imageResource(svg, "image/svg+xml", logoUrl) },
      ),
    );

    const result = await finder.find({ businessName: "Acme", website });

    expect(result).toMatchObject({
      confidence: "HIGH",
      contentType: "image/svg+xml",
      extension: "svg",
      sourceUrl: logoUrl,
      width: 600,
      height: 120,
    });
  });

  it("resolves a relative transparent PNG logo URL", async () => {
    const website = "https://png.example/about";
    const logoUrl = "https://png.example/images/nara-logo.png";
    const finder = createLogoFinder(
      fakeHttp(
        '<nav><a href="/"><img id="brand-logo" alt="Nara Pilates" src="/images/nara-logo.png"></a></nav>',
        website,
        { [logoUrl]: imageResource(transparentPng, "image/png", logoUrl) },
      ),
    );

    const result = await finder.find({ businessName: "Nara Pilates", website });

    expect(result).toMatchObject({
      contentType: "image/png",
      extension: "png",
      hasAlpha: true,
      sourceUrl: logoUrl,
    });
  });

  it("uses the highest-resolution picture/srcset logo candidate", async () => {
    const website = "https://picture.example/";
    const fallbackUrl = "https://picture.example/logo-small.png";
    const largeUrl = "https://picture.example/logo-large.png";
    const finder = createLogoFinder(
      fakeHttp(
        '<header><a href="/"><picture class="brand"><source srcset="/logo-small.png 1x, /logo-large.png 2x"><img alt="Picture Company logo" src="/logo-small.png"></picture></a></header>',
        website,
        {
          [fallbackUrl]: imageResource(opaquePng, "image/png", fallbackUrl),
          [largeUrl]: imageResource(transparentPng, "image/png", largeUrl),
        },
      ),
    );

    const result = await finder.find({
      businessName: "Picture Company",
      website,
    });

    expect(result.sourceUrl).toBe(largeUrl);
    expect(result.width).toBe(600);
  });

  it("ranks the official logo above unrelated and third-party images", async () => {
    const website = "https://ranking.example/";
    const logoUrl = "https://cdn.ranking.example/skin-hub-logo.webp";
    const heroUrl = "https://ranking.example/hero.jpg";
    const finder = createLogoFinder(
      fakeHttp(
        [
          '<header><img src="/hero.jpg" alt="Treatment room">',
          `<a href="/"><img class="brand-logo" alt="Skin Hub Med Spa logo" src="${logoUrl}"></a>`,
          '<img alt="Instagram" src="/instagram-logo.png"></header>',
        ].join(""),
        website,
        {
          [heroUrl]: imageResource(jpeg, "image/jpeg", heroUrl),
          [logoUrl]: imageResource(webp, "image/webp", logoUrl),
        },
      ),
    );

    const result = await finder.find({
      businessName: "Skin Hub Med Spa",
      website,
    });

    expect(result).toMatchObject({
      contentType: "image/webp",
      sourceUrl: logoUrl,
    });
  });

  it("uses structured logo metadata when no visible logo is available", async () => {
    const website = "https://metadata.example/";
    const logoUrl = "https://metadata.example/media/freehand.jpg";
    const finder = createLogoFinder(
      fakeHttp(
        `<main>Welcome</main><script type="application/ld+json">${JSON.stringify({
          "@type": "Organization",
          logo: logoUrl,
          name: "FREEHAND",
        })}</script>`,
        website,
        { [logoUrl]: imageResource(jpeg, "image/jpeg", logoUrl) },
      ),
    );

    const result = await finder.find({ businessName: "FREEHAND", website });

    expect(result.sourceUrl).toBe(logoUrl);
    expect(result.contentType).toBe("image/jpeg");
  });

  it("reports NOT_FOUND for a successfully inspected site without a logo", async () => {
    const website = "https://missing.example/";
    const finder = createLogoFinder(
      fakeHttp(
        "<html><body><main><h1>Welcome to our business</h1><p>There is no logo asset here.</p></main></body></html>",
        website,
        {},
      ),
    );

    await expect(
      finder.find({ businessName: "Missing Company", website }),
    ).rejects.toBeInstanceOf(LogoNotFoundError);
  });

  it("accepts a sufficiently large favicon only as a medium-confidence fallback", async () => {
    const website = "https://icon.example/";
    const iconUrl = "https://icon.example/icon.png";
    const finder = createLogoFinder(
      fakeHttp(
        '<html><head><link rel="icon" sizes="180x180" href="/icon.png"></head><body>Business website content</body></html>',
        website,
        { [iconUrl]: imageResource(transparentPng, "image/png", iconUrl) },
      ),
    );

    const result = await finder.find({ businessName: "Icon Company", website });

    expect(result).toMatchObject({ confidence: "MEDIUM", sourceUrl: iconUrl });
  });

  it("treats an unsupported strong logo asset as a technical failure", async () => {
    const website = "https://unsupported.example/";
    const logoUrl = "https://unsupported.example/official-logo.eps";
    const finder = createLogoFinder(
      fakeHttp(
        '<header><a href="/"><img alt="Unsupported Company logo" src="/official-logo.eps"></a></header>',
        website,
        {
          [logoUrl]: imageResource(
            new TextEncoder().encode("This is an unsupported EPS fixture with more than eighty bytes so it reaches format validation safely."),
            "application/postscript",
            logoUrl,
          ),
        },
      ),
    );

    await expect(
      finder.find({ businessName: "Unsupported Company", website }),
    ).rejects.toBeInstanceOf(LogoFinderTechnicalError);
  });

  it("treats an uninspectable JavaScript-only site as a technical failure", async () => {
    const website = "https://javascript.example/";
    const finder = createLogoFinder(
      fakeHttp(
        '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        website,
        {},
      ),
    );

    await expect(
      finder.find({ businessName: "JavaScript Company", website }),
    ).rejects.toBeInstanceOf(LogoFinderTechnicalError);
  });
});
