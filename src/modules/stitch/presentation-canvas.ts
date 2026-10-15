import sharp from "sharp";

// Add breathing room around Stitch's finished render without resizing or
// redrawing the phone. The padding is part of the private Storage PNG only.
const SIDE_PADDING_FRACTION = 0.1;

export function sidePaddingPixels(width: number): number {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error("Presentation canvas needs a positive image width");
  }
  return Math.max(1, Math.round(width * SIDE_PADDING_FRACTION));
}

function hexColor(data: Buffer, offset: number): string {
  return `#${[...data.subarray(offset, offset + 3)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function addSideCanvas(png: Uint8Array): Promise<{
  body: Uint8Array;
  height: number;
  sidePadding: number;
  width: number;
}> {
  const image = sharp(png);
  const metadata = await image.metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) {
    throw new Error("Presentation canvas requires a PNG with valid dimensions");
  }

  const { width, height } = metadata;
  const sidePadding = sidePaddingPixels(width);
  const canvasWidth = width + 2 * sidePadding;
  const pixels = await image.removeAlpha().raw().toBuffer();
  const top = hexColor(pixels, 0);
  const bottom = hexColor(pixels, (height - 1) * width * 3);
  // Match the existing neutral backdrop at its top and bottom edges. The
  // original screenshot is overlaid at its exact native size in the center.
  const background = Buffer.from(
    `<svg width="${canvasWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="backdrop" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${top}"/>` +
      `<stop offset="1" stop-color="${bottom}"/>` +
      `</linearGradient></defs><rect width="100%" height="100%" fill="url(#backdrop)"/></svg>`,
  );
  const body = await sharp(background)
    .composite([{ input: Buffer.from(png), left: sidePadding, top: 0 }])
    .png()
    .toBuffer();
  return { body: new Uint8Array(body), height, sidePadding, width: canvasWidth };
}
