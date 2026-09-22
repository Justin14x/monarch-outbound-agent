import type OpenAI from "openai";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createOpenAITransparentLogoGenerator,
  TRANSPARENT_LOGO_MODEL,
  TRANSPARENT_LOGO_PROMPT,
  TransparentLogoGenerationError,
  validateTransparentPng,
} from "../src/modules/logos/transparent-logo-generator.js";

let validTransparentPng: Uint8Array;
let opaquePng: Uint8Array;
let blankTransparentPng: Uint8Array;

beforeAll(async () => {
  validTransparentPng = await sharp({
    create: {
      background: { alpha: 0.5, b: 30, g: 20, r: 200 },
      channels: 4,
      height: 80,
      width: 160,
    },
  })
    .png()
    .toBuffer();
  opaquePng = await sharp({
    create: {
      background: { b: 30, g: 20, r: 200 },
      channels: 3,
      height: 80,
      width: 160,
    },
  })
    .png()
    .toBuffer();
  blankTransparentPng = await sharp({
    create: {
      background: { alpha: 0, b: 0, g: 0, r: 0 },
      channels: 4,
      height: 80,
      width: 160,
    },
  })
    .png()
    .toBuffer();
});

describe("transparent logo generation", () => {
  it("uses the official image edit API with the exact configured prompt", async () => {
    const edit = vi.fn().mockResolvedValue({
      data: [{ b64_json: Buffer.from(validTransparentPng).toString("base64") }],
    });
    const client = { images: { edit } } as unknown as OpenAI;
    const generator = createOpenAITransparentLogoGenerator(client);

    const result = await generator.generate({
      body: opaquePng,
      filename: "original.png",
    });

    expect(Buffer.from(result).equals(Buffer.from(validTransparentPng))).toBe(true);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]?.[0]).toMatchObject({
      background: "transparent",
      model: TRANSPARENT_LOGO_MODEL,
      output_format: "png",
      prompt:
        "Preserve this exact logo without altering its design, typography, colors, proportions, or spacing. Remove only the background and return the logo as a transparent PNG.",
    });
    expect(TRANSPARENT_LOGO_PROMPT).toBe(
      "Preserve this exact logo without altering its design, typography, colors, proportions, or spacing. Remove only the background and return the logo as a transparent PNG.",
    );
    expect(edit.mock.calls[0]?.[0].image).toBeInstanceOf(File);
  });

  it("surfaces an image API failure", async () => {
    const client = {
      images: { edit: vi.fn().mockRejectedValue(new Error("quota exceeded")) },
    } as unknown as OpenAI;
    const generator = createOpenAITransparentLogoGenerator(client);

    await expect(
      generator.generate({ body: opaquePng, filename: "original.png" }),
    ).rejects.toThrow("OpenAI image edit failed: quota exceeded");
  });

  it("accepts a valid nonblank PNG with transparent pixels", async () => {
    await expect(validateTransparentPng(validTransparentPng)).resolves.toMatchObject({
      width: 160,
      height: 80,
    });
  });

  it("rejects an invalid returned image", async () => {
    await expect(validateTransparentPng(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "not a PNG",
    );
  });

  it("rejects a PNG without transparency", async () => {
    await expect(validateTransparentPng(opaquePng)).rejects.toThrow(
      "alpha channel",
    );
  });

  it("rejects a fully transparent blank PNG", async () => {
    await expect(validateTransparentPng(blankTransparentPng)).rejects.toThrow(
      "blank or effectively empty",
    );
  });
});
