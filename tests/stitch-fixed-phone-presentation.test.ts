import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  FIXED_PHONE_CANVAS,
  renderFixedPhonePresentation,
} from "../src/modules/stitch/fixed-phone-presentation.js";
import { verifyBlackPhoneFrame } from "../src/modules/stitch/phone-frame-verifier.js";

const reference = new URL("../assets/stitch/black-phone-presentation-reference.png", import.meta.url);

async function wideBezelSource(): Promise<Uint8Array> {
  const svg = `<svg width="780" height="1830" xmlns="http://www.w3.org/2000/svg">
    <rect width="780" height="1830" fill="#ece8e3"/>
    <rect x="0" y="0" width="780" height="1830" rx="88" fill="#090909"/>
    <rect x="38" y="40" width="704" height="1750" rx="52" fill="#faf8f5"/>
    <rect x="300" y="68" width="180" height="54" rx="27" fill="#000"/>
    <rect x="80" y="300" width="620" height="400" rx="30" fill="#c19557"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

describe("fixed Stitch phone presentation", () => {
  it("uses identical canvas and phone geometry for different source frames", async () => {
    const thin = new Uint8Array(await readFile(reference));
    const thick = await wideBezelSource();
    const originalThin = Buffer.from(thin);
    const outputs = await Promise.all([thin, thick].map(renderFixedPhonePresentation));

    for (const output of outputs) {
      expect([output.width, output.height]).toEqual([
        FIXED_PHONE_CANVAS.width, FIXED_PHONE_CANVAS.height,
      ]);
      const metadata = await sharp(output.body).metadata();
      expect([metadata.width, metadata.height]).toEqual([936, 1804]);
      expect((await verifyBlackPhoneFrame(output.body)).valid).toBe(true);
    }
    const first = (await verifyBlackPhoneFrame(outputs[0]!.body)).geometry;
    const second = (await verifyBlackPhoneFrame(outputs[1]!.body)).geometry;
    expect(second).toEqual(first);
    expect(Buffer.from(thin)).toEqual(originalThin);
  });

  it("refuses to present an unframed source with no measurable app interior", async () => {
    const rawUi = new Uint8Array(await sharp({
      create: { width: 780, height: 1804, channels: 3, background: "#faf8f5" },
    }).png().toBuffer());
    await expect(renderFixedPhonePresentation(rawUi))
      .rejects.toThrow("Stitch render has no usable phone screen");
  });
});
