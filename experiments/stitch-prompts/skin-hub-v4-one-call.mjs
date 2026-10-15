import { basename, join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { getServerStitchGateway } from "../../dist/lib/stitch/server.js";
import { discoverStitchBrandReference } from "../../dist/modules/stitch/brand-reference.js";
import { stageThreeScreens } from "../../dist/modules/stitch/three-screen-generator.js";

const outputRoot = join(process.cwd(), "output", "stitch-experiments");
await mkdir(outputRoot, { recursive: true });
const outputDirectory = await mkdtemp(join(outputRoot, "skin-hub-black-phone-one-call-"));
const brand = await discoverStitchBrandReference({
  businessName: "Skin Hub Med Spa",
  website: "https://skinhubmedspa.com/",
});
console.log(JSON.stringify({
  brand: {
    logoConfidence: brand.logo?.confidence ?? null,
    logoSourceUrl: brand.logo?.sourceUrl ?? null,
    logoIssue: brand.logoIssue,
    primaryColor: brand.primaryColor,
    secondaryColor: brand.secondaryColor,
    paletteSourceUrl: brand.paletteSourceUrl,
  },
  outputDirectory,
}, null, 2));
if (!brand.logo || !brand.primaryColor) {
  throw new Error("Skin Hub test requires a verified official logo and website primary color before generation");
}

const stored = new Map();
const store = {
  async uploadNew(path, body) {
    const copy = new Uint8Array(body);
    stored.set(path, copy);
    await writeFile(join(outputDirectory, basename(path)), copy);
  },
  async download(path) {
    const copy = stored.get(path);
    if (!copy) throw new Error(`Local test asset missing: ${path}`);
    return copy;
  },
  async commit() {
    throw new Error("Isolated test must never commit to Supabase");
  },
};

const officialGateway = getServerStitchGateway();
let generationCalls = 0;
const gateway = {
  ...officialGateway,
  async generate(input) {
    generationCalls += 1;
    if (generationCalls !== 1) throw new Error("Isolated test permits exactly one generation call");
    return officialGateway.generate(input);
  },
};

try {
  const manifest = await stageThreeScreens({
    prospect: {
      business_name: "Skin Hub Med Spa",
      website: "https://skinhubmedspa.com/",
      id: "isolated-test-skin-hub",
      stitch_project_id: null,
      updated_at: "2026-10-09T00:00:00.000Z",
    },
    brandResolver: async () => brand,
    gateway,
    store,
    onPrepared: async (prepared) => {
      await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(prepared, null, 2));
      console.log(`Generated three resources; project ${prepared.projectId}; metadata saved`);
      for (const [index, screen] of prepared.screens.entries()) {
        const response = await fetch(screen.stitch_screenshot_url, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`Could not inspect candidate ${index + 1}: HTTP ${response.status}`);
        await writeFile(join(outputDirectory, `candidate-${index + 1}.png`),
          Buffer.from(await response.arrayBuffer()));
      }
    },
  });
  console.log(JSON.stringify({
    generationCalls,
    manifestPath: join(outputDirectory, "manifest.json"),
    projectId: manifest.projectId,
    screens: manifest.screens.map((screen) => ({
      role: screen.role,
      screenId: screen.screen_id,
      title: screen.screen_name,
      width: screen.width,
      height: screen.height,
      screenshotUrl: screen.stitch_screenshot_url,
      localPng: join(outputDirectory, basename(screen.storage_path)),
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    generationCalls,
    outputDirectory,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
