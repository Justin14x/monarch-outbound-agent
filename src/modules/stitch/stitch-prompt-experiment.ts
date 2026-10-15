import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getServerStitchGateway,
  type StitchGateway,
  type StitchScreenMetadata,
} from "../../lib/stitch/server.js";
import { downloadPng, safeScreenId } from "./stitch-generator.js";

export interface StitchExperimentScreen extends StitchScreenMetadata {
  localPath: string | null;
  pngSha256: string | null;
}

export interface StitchExperimentResult {
  deviceType: "MOBILE";
  outputDir: string;
  projectId: string;
  prompt: string;
  referenceImagePath?: string;
  referenceScreenId?: string;
  screens: StitchExperimentScreen[];
  status: "COMPLETE" | "FAILED";
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateExperimentPrompt(prompt: string): string {
  const cleaned = prompt.trim();
  if (cleaned.length < 40 || cleaned.length > 20_000 || cleaned.includes("\0")) {
    throw new Error("Experiment prompt must contain 40–20,000 characters of plain text");
  }
  return cleaned;
}

export async function runStitchPromptExperiment(options: {
  fetcher?: typeof fetch;
  gateway?: StitchGateway;
  outputDir: string;
  prompt: string;
  referenceImagePath?: string;
  title: string;
}): Promise<StitchExperimentResult> {
  const prompt = validateExperimentPrompt(options.prompt);
  const outputDir = path.resolve(options.outputDir);
  const gateway = options.gateway ?? getServerStitchGateway();
  const fetcher = options.fetcher ?? fetch;
  await mkdir(outputDir, { recursive: true });
  const projectId = await gateway.createProject(options.title);
  const result: StitchExperimentResult = {
    deviceType: "MOBILE",
    outputDir,
    projectId,
    prompt,
    ...(options.referenceImagePath ? { referenceImagePath: path.resolve(options.referenceImagePath) } : {}),
    screens: [],
    status: "FAILED",
  };
  const manifestPath = path.join(outputDir, "result.json");
  // Record the new project ID before generation; a failed call must not tempt
  // us to make another generation attempt merely to recover its identity.
  await writeFile(manifestPath, JSON.stringify(result, null, 2));
  try {
    // Exactly one generation or edit call. Reference experiments upload the
    // image to this isolated project first; neither path uses Supabase/Gmail.
    let screens: StitchScreenMetadata[];
    if (result.referenceImagePath) {
      if (!gateway.ensureHomeFrameworkReference || !gateway.editScreen) {
        throw new Error("Stitch gateway cannot upload and edit a reference image");
      }
      result.referenceScreenId = await gateway.ensureHomeFrameworkReference(
        projectId,
        result.referenceImagePath,
      );
      await writeFile(manifestPath, JSON.stringify(result, null, 2));
      screens = await gateway.editScreen({
        projectId,
        deviceType: "MOBILE",
        prompt,
        screenId: result.referenceScreenId,
      });
    } else {
      screens = await gateway.generate({ projectId, deviceType: "MOBILE", prompt });
    }
    if (screens.length === 0) {
      throw new Error("Stitch returned no screen resources");
    }
    result.screens = screens.map((screen) => ({ ...screen, localPath: null, pngSha256: null }));
    // Keep every returned screen ID and URL even if a later download fails.
    await writeFile(manifestPath, JSON.stringify(result, null, 2));
    for (const [index, screen] of screens.entries()) {
      const image = await downloadPng(screen, fetcher);
      const localPath = path.join(outputDir, `screen-${index + 1}-${safeScreenId(screen.screenId)}.png`);
      await writeFile(localPath, image.body);
      result.screens[index]!.localPath = localPath;
      result.screens[index]!.pngSha256 = createHash("sha256").update(image.body).digest("hex");
      await writeFile(manifestPath, JSON.stringify(result, null, 2));
    }
    result.status = "COMPLETE";
    await writeFile(manifestPath, JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    result.error = errorText(error);
    await writeFile(manifestPath, JSON.stringify(result, null, 2));
    throw new Error(`Stitch experiment failed in project ${projectId}: ${result.error}`, { cause: error });
  }
}
