import sharp from "sharp";

export interface PhoneFrameCheck {
  valid: boolean;
  reason: string | null;
  phoneWidthFraction: number | null;
  geometry: PhoneFrameGeometry | null;
  innerBounds: PhoneScreenBounds | null;
}

export interface PhoneScreenBounds {
  leftFraction: number;
  topFraction: number;
  rightFraction: number;
  bottomFraction: number;
}

export interface PhoneFrameGeometry {
  canvasAspectRatio: number;
  phoneWidthFraction: number;
  topMarginFraction: number;
  bottomMarginFraction: number;
  leftBezelFraction: number;
  rightBezelFraction: number;
  topBezelFraction: number;
  bottomBezelFraction: number;
}

const FRAME_MATCH_TOLERANCES: Readonly<Record<keyof PhoneFrameGeometry, number>> = {
  canvasAspectRatio: 0.015,
  phoneWidthFraction: 0.02,
  topMarginFraction: 0.008,
  bottomMarginFraction: 0.008,
  leftBezelFraction: 0.01,
  rightBezelFraction: 0.01,
  topBezelFraction: 0.01,
  bottomBezelFraction: 0.01,
};

const FRAME_LABELS: Readonly<Record<keyof PhoneFrameGeometry, string>> = {
  canvasAspectRatio: "canvas proportions",
  phoneWidthFraction: "phone width",
  topMarginFraction: "top canvas margin",
  bottomMarginFraction: "bottom canvas margin",
  leftBezelFraction: "left bezel thickness",
  rightBezelFraction: "right bezel thickness",
  topBezelFraction: "top bezel thickness",
  bottomBezelFraction: "bottom bezel thickness",
};

/**
 * The approved Home frame is thin, complete, and clear of the canvas edges.
 * These broad bounds reject a consistently cropped or heavy-rimmed set too.
 */
export function assertApprovedHomeFrame(geometry: PhoneFrameGeometry): void {
  if (geometry.topMarginFraction < 0.015 || geometry.bottomMarginFraction < 0.015) {
    throw new Error("Home / Discovery: phone must have visible neutral canvas above and below its complete outline");
  }
  const bezels = [
    geometry.leftBezelFraction,
    geometry.rightBezelFraction,
    geometry.topBezelFraction,
    geometry.bottomBezelFraction,
  ];
  if (bezels.some((fraction) => fraction < 0.012 || fraction > 0.045)) {
    throw new Error("Home / Discovery: phone outline is not the approved thin-bezel presentation");
  }
}

export function assertMatchingPhoneFrame(
  home: PhoneFrameGeometry,
  candidate: PhoneFrameGeometry,
  role: string,
): void {
  const differences = (Object.keys(FRAME_MATCH_TOLERANCES) as Array<keyof PhoneFrameGeometry>)
    .filter((key) => Math.abs(home[key] - candidate[key]) > FRAME_MATCH_TOLERANCES[key])
    .map((key) => FRAME_LABELS[key]);
  if (differences.length) {
    throw new Error(`${role}: phone outline differs from Home / Discovery in ${differences.join(", ")}`);
  }
}

/**
 * Fail closed when Stitch returns raw UI or a tiny phone on a landscape canvas.
 * This checks the rendered pixels; deviceType metadata is not a reliable proxy
 * for a visibly framed phone. It does not alter the image.
 */
export async function verifyBlackPhoneFrame(png: Uint8Array): Promise<PhoneFrameCheck> {
  const fail = (reason: string, phoneWidthFraction: number | null = null): PhoneFrameCheck => ({
    valid: false,
    reason,
    phoneWidthFraction,
    geometry: null,
    innerBounds: null,
  });
  const { data, info } = await sharp(png)
    .flatten({ background: "#ffffff" })
    .resize({ width: 400, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width / height > 0.75) {
    return fail("presentation canvas is not portrait-oriented");
  }
  const dark = (x: number, y: number): boolean => {
    const offset = (y * width + x) * channels;
    return Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!) < 95;
  };

  const centerTop = Math.floor(height * 0.15);
  const centerBottom = Math.floor(height * 0.85);
  const darkColumns: number[] = [];
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = centerTop; y < centerBottom; y += 1) {
      if (dark(x, y)) count += 1;
    }
    if (count / (centerBottom - centerTop) >= 0.65) darkColumns.push(x);
  }
  if (darkColumns.length < 6) return fail("continuous dark side bezels were not detected");
  const left = darkColumns[0]!;
  const right = darkColumns.at(-1)!;
  const span = right - left + 1;
  const phoneWidthFraction = span / width;
  if (phoneWidthFraction < 0.75 || left > width * 0.15 || right < width * 0.85) {
    return fail("phone is too small or not centered for an email showcase", phoneWidthFraction);
  }

  const rowDarkFraction = (y: number): number => {
    const from = left + Math.floor(span * 0.03);
    const to = right - Math.floor(span * 0.03);
    let count = 0;
    for (let x = from; x <= to; x += 1) {
      if (dark(x, y)) count += 1;
    }
    return count / (to - from + 1);
  };
  const topRows = Array.from({ length: Math.floor(height * 0.12) }, (_, y) => y)
    .filter((y) => rowDarkFraction(y) >= 0.45);
  const bottomStart = Math.floor(height * 0.88);
  const bottomRows = Array.from({ length: height - bottomStart }, (_, offset) => bottomStart + offset)
    .filter((y) => rowDarkFraction(y) >= 0.45);
  if (!topRows.length || !bottomRows.length) {
    return fail("complete black top and bottom hardware edges were not detected", phoneWidthFraction);
  }

  const top = topRows[0]!;
  const center = (left + right) / 2;
  let islandFound = false;
  const islandStart = top + Math.floor(height * 0.018);
  const islandEnd = Math.min(Math.floor(height * 0.13), top + Math.floor(height * 0.11));
  for (let y = islandStart; y < islandEnd && !islandFound; y += 1) {
    let runStart = -1;
    for (let x = left + Math.floor(span * 0.15); x <= right - Math.floor(span * 0.15) + 1; x += 1) {
      if (x <= right && dark(x, y)) {
        if (runStart === -1) runStart = x;
      } else if (runStart !== -1) {
        const runWidth = x - runStart;
        const runCenter = (x + runStart) / 2;
        if (runWidth >= span * 0.15 && runWidth <= span * 0.4 &&
          Math.abs(runCenter - center) <= span * 0.12) {
          islandFound = true;
          break;
        }
        runStart = -1;
      }
    }
  }
  if (!islandFound) return fail("centered black Dynamic Island was not detected", phoneWidthFraction);

  const bottom = bottomRows.at(-1)!;
  const middleY = Math.floor((top + bottom) / 2);
  const countDarkRun = (x: number, y: number, dx: number, dy: number, limit: number): number => {
    let count = 0;
    while (count < limit && x >= 0 && x < width && y >= 0 && y < height && dark(x, y)) {
      count += 1;
      x += dx;
      y += dy;
    }
    return count;
  };
  const sideSamples = [0.3, 0.5, 0.7].map((fraction) =>
    top + Math.floor((bottom - top) * fraction),
  );
  const median = (values: number[]): number => [...values].sort((a, b) => a - b)[1]!;
  const leftBezel = median(sideSamples.map((y) =>
    countDarkRun(left, y, 1, 0, Math.floor(span * 0.16)),
  ));
  const rightBezel = median(sideSamples.map((y) =>
    countDarkRun(right, y, -1, 0, Math.floor(span * 0.16)),
  ));
  const topBezel = countDarkRun(Math.floor(center), top, 0, 1, Math.floor(height * 0.12));
  const bottomBezel = countDarkRun(Math.floor(center), bottom, 0, -1, Math.floor(height * 0.12));
  if ([leftBezel, rightBezel, topBezel, bottomBezel].some((thickness) => thickness < 2)) {
    return fail("complete phone bezel thickness could not be measured", phoneWidthFraction);
  }
  return {
    valid: true,
    reason: null,
    phoneWidthFraction,
    innerBounds: {
      leftFraction: (left + leftBezel) / width,
      rightFraction: (right - rightBezel + 1) / width,
      topFraction: (top + topBezel) / height,
      bottomFraction: (bottom - bottomBezel + 1) / height,
    },
    geometry: {
      canvasAspectRatio: width / height,
      phoneWidthFraction,
      topMarginFraction: top / height,
      bottomMarginFraction: (height - 1 - bottom) / height,
      leftBezelFraction: leftBezel / span,
      rightBezelFraction: rightBezel / span,
      topBezelFraction: topBezel / span,
      bottomBezelFraction: bottomBezel / span,
    },
  };
}
