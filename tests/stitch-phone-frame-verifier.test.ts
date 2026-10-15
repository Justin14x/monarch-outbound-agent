import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  assertApprovedHomeFrame,
  assertMatchingPhoneFrame,
  verifyBlackPhoneFrame,
} from "../src/modules/stitch/phone-frame-verifier.js";

async function syntheticPhone(options: {
  bezel?: number;
  bottom?: number;
  top?: number;
} = {}): Promise<Buffer> {
  const bezel = options.bezel ?? 20;
  const top = options.top ?? 46;
  const bottom = options.bottom ?? 46;
  const innerHeight = 1800 - top - bottom - 2 * bezel;
  const svg = `<svg width="780" height="1800" xmlns="http://www.w3.org/2000/svg">
    <rect width="780" height="1800" fill="#edeae5"/>
    <rect x="10" y="${top}" width="760" height="${1800 - top - bottom}" rx="90" fill="#111"/>
    <rect x="${10 + bezel}" y="${top + bezel}" width="${760 - 2 * bezel}" height="${innerHeight}" rx="${90 - bezel}" fill="#faf9f7"/>
    <rect x="300" y="${top + bezel + 24}" width="180" height="55" rx="27" fill="#080808"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("Stitch black phone frame verification", () => {
  it("accepts a complete portrait black phone with a Dynamic Island", async () => {
    const image = await readFile(new URL(
      "../assets/stitch/black-phone-presentation-reference.png", import.meta.url,
    ));
    const result = await verifyBlackPhoneFrame(image);
    expect(result.valid).toBe(true);
    expect(result.phoneWidthFraction).toBeGreaterThan(0.8);
  });

  it("rejects the pale device reference and raw UI without a black outline", async () => {
    const paleReference = await readFile(new URL(
      "../assets/stitch/home-medspa-reference.png", import.meta.url,
    ));
    const rawUi = await sharp({
      create: { background: "#f8f6f2", channels: 3, height: 1804, width: 780 },
    }).png().toBuffer();
    expect((await verifyBlackPhoneFrame(paleReference)).valid).toBe(false);
    expect((await verifyBlackPhoneFrame(rawUi)).valid).toBe(false);
  });

  it("rejects a phone that is too small on a landscape canvas", async () => {
    const image = await readFile(new URL(
      "../assets/stitch/black-phone-presentation-reference.png", import.meta.url,
    ));
    const smallPhone = await sharp(image).resize({ height: 300 }).png().toBuffer();
    const landscape = await sharp({
      create: { background: "#f8f6f2", channels: 3, height: 320, width: 400 },
    }).composite([{ input: smallPhone, left: 135, top: 10 }]).png().toBuffer();
    await expect(verifyBlackPhoneFrame(landscape)).resolves.toMatchObject({
      valid: false,
      reason: "presentation canvas is not portrait-oriented",
    });
  });

  it("measures and accepts matching thin complete phone frames", async () => {
    const home = await verifyBlackPhoneFrame(await syntheticPhone());
    const booking = await verifyBlackPhoneFrame(await syntheticPhone());
    expect(home.geometry).not.toBeNull();
    expect(booking.geometry).not.toBeNull();
    expect(() => assertApprovedHomeFrame(home.geometry!)).not.toThrow();
    expect(() => assertMatchingPhoneFrame(home.geometry!, booking.geometry!, "Services / Booking"))
      .not.toThrow();
  });

  it("rejects a thicker Booking outline and a Community phone cropped by the canvas", async () => {
    const home = (await verifyBlackPhoneFrame(await syntheticPhone())).geometry!;
    const booking = (await verifyBlackPhoneFrame(await syntheticPhone({ bezel: 44, top: 4, bottom: 4 }))).geometry!;
    const community = (await verifyBlackPhoneFrame(await syntheticPhone({ top: 0, bottom: 0 }))).geometry!;
    expect(() => assertMatchingPhoneFrame(home, booking, "Services / Booking"))
      .toThrow(/top canvas margin.*left bezel thickness/);
    expect(() => assertMatchingPhoneFrame(home, community, "Community"))
      .toThrow(/top canvas margin.*bottom canvas margin/);
    expect(() => assertApprovedHomeFrame(community))
      .toThrow(/visible neutral canvas/);
  });
});
