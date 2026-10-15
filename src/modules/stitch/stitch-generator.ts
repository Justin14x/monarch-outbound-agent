import sharp from "sharp";

import { renderMonarchStitchPrompt } from "../../config/stitch-prompt.js";
import {
  getServerStitchGateway,
  type StitchGateway,
  type StitchScreenMetadata,
} from "../../lib/stitch/server.js";
import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type { Json } from "../../types/database.generated.js";
import type {
  Prospect,
  UpdateProspectInput,
} from "../prospects/prospect.types.js";

const ASSET_BUCKET = "prospect-assets";
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

export interface StoredStitchScreen {
  height: number;
  project_id: string;
  screen_id: string;
  screen_name: string;
  stitch_html_url: string | null;
  stitch_screenshot_url: string;
  storage_path: string;
  width: number;
}

export interface StitchGenerationStore {
  listCandidates(options: {
    businessName?: string;
    includeFailed: boolean;
    limit: number;
  }): Promise<Prospect[]>;
  updateProspect(id: string, changes: UpdateProspectInput): Promise<void>;
  uploadScreenshot(path: string, body: Uint8Array): Promise<void>;
}

export interface StitchGenerationResult {
  businessName: string;
  error: string | null;
  projectId: string | null;
  screens: StoredStitchScreen[];
  status: "COMPLETE" | "FAILED";
  workflowStatus: "STITCH_COMPLETE" | "STITCH_FAILED" | "EMAIL_GENERATED";
}

export interface StitchGenerationBatchResult {
  complete: number;
  failed: number;
  processed: number;
  results: StitchGenerationResult[];
}

export interface GenerateStitchAppsOptions {
  businessName?: string;
  fetcher?: typeof fetch;
  forceNewProject?: boolean;
  gateway?: StitchGateway;
  includeFailed?: boolean;
  limit?: number;
  store?: StitchGenerationStore;
}

export class StitchGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StitchGenerationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Stitch generation error";
}

export function safeScreenId(screenId: string): string {
  const safe = screenId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) throw new StitchGenerationError("Stitch returned an invalid screen ID");
  return safe;
}

function previouslyStoredScreens(
  prospect: Prospect,
  projectId: string | null,
): StoredStitchScreen[] {
  if (!projectId || !Array.isArray(prospect.app_image_urls)) return [];
  const screens = prospect.app_image_urls;
  if (screens.length === 0) return [];
  const expectedPrefix = `prospects/${prospect.id}/stitch/`;
  if (!screens.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return value.project_id === projectId &&
      typeof value.screen_id === "string" &&
      typeof value.screen_name === "string" &&
      typeof value.stitch_screenshot_url === "string" &&
      typeof value.storage_path === "string" &&
      value.storage_path.startsWith(expectedPrefix) &&
      typeof value.width === "number" &&
      typeof value.height === "number";
  })) return [];
  return screens as unknown as StoredStitchScreen[];
}

export async function downloadPng(
  screen: StitchScreenMetadata,
  fetcher: typeof fetch,
): Promise<{ body: Uint8Array; height: number; width: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetcher(screen.screenshotUrl, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new StitchGenerationError(
        `Could not download Stitch screen ${screen.screenId}: HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_SCREENSHOT_BYTES) {
      throw new StitchGenerationError(
        `Stitch screen ${screen.screenId} exceeded the screenshot size limit`,
      );
    }
    const source = new Uint8Array(await response.arrayBuffer());
    if (source.byteLength === 0 || source.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new StitchGenerationError(
        `Stitch screen ${screen.screenId} returned an invalid screenshot size`,
      );
    }
    const image = sharp(source, {
      failOn: "warning",
      limitInputPixels: 50_000_000,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new StitchGenerationError(
        `Stitch screen ${screen.screenId} returned an invalid image`,
      );
    }
    if (metadata.width !== screen.width || metadata.height !== screen.height) {
      throw new StitchGenerationError(
        `Stitch screen ${screen.screenId} returned a ${metadata.width}x${metadata.height} thumbnail instead of the expected ${screen.width}x${screen.height} screenshot`,
      );
    }
    const body = metadata.format === "png"
      ? source
      : new Uint8Array(await image.png().toBuffer());
    if (body.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new StitchGenerationError(
        `Normalized Stitch screen ${screen.screenId} exceeded the screenshot size limit`,
      );
    }
    return { body, height: metadata.height, width: metadata.width };
  } catch (error) {
    if (error instanceof StitchGenerationError) throw error;
    throw new StitchGenerationError(
      `Could not retrieve Stitch screen ${screen.screenId}: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function createSupabaseStitchGenerationStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): StitchGenerationStore {
  return {
    async listCandidates({ businessName, includeFailed, limit }) {
      const eligibleStatuses = includeFailed
        ? businessName
          ? ["STITCH_PENDING", "STITCH_FAILED", "EMAIL_GENERATED"]
          : ["STITCH_PENDING", "STITCH_FAILED"]
        : ["STITCH_PENDING"];
      let query = client
        .from("prospects")
        .select("*")
        .in("workflow_status", eligibleStatuses)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (businessName) query = query.eq("business_name", businessName);
      const { data, error } = await query;
      if (error) {
        throw new StitchGenerationError(
          `Could not list Stitch generation candidates: ${error.message}`,
          { cause: error },
        );
      }
      return (data ?? []).filter(
        (prospect) =>
          prospect.workflow_status !== "EMAIL_GENERATED" ||
          prospect.stitch_status === "FAILED",
      );
    },

    async updateProspect(id, changes) {
      const { data, error } = await client
        .from("prospects")
        .update(changes)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new StitchGenerationError(
          `Could not update prospect ${id}: ${error.message}`,
          { cause: error },
        );
      }
      if (!data) throw new StitchGenerationError(`Prospect ${id} was not found`);
    },

    async uploadScreenshot(path, body) {
      const { error } = await client.storage.from(ASSET_BUCKET).upload(path, body, {
        cacheControl: "3600",
        contentType: "image/png",
        upsert: true,
      });
      if (error) {
        throw new StitchGenerationError(
          `Could not persist Stitch screenshot at ${path}: ${error.message}`,
          { cause: error },
        );
      }
    },
  };
}

async function processProspect(
  prospect: Prospect,
  store: StitchGenerationStore,
  gateway: StitchGateway,
  fetcher: typeof fetch,
  forceNewProject: boolean,
): Promise<StitchGenerationResult> {
  let projectId = forceNewProject ? null : prospect.stitch_project_id?.trim() || null;
  const preserveLaterWorkflow = prospect.workflow_status === "EMAIL_GENERATED";
  try {
    const existingScreens = previouslyStoredScreens(prospect, projectId);
    if (existingScreens.length > 0) {
      await store.updateProspect(prospect.id, {
        error_message: null,
        stitch_status: "COMPLETE",
        ...(!preserveLaterWorkflow ? { workflow_status: "STITCH_COMPLETE" as const } : {}),
      });
      return {
        businessName: prospect.business_name,
        error: null,
        projectId,
        screens: existingScreens,
        status: "COMPLETE",
        workflowStatus: preserveLaterWorkflow ? "EMAIL_GENERATED" : "STITCH_COMPLETE",
      };
    }
    const prompt = renderMonarchStitchPrompt(
      prospect.business_name,
      prospect.website,
    );

    await store.updateProspect(prospect.id, {
      error_message: null,
      stitch_prompt: prompt,
      stitch_status: "GENERATING",
      ...(!preserveLaterWorkflow ? { workflow_status: "STITCH_GENERATING" as const } : {}),
    });

    if (!projectId) {
      projectId = await gateway.createProject(`Monarch - ${prospect.business_name}`);
      await store.updateProspect(prospect.id, { stitch_project_id: projectId });
    }

    const screens = await gateway.generate({
      deviceType: "MOBILE",
      projectId,
      prompt,
    });

    if (screens.length === 0) {
      throw new StitchGenerationError("Stitch generation returned no screens");
    }

    const storedScreens: StoredStitchScreen[] = [];
    for (const [index, screen] of screens.entries()) {
      const image = await downloadPng(screen, fetcher);
      const storagePath = `prospects/${prospect.id}/stitch/${safeScreenId(screen.screenId)}.png`;
      await store.uploadScreenshot(storagePath, image.body);
      storedScreens.push({
        height: image.height,
        project_id: projectId,
        screen_id: screen.screenId,
        screen_name: screen.screenName ?? `Screen ${index + 1}`,
        stitch_html_url: screen.htmlUrl,
        stitch_screenshot_url: screen.screenshotUrl,
        storage_path: storagePath,
        width: image.width,
      });
    }

    await store.updateProspect(prospect.id, {
      app_image_urls: storedScreens as unknown as Json,
      error_message: null,
      stitch_project_id: projectId,
      stitch_status: "COMPLETE",
      ...(!preserveLaterWorkflow ? { workflow_status: "STITCH_COMPLETE" as const } : {}),
    });

    return {
      businessName: prospect.business_name,
      error: null,
      projectId,
      screens: storedScreens,
      status: "COMPLETE",
      workflowStatus: preserveLaterWorkflow ? "EMAIL_GENERATED" : "STITCH_COMPLETE",
    };
  } catch (error) {
    const reason = errorMessage(error).slice(0, 2_000);
    try {
      await store.updateProspect(prospect.id, {
        error_message: reason,
        retry_count: prospect.retry_count + 1,
        stitch_status: "FAILED",
        ...(!preserveLaterWorkflow ? { workflow_status: "STITCH_FAILED" as const } : {}),
      });
    } catch (updateError) {
      return {
        businessName: prospect.business_name,
        error: `${reason}; could not persist failure state: ${errorMessage(updateError)}`,
        projectId,
        screens: [],
        status: "FAILED",
        workflowStatus: preserveLaterWorkflow ? "EMAIL_GENERATED" : "STITCH_FAILED",
      };
    }
    return {
      businessName: prospect.business_name,
      error: reason,
      projectId,
      screens: [],
      status: "FAILED",
      workflowStatus: preserveLaterWorkflow ? "EMAIL_GENERATED" : "STITCH_FAILED",
    };
  }
}

export async function generateStitchApps(
  options: GenerateStitchAppsOptions = {},
): Promise<StitchGenerationBatchResult> {
  const limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new RangeError("limit must be an integer between 1 and 25");
  }
  if (options.forceNewProject && !options.businessName) {
    throw new Error("forceNewProject requires an exact businessName");
  }
  const store = options.store ?? createSupabaseStitchGenerationStore();
  const gateway = options.gateway ?? getServerStitchGateway();
  const prospects = await store.listCandidates({
    ...(options.businessName ? { businessName: options.businessName } : {}),
    includeFailed: options.includeFailed ?? false,
    limit,
  });
  const results: StitchGenerationResult[] = [];
  for (const prospect of prospects) {
    results.push(await processProspect(
      prospect,
      store,
      gateway,
      options.fetcher ?? fetch,
      options.forceNewProject ?? false,
    ));
  }
  return {
    complete: results.filter(({ status }) => status === "COMPLETE").length,
    failed: results.filter(({ status }) => status === "FAILED").length,
    processed: results.length,
    results,
  };
}

export function formatStitchGenerationResult(
  result: StitchGenerationBatchResult,
): string {
  const lines = [
    "STITCH GENERATION COMPLETE",
    "",
    `Processed: ${result.processed}`,
    `Complete: ${result.complete}`,
    `Failed: ${result.failed}`,
    "",
    "| Business | Stitch Project ID | Number of Screens | Workflow Status |",
    "|---|---|---:|---|",
  ];
  for (const row of result.results) {
    lines.push(
      `| ${row.businessName.replaceAll("|", "\\|")} | ${row.projectId ?? "—"} | ${row.screens.length} | ${row.workflowStatus} |`,
    );
    if (row.error) lines.push(`  Error: ${row.error}`);
  }
  lines.push(
    "",
    "| Screen Name | Screen ID | Supabase Screenshot Location |",
    "|---|---|---|",
  );
  for (const row of result.results) {
    for (const screen of row.screens) {
      lines.push(
        `| ${screen.screen_name.replaceAll("|", "\\|")} | ${screen.screen_id} | ${screen.storage_path} |`,
      );
    }
  }
  return lines.join("\n");
}
