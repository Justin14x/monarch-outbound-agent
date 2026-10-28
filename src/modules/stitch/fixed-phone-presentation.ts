import { createHash } from "node:crypto";
import sharp from "sharp";

import { verifyBlackPhoneFrame } from "./phone-frame-verifier.js";

// These are export dimensions, not parameters sent to Stitch. Every screen in
// an email showcase gets the same phone silhouette and surrounding canvas.
export const FIXED_PHONE_CANVAS = {
  width: 936,
  height: 1804,
  phone: { left: 90, top: 36, width: 756, height: 1732, radius: 104 },
  screen: { left: 114, top: 60, width: 708, height: 1684, radius: 82 },
} as const;

/** Validate the pixels this module draws, not content-dependent inferred bezel widths. */
export async function assertFixedPhonePresentation(png: Uint8Array): Promise<void> {
  const { width, height, phone } = FIXED_PHONE_CANVAS;
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error("Stored PNG does not use the fixed presentation canvas");
  }
  const dark = (x: number, y: number) => {
    const offset = (y * width + x) * info.channels;
    return Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!) < 65;
  };
  const midX = phone.left + Math.floor(phone.width / 2);
  const midY = phone.top + Math.floor(phone.height / 2);
  if (!dark(phone.left + 10, midY) ||
      !dark(phone.left + phone.width - 11, midY) ||
      !dark(midX, phone.top + 10) ||
      !dark(midX, phone.top + phone.height - 11) ||
      !dark(midX, 105)) {
    throw new Error("Stored PNG is missing the canonical black phone shell or Dynamic Island");
  }
}

/** Hash only the canonical canvas/hardware pixels; app UI never enters these strips. */
export async function fixedPhoneShellFingerprint(png: Uint8Array): Promise<string> {
  await assertFixedPhonePresentation(png);
  const { width, height, screen } = FIXED_PHONE_CANVAS;
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const digest = createHash("sha256");
  for (let y = 0; y < height; y += 1) {
    const row = y * width * info.channels;
    if (y < screen.top || y >= screen.top + screen.height) {
      digest.update(data.subarray(row, row + width * info.channels));
    } else {
      digest.update(data.subarray(row, row + screen.left * info.channels));
      digest.update(data.subarray(
        row + (screen.left + screen.width) * info.channels,
        row + width * info.channels,
      ));
    }
  }
  return digest.digest("hex");
}

function imageBounds(bounds: NonNullable<Awaited<ReturnType<typeof verifyBlackPhoneFrame>>["innerBounds"]>,
  width: number, height: number) {
  const left = Math.max(0, Math.floor(bounds.leftFraction * width));
  // Stay a few pixels inside Stitch's antialiased hardware edge so it cannot
  // leave a dark seam along the normalized screen's top or bottom border.
  const verticalInset = Math.max(2, Math.round(height * 0.002));
  const top = Math.max(0, Math.floor(bounds.topFraction * height) + verticalInset);
  const right = Math.min(width, Math.ceil(bounds.rightFraction * width));
  const bottom = Math.min(height, Math.ceil(bounds.bottomFraction * height) - verticalInset);
  if (right - left < width * 0.65 || bottom - top < height * 0.75) {
    throw new Error("Stitch phone has no usable app-screen interior");
  }
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Reframes a Stitch-rendered phone without changing its app design. The UI
 * pixels are proportionally scaled into a single, deterministic device shell;
 * a small center crop may be needed when Stitch varies its viewport ratio.
 */
export async function renderFixedPhonePresentation(sourcePng: Uint8Array): Promise<{
  body: Uint8Array;
  width: number;
  height: number;
}> {
  const source = await sharp(sourcePng).metadata();
  if (source.format !== "png" || !source.width || !source.height) {
    throw new Error("Fixed phone presentation requires a PNG with valid dimensions");
  }
  const frame = await verifyBlackPhoneFrame(sourcePng);
  if (!frame.valid || !frame.innerBounds) {
    throw new Error(`Stitch render has no usable phone screen: ${frame.reason}`);
  }

  const { width, height, phone, screen } = FIXED_PHONE_CANVAS;
  const interior = await sharp(sourcePng)
    .extract(imageBounds(frame.innerBounds, source.width, source.height))
    .resize(screen.width, screen.height, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  // Cover Stitch's variable Dynamic Island before drawing the canonical one.
  // Sample the surrounding status-bar background so the patch remains faithful
  // to the generated screen rather than introducing a hard-coded white block.
  const statusStrip = await sharp(interior)
    .extract({ left: 0, top: 0, width: screen.width, height: 100 })
    .removeAlpha()
    .raw()
    .toBuffer();
  const channels = [0, 1, 2].map((channel) => {
    const histogram = new Uint32Array(256);
    for (let offset = channel; offset < statusStrip.length; offset += 3) {
      const value = statusStrip[offset]!;
      histogram[value] = histogram[value]! + 1;
    }
    const halfway = statusStrip.length / 6;
    let count = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      count += histogram[value]!;
      if (count >= halfway) return value;
    }
    return 255;
  });
  const statusColor = `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const screenMask = Buffer.from(
    `<svg width="${screen.width}" height="${screen.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${screen.width}" height="${screen.height}" rx="${screen.radius}" fill="white"/>` +
      `</svg>`,
  );
  const clippedInterior = await sharp(interior)
    .ensureAlpha()
    .composite([{ input: screenMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const base = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="#f1efec"/>` +
      `<stop offset="1" stop-color="#e6e4e0"/></linearGradient>` +
      `<filter id="shadow" x="-30%" y="-20%" width="160%" height="150%">` +
      `<feGaussianBlur stdDeviation="18"/></filter></defs>` +
      `<rect width="100%" height="100%" fill="url(#bg)"/>` +
      `<rect x="${phone.left + 2}" y="${phone.top + 14}" width="${phone.width - 4}" ` +
      `height="${phone.height - 4}" rx="${phone.radius}" fill="#57534f" opacity=".28" filter="url(#shadow)"/>` +
      `<rect x="${phone.left}" y="${phone.top}" width="${phone.width}" height="${phone.height}" ` +
      `rx="${phone.radius}" fill="#090a0b" stroke="#363638" stroke-width="3"/>` +
      `</svg>`,
  );
  const island = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="300" y="60" width="336" height="100" fill="${statusColor}"/>` +
      `<rect x="365" y="80" width="206" height="58" rx="29" fill="#020203"/>` +
      `</svg>`,
  );
  const body = await sharp(base)
    .composite([
      { input: clippedInterior, left: screen.left, top: screen.top },
      { input: island, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  return { body: new Uint8Array(body), width, height };
}
