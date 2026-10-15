import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { loadServerStitchConfig } from "../../dist/config/stitch.js";
import { DirectStitchMcpConnection, getServerStitchGateway } from "../../dist/lib/stitch/server.js";

const sourceDirectory = join(process.cwd(), "output", "stitch-experiments", "skin-hub-v4-one-call-APtXf5");
const inputScreens = [
  { role: "Home", file: "4054840d77f0433ab2271513eafb7a25.png" },
  { role: "Booking", file: "297c8c867c3c4011bb7b42d501997e70.png" },
  { role: "Community", file: "4864f21bc91f4fde8f7e43900c75cbc0.png" },
];
const outputRoot = join(process.cwd(), "output", "stitch-experiments");
await mkdir(outputRoot, { recursive: true });
const outputDirectory = await mkdtemp(join(outputRoot, "skin-hub-frame-edit-portrait-"));

const gateway = getServerStitchGateway();
const projectId = await gateway.createProject("Monarch - isolated Skin Hub phone-frame edit");
const selectedScreenIds = [];
for (const screen of inputScreens) {
  const body = await readFile(join(sourceDirectory, screen.file));
  selectedScreenIds.push(await gateway.uploadReferenceImage(
    projectId,
    body,
    `Existing Skin Hub ${screen.role} UI - preserve interior exactly`,
  ));
}

const prompt = `Edit the THREE selected image screens in their given order. Return exactly THREE separate finished screen resources: Home, Booking, Community. This is a presentation-only phone-framing edit, NOT an app redesign.

PRESERVE THE EXISTING APP UI INSIDE EACH SCREEN: same business logo, typography, colors, photos, text, content structure, controls, and bottom navigation. Preserve each selected tab's position and appearance. Do not regenerate the UI, invent new content, rewrite copy, add cards, remove sections, or alter the navigation. Keep the supplied image as the visual source of truth for the interior.

ADD ONLY THE MISSING OUTER DEVICE: place the existing full app screen inside a realistic, complete, front-facing modern iPhone-style phone with a continuous BLACK rounded hardware body, a thin black bezel visible on ALL FOUR SIDES, and a centered black Dynamic Island at the top. The entire phone, including top and bottom edges, must be visible and centered on a simple light neutral PORTRAIT presentation canvas. The phone must be LARGE and readable, filling approximately 85–90% of the canvas width and 90–95% of its height. Leave only a narrow, comfortable margin around the device. Do not use a wide landscape canvas or render a tiny phone in the middle of empty background. Show the phone straight-on, not tilted or in perspective. Keep the same device scale, bezel thickness, Dynamic Island geometry, and portrait canvas size across all three outputs.

Do not paste the screenshot inside a second screen or create a nested phone. Do not crop the existing UI or let the bottom navigation fall outside the device. If the current status bar needs room for the Dynamic Island, make only the minimum spacing adjustment needed, without changing the app content. The output should look like the same approved three screenshots photographed inside matching BLACK phone hardware. Return three individual screen resources, not a collage.`;

await writeFile(join(outputDirectory, "request.json"), JSON.stringify({
  projectId,
  selectedScreenIds,
  deviceType: "MOBILE",
  prompt,
}, null, 2));

let editCalls = 0;
try {
  const connection = new DirectStitchMcpConnection(loadServerStitchConfig().apiKey);
  editCalls += 1;
  const response = await connection.callTool("edit_screens", {
    deviceType: "MOBILE",
    projectId,
    prompt,
    selectedScreenIds,
  });
  await writeFile(join(outputDirectory, "response.json"), JSON.stringify(response, null, 2));
  const outputComponents = response?.outputComponents;
  const screens = Array.isArray(outputComponents)
    ? outputComponents.flatMap((component) => component?.design?.screens ?? [])
    : [];
  const results = [];
  for (const [index, screen] of screens.entries()) {
    const name = screen?.name ?? screen?.id ?? null;
    const screenshotUrl = screen?.screenshot?.downloadUrl ?? null;
    const item = {
      title: screen?.title ?? null,
      name,
      deviceType: screen?.deviceType ?? null,
      width: screen?.width ?? null,
      height: screen?.height ?? null,
      screenshotUrl,
      localPng: null,
    };
    if (screenshotUrl) {
      const imageResponse = await fetch(screenshotUrl, { signal: AbortSignal.timeout(60_000) });
      if (!imageResponse.ok) throw new Error(`Screenshot ${index + 1} download failed: HTTP ${imageResponse.status}`);
      const body = Buffer.from(await imageResponse.arrayBuffer());
      const metadata = await sharp(body).metadata();
      if (metadata.format !== "png") throw new Error(`Screenshot ${index + 1} was not PNG`);
      const localPng = join(outputDirectory, `screen-${index + 1}.png`);
      await writeFile(localPng, body);
      item.localPng = localPng;
    }
    results.push(item);
  }
  console.log(JSON.stringify({ projectId, editCalls, outputDirectory, outputComponentTypes: Array.isArray(outputComponents)
    ? outputComponents.map((component) => Object.keys(component ?? {})) : [], screens: results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ projectId, editCalls, outputDirectory, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
