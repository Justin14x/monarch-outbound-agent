import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-core";
import sharp from "sharp";

import {
  HOME_CANVAS,
  renderHomeHtml,
  validateHomeShowcase,
  type HomeShowcaseImages,
  type HomeShowcaseInput,
} from "./home-template.js";

export interface ImageSource {
  path: string;
  sourceUrl: string;
}

export interface HomeShowcaseConfig extends Omit<HomeShowcaseInput, "logo" | "heroImage" | "announcementImage" | "featureImages"> {
  assets: {
    logo: ImageSource;
    hero: ImageSource;
    announcement: ImageSource;
    features: [ImageSource, ImageSource, ImageSource];
  };
}

const ASSET_ROOT = path.resolve("assets");

function ensureSource(source: ImageSource, name: string): string {
  if (!source || typeof source.path !== "string" || typeof source.sourceUrl !== "string") {
    throw new Error(`${name} needs a local asset path and public source URL`);
  }
  const sourceUrl = new URL(source.sourceUrl);
  if (!["http:", "https:"].includes(sourceUrl.protocol)) throw new Error(`${name} source URL must use HTTP(S)`);
  const resolved = path.resolve(ASSET_ROOT, source.path);
  if (!resolved.startsWith(`${ASSET_ROOT}${path.sep}`)) throw new Error(`${name} must stay inside assets/`);
  return resolved;
}

async function imageData(source: ImageSource, name: string): Promise<string> {
  const filePath = ensureSource(source, name);
  const body = await readFile(filePath);
  const metadata = await sharp(body).metadata();
  const mime = metadata.format === "png" ? "image/png"
    : metadata.format === "jpeg" ? "image/jpeg"
      : metadata.format === "webp" ? "image/webp" : null;
  if (!mime || !metadata.width || !metadata.height || metadata.width < 100 || metadata.height < 100) {
    throw new Error(`${name} must be a usable PNG, JPEG, or WebP image of at least 100×100`);
  }
  return `data:${mime};base64,${body.toString("base64")}`;
}

function validateConfig(config: HomeShowcaseConfig): HomeShowcaseInput {
  if (!Array.isArray(config.categories) || config.categories.length !== 5 ||
    !Array.isArray(config.features) || config.features.length !== 3 ||
    !Array.isArray(config.headline) || config.headline.length !== 2 ||
    !Array.isArray(config.description) || config.description.length !== 2 ||
    !Array.isArray(config.announcementHeadline) || config.announcementHeadline.length !== 2 ||
    !Array.isArray(config.assets?.features) || config.assets.features.length !== 3) {
    throw new Error("Home config needs two-line copy, five categories, and exactly three features and feature images");
  }
  return validateHomeShowcase({
    ...config,
    logo: config.assets.logo.path,
    heroImage: config.assets.hero.path,
    announcementImage: config.assets.announcement.path,
    featureImages: config.assets.features.map((asset) => asset.path) as [string, string, string],
  });
}

export async function renderHomeShowcase(config: HomeShowcaseConfig, outputPath: string): Promise<{ path: string; sha256: string; width: number; height: number }> {
  const input = validateConfig(config);
  const images: HomeShowcaseImages = {
    logo: await imageData(config.assets.logo, "logo"),
    hero: await imageData(config.assets.hero, "hero"),
    announcement: await imageData(config.assets.announcement, "announcement"),
    features: await Promise.all(config.assets.features.map((source, index) => imageData(source, `feature ${index + 1}`))) as [string, string, string],
  };
  const html = renderHomeHtml(input, images);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: HOME_CANVAS,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => { await document.fonts.ready; });
    const issues = await page.evaluate(() => {
      const failures: string[] = [];
      const b = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) { failures.push(`Missing ${selector}`); return null; }
        return element.getBoundingClientRect();
      };
      for (const image of document.querySelectorAll("img")) {
        if (!image.complete || image.naturalWidth === 0) failures.push(`Image did not load: ${image.alt}`);
      }
      for (const selector of [".eyebrow", ".headline", ".description", ".cta", ".announcement-eyebrow", ".announcement-title", ".announcement-detail", ".features-heading h2", ".feature-copy strong", ".feature-copy span"]) {
        for (const element of document.querySelectorAll(selector)) {
          // Font descenders can extend a few pixels beyond an element's line box
          // without being clipped; horizontal overflow has no such allowance.
          if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 4) {
            failures.push(`Text overflows ${selector} (${element.scrollWidth}/${element.clientWidth} wide, ${element.scrollHeight}/${element.clientHeight} high): ${element.textContent?.trim()}`);
          }
        }
      }
      const hero = b('[data-check="hero"]');
      const categories = b('[data-check="categories"]');
      const announcement = b('[data-check="announcement"]');
      const heading = b('[data-check="features-heading"]');
      const features = b('[data-check="features"]');
      const nav = b('[data-check="nav"]');
      if (hero && categories && hero.bottom > categories.top - 10) failures.push("Hero copy overlaps categories");
      if (categories && announcement && categories.bottom > announcement.top - 10) failures.push("Categories overlap announcement");
      if (announcement && heading && announcement.bottom > heading.top - 10) failures.push("Announcement overlaps feature heading");
      if (heading && features && heading.bottom > features.top - 5) failures.push("Feature heading overlaps cards");
      if (features && nav && features.bottom > nav.top - 20) failures.push("Feature cards overlap bottom navigation");
      const screen = b('[data-check="screen"]');
      if (screen && nav && (nav.left < screen.left || nav.right > screen.right || nav.bottom > screen.bottom)) failures.push("Navigation extends outside screen");
      return failures;
    });
    if (issues.length) throw new Error(`Home showcase failed layout checks:\n${issues.join("\n")}`);
    const absoluteOutput = path.resolve(outputPath);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    const png = await page.screenshot({ path: absoluteOutput, type: "png", animations: "disabled" });
    const metadata = await sharp(png).metadata();
    if (metadata.width !== HOME_CANVAS.width || metadata.height !== HOME_CANVAS.height) {
      throw new Error("Rendered Home screenshot has unexpected dimensions");
    }
    return { path: absoluteOutput, sha256: createHash("sha256").update(png).digest("hex"), width: metadata.width, height: metadata.height };
  } finally {
    await browser.close();
  }
}
