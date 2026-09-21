import OpenAI, { toFile } from "openai";
import sharp from "sharp";

import { getServerOpenAIClient } from "../../lib/openai/server.js";

export const TRANSPARENT_LOGO_PROMPT =
  "Generate this logo with a transparent background";
export const TRANSPARENT_LOGO_MODEL = "gpt-image-2.5-sunburst";

const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface OriginalLogoInput {
  body: Uint8Array;
  filename: string;
}

export interface ValidatedTransparentPng {
  body: Uint8Array;
  height: number;
  transparentPixelCount: number;
  width: number;
}

export interface TransparentLogoGenerator {
  generate(original: OriginalLogoInput): Promise<Uint8Array>;
}

export class TransparentLogoGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransparentLogoGenerationError";
  }
}

function hasPngSignature(body: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => body[index] === value);
}

async function detectSupportedInputType(body: Uint8Array): Promise<string> {
  try {
    const metadata = await sharp(body, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    }).metadata();
    if (metadata.format === "png") return "image/png";
    if (metadata.format === "jpeg") return "image/jpeg";
    if (metadata.format === "webp") return "image/webp";
    throw new TransparentLogoGenerationError(
      `OpenAI image edits do not support the original ${metadata.format ?? "unknown"} format`,
    );
  } catch (error) {
    if (error instanceof TransparentLogoGenerationError) throw error;
    throw new TransparentLogoGenerationError(
      "Original logo could not be decoded as a supported PNG, JPEG, or WebP image",
      { cause: error },
    );
  }
}

export async function validateTransparentPng(
  body: Uint8Array,
): Promise<ValidatedTransparentPng> {
  if (body.byteLength === 0) {
    throw new TransparentLogoGenerationError("Generated image was empty");
  }
  if (body.byteLength > MAX_OUTPUT_BYTES) {
    throw new TransparentLogoGenerationError(
      `Generated image exceeded the ${MAX_OUTPUT_BYTES}-byte Storage limit`,
    );
  }
  if (!hasPngSignature(body)) {
    throw new TransparentLogoGenerationError(
      "Generated image was not a PNG file",
    );
  }

  try {
    const image = sharp(body, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < 1 ||
      metadata.height < 1
    ) {
      throw new TransparentLogoGenerationError(
        "Generated PNG had invalid dimensions",
      );
    }
    if (!metadata.hasAlpha) {
      throw new TransparentLogoGenerationError(
        "Generated PNG did not contain an alpha channel",
      );
    }

    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaChannel = info.channels - 1;
    let transparentPixelCount = 0;
    let visiblePixelCount = 0;
    for (let index = alphaChannel; index < data.length; index += info.channels) {
      const alpha = data[index] ?? 0;
      if (alpha < 255) transparentPixelCount += 1;
      if (alpha > 0) visiblePixelCount += 1;
    }

    if (transparentPixelCount === 0) {
      throw new TransparentLogoGenerationError(
        "Generated PNG had no transparent pixels",
      );
    }
    const minimumVisiblePixels = Math.max(
      1,
      Math.floor(metadata.width * metadata.height * 0.001),
    );
    if (visiblePixelCount < minimumVisiblePixels) {
      throw new TransparentLogoGenerationError(
        "Generated PNG was blank or effectively empty",
      );
    }

    return {
      body,
      height: metadata.height,
      transparentPixelCount,
      width: metadata.width,
    };
  } catch (error) {
    if (error instanceof TransparentLogoGenerationError) throw error;
    throw new TransparentLogoGenerationError(
      "Generated PNG could not be decoded",
      { cause: error },
    );
  }
}

export function createOpenAITransparentLogoGenerator(
  client: OpenAI = getServerOpenAIClient(),
): TransparentLogoGenerator {
  return {
    async generate(original) {
      const contentType = await detectSupportedInputType(original.body);
      const image = await toFile(
        Buffer.from(original.body),
        original.filename,
        { type: contentType },
      );

      let response: Awaited<ReturnType<OpenAI["images"]["edit"]>>;
      try {
        response = await client.images.edit({
          background: "transparent",
          image,
          model: TRANSPARENT_LOGO_MODEL,
          output_format: "png",
          prompt: TRANSPARENT_LOGO_PROMPT,
        });
      } catch (error) {
        throw new TransparentLogoGenerationError(
          `OpenAI image edit failed: ${error instanceof Error ? error.message : "unknown API error"}`,
          { cause: error },
        );
      }

      const base64 = response.data?.[0]?.b64_json;
      if (!base64) {
        throw new TransparentLogoGenerationError(
          "OpenAI image edit returned no image data",
        );
      }

      return new Uint8Array(Buffer.from(base64, "base64"));
    },
  };
}
