import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  addSideCanvas,
  sidePaddingPixels,
} from "../src/modules/stitch/presentation-canvas.js";
import { verifyBlackPhoneFrame } from "../src/modules/stitch/phone-frame-verifier.js";

describe("Stitch presentation canvas", () => {
  it("adds equal side margins without changing a pixel or the height of the original phone render", async () => {
    const original = new Uint8Array(await readFile(
      new URL("../assets/stitch/black-phone-presentation-reference.png", import.meta.url),
    ));
    const source = await sharp(original).metadata();
    const padded = await addSideCanvas(original);
    const side = sidePaddingPixels(source.width!);

    expect(padded.sidePadding).toBe(side);
    expect(padded.width).toBe(source.width! + 2 * side);
    expect(padded.height).toBe(source.height);
    expect((await sharp(padded.body).metadata()).format).toBe("png");

    const originalPixels = await sharp(original).ensureAlpha().raw().toBuffer();
    const centerPixels = await sharp(padded.body)
      .extract({ left: side, top: 0, width: source.width!, height: source.height! })
      .ensureAlpha().raw().toBuffer();
    const digest = (pixels: Buffer) => createHash("sha256").update(pixels).digest("hex");
    expect(digest(centerPixels)).toBe(digest(originalPixels));
    expect((await verifyBlackPhoneFrame(padded.body)).valid).toBe(true);
  });

  it("rejects an invalid width", () => {
    expect(() => sidePaddingPixels(0)).toThrow("positive image width");
  });
});
