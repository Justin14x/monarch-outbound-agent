import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  HOME_CANVAS,
  renderHomeHtml,
  validateHomeShowcase,
  type HomeShowcaseInput,
} from "../src/modules/showcase/home-template.js";
import { renderHomeShowcase, type HomeShowcaseConfig } from "../src/modules/showcase/home-renderer.js";

const input: HomeShowcaseInput = {
  businessName: "Skin Hub Med Spa",
  website: "https://skinhubmedspa.com/",
  logo: "logo.png",
  heroImage: "hero.png",
  announcementImage: "announcement.png",
  featureImages: ["a.png", "b.png", "c.png"],
  brandAccent: "#c19557",
  logoSurface: "dark",
  eyebrow: "SKIN HUB MED SPA",
  headline: ["Your Best", "Glow"],
  description: ["Personalized treatments.", "A little time for you."],
  cta: "Explore & book",
  categories: ["Injectables", "Lasers", "Facials", "Body", "Wellness"],
  announcementEyebrow: "DISCOVER MORE",
  announcementHeadline: ["Your Skin Hub", "Experience"],
  announcementDetail: "Explore care made for you",
  featuresTitle: "Featured Treatments",
  features: [
    { title: "Injectables", subtitle: "Explore treatments" },
    { title: "Hydrafacial", subtitle: "Refresh your glow" },
    { title: "Laser", subtitle: "Discover your options" },
  ],
};

const images = {
  logo: "data:image/png;base64,AAAA",
  hero: "data:image/png;base64,AAAA",
  announcement: "data:image/png;base64,AAAA",
  features: ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA", "data:image/png;base64,AAAA"] as [string, string, string],
};

describe("locked Home showcase template", () => {
  it("has the reference canvas size and one fixed four-tab navigation", () => {
    expect(HOME_CANVAS).toEqual({ width: 851, height: 1847 });
    const html = renderHomeHtml(input, images);
    expect(html.match(/class="bottom-nav"/g)).toHaveLength(1);
    for (const tab of ["Home", "Booking", "Community", "Account"]) {
      expect(html).toContain(`<span>${tab}</span>`);
    }
    expect(html).not.toContain("AURA MED SPA");
  });

  it("keeps navigation markup identical when business content and brand color change", () => {
    const first = renderHomeHtml(input, images);
    const second = renderHomeHtml({ ...input, businessName: "Another Business", brandAccent: "#246b78", logoSurface: "light" }, images);
    const navigation = /<div class="bottom-nav"[^>]*>.*?<div class="home-indicator"><\/div>/s;
    expect(first.match(navigation)?.[0]).toBe(second.match(navigation)?.[0]);
  });

  it("escapes prospect text instead of injecting HTML", () => {
    const html = renderHomeHtml({ ...input, businessName: "A & B <Spa>" }, images);
    expect(html).toContain("A &amp; B &lt;Spa&gt;");
    expect(html).not.toContain("<Spa>");
  });

  it("rejects copy that cannot fit its locked slot", () => {
    expect(() => validateHomeShowcase({ ...input, headline: ["A very long line that will not fit", "Glow"] })).toThrow(/headline/);
    expect(() => validateHomeShowcase({ ...input, brandAccent: "red" })).toThrow(/brandAccent/);
  });

  it("rejects image paths outside assets before starting a browser", async () => {
    const config = JSON.parse(await readFile("examples/showcase/skin-hub-home.json", "utf8")) as HomeShowcaseConfig;
    config.assets.logo.path = "../../.env.local";
    await expect(renderHomeShowcase(config, "output/showcase/invalid.png")).rejects.toThrow(/inside assets/);
  });
});
