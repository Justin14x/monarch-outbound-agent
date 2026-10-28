import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sharp from "sharp";

import {
  STITCH_BLACK_PHONE_PRESENTATION_IMAGE_PATH,
  STITCH_BOOKING_FRAMEWORK_IMAGE_PATH,
  STITCH_COMMUNITY_FRAMEWORK_IMAGE_PATH,
  STITCH_HOME_FRAMEWORK_IMAGE_PATH,
} from "../../config/stitch-home-framework.js";
import {
  renderThreeScreenPrompt,
  renderUnifiedThreeScreenPrompt,
  STITCH_THREE_SCREEN_ROLES,
  type StitchScreenRole,
} from "../../config/stitch-three-screen-prompts.js";
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
import type { Prospect } from "../prospects/prospect.types.js";
import {
  discoverStitchBrandReference,
  type StitchBrandReference,
} from "./brand-reference.js";
import {
  downloadPng,
  safeScreenId,
  type StoredStitchScreen,
} from "./stitch-generator.js";
import {
  FIXED_PHONE_CANVAS,
  fixedPhoneShellFingerprint,
  renderFixedPhonePresentation,
} from "./fixed-phone-presentation.js";
import {
  verifyBlackPhoneFrame,
  assertApprovedHomeFrame,
  assertMatchingPhoneFrame,
  type PhoneFrameGeometry,
} from "./phone-frame-verifier.js";

const BUCKET = "prospect-assets";
const MAX_HEIGHT_TO_WIDTH_RATIO = 2.7;
// The approved med-spa Home reference can render a portrait phone on a
// moderately wide presentation canvas (the v2 test returned 2560×2048).
const MAX_WIDTH_TO_HEIGHT_RATIO = 1.35;
const MAX_CANVAS_RATIO_DIFFERENCE = 0.08;

function assertPresentationCanvas(screen: StitchScreenMetadata, role: StitchScreenRole): void {
  if (screen.width / screen.height > MAX_WIDTH_TO_HEIGHT_RATIO) {
    throw new Error(`${role}: ${screen.width}×${screen.height} is too wide for a phone showcase`);
  }
  if (screen.height / screen.width > MAX_HEIGHT_TO_WIDTH_RATIO) {
    throw new Error(`${role}: ${screen.width}×${screen.height} is too tall for a single mobile viewport`);
  }
}

function sameCanvasShape(
  first: Pick<StitchScreenMetadata, "width" | "height">,
  next: Pick<StitchScreenMetadata, "width" | "height">,
): boolean {
  return Math.abs(first.width / first.height - next.width / next.height) <= MAX_CANVAS_RATIO_DIFFERENCE;
}

function orderThreeScreenResources(screens: StitchScreenMetadata[]): StitchScreenMetadata[] {
  if (screens.length !== STITCH_THREE_SCREEN_ROLES.length) {
    throw new Error(`Expected exactly three independent Stitch screens from one call; received ${screens.length}`);
  }
  const matchingNames: Array<(name: string) => boolean> = [
    (name) => /\bhome\b|discovery/i.test(name),
    (name) => /\bbooking\b|\bservices\b/i.test(name),
    (name) => /\bcommunity\b/i.test(name),
  ];
  const ordered = matchingNames.map((matches) => screens.filter((screen) =>
    matches(screen.screenName ?? ""),
  ));
  if (ordered.some((matches) => matches.length !== 1) ||
    new Set(ordered.map((matches) => matches[0]!.screenId)).size !== 3) {
    throw new Error("Stitch did not clearly label independent Home, Booking, and Community screens");
  }
  return ordered.map((matches) => matches[0]!);
}

export interface ThreeScreenManifest {
  attemptStartedAt?: string;
  brand?: {
    logoIssue: string | null;
    logoReferenceId: string | null;
    logoSourceUrl: string | null;
    paletteSourceUrl: string | null;
    primaryColor: string | null;
    secondaryColor: string | null;
  };
  businessName: string;
  originalProjectId: string | null;
  originalUpdatedAt: string;
  projectId: string;
  prospectId: string;
  prompts: string[];
  screens: Array<StoredStitchScreen & { role: StitchScreenRole }>;
  version: 1 | 2 | 3;
}

export interface ThreeScreenStore {
  uploadNew(path: string, body: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  commit(manifest: ThreeScreenManifest): Promise<void>;
  recordAttempt?(prospect: Prospect, attempt: StitchAttempt, expectedUpdatedAt: string): Promise<string>;
}

export interface StitchAttempt {
  phase: string;
  project_id: string | null;
  started_at: string;
  elapsed_ms: number;
  prompt?: string;
  validated: boolean;
  screens: Array<{
    role: string | null;
    screen_id: string;
    screenshot_url: string;
    width: number;
    height: number;
  }>;
  error?: string;
}

function hash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createSupabaseThreeScreenStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): ThreeScreenStore {
  return {
    async uploadNew(path, body) {
      const { error } = await client.storage.from(BUCKET).upload(path, body, {
        contentType: "image/png",
        upsert: false,
      });
      if (error) throw new Error(`Could not upload ${path}: ${error.message}`, { cause: error });
    },
    async download(path) {
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error || !data) {
        throw new Error(`Could not verify private Storage object ${path}: ${error?.message ?? "empty response"}`);
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async commit(manifest) {
      const { data, error } = await client.from("prospects")
        .update({
          app_image_urls: manifest.screens as unknown as Json,
          stitch_project_id: manifest.projectId,
          stitch_prompt: manifest.version >= 2
            ? manifest.prompts[0]!
            : manifest.prompts.map((prompt, index) =>
              `Screen ${index + 1} — ${STITCH_THREE_SCREEN_ROLES[index]}\n${prompt}`,
            ).join("\n\n"),
          stitch_status: "COMPLETE",
          ...(manifest.version === 3 ? { stitch_attempt: {
            phase: "COMPLETE",
            project_id: manifest.projectId,
            started_at: manifest.attemptStartedAt ?? null,
            elapsed_ms: manifest.attemptStartedAt
              ? Math.max(0, Date.now() - Date.parse(manifest.attemptStartedAt)) : null,
            validated: true,
            screens: manifest.screens.map((screen) => ({
              role: screen.role, screen_id: screen.screen_id,
              screenshot_url: screen.stitch_screenshot_url,
              width: screen.width, height: screen.height,
            })),
          } as Json } : {}),
        })
        .eq("id", manifest.prospectId)
        .eq("business_name", manifest.businessName)
        .eq("updated_at", manifest.originalUpdatedAt)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`Could not commit three screens: ${error.message}`);
      if (!data) throw new Error("Prospect changed since staging; no image list was updated");
    },
    async recordAttempt(prospect, attempt, expectedUpdatedAt) {
      const { data, error } = await client.from("prospects")
        .update({ stitch_attempt: attempt as unknown as Json })
        .eq("id", prospect.id)
        .eq("updated_at", expectedUpdatedAt)
        .select("updated_at")
        .maybeSingle();
      if (error) throw new Error(`Could not record Stitch attempt: ${error.message}`);
      if (!data) throw new Error("Prospect changed during Stitch staging; no attempt state was updated");
      return data.updated_at;
    },
  };
}

function isTransientStorageError(error: unknown): boolean {
  const source = error instanceof Error ? (error.cause ?? error) : error;
  const status = typeof source === "object" && source !== null && "statusCode" in source
    ? Number(source.statusCode) : null;
  if (status !== null && Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP (?:408|429|5\d\d)/i.test(message);
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function persistPrepared(
  prepared: Array<{ body: Uint8Array; screen: StoredStitchScreen & { role: StitchScreenRole } }>,
  store: ThreeScreenStore,
  onPhase?: (phase: string) => void,
): Promise<void> {
  for (const { body, screen } of prepared) {
    onPhase?.(`${screen.role} STORAGE_UPLOAD`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await store.uploadNew(screen.storage_path, body);
        break;
      } catch (uploadError) {
        // The response can be lost after a successful upload. Never overwrite:
        // accept an existing object only when its bytes are identical.
        const existing = await store.download(screen.storage_path).catch(() => null);
        if (existing && hash(existing) === hash(body)) break;
        if (!isTransientStorageError(uploadError) || attempt === 2) throw uploadError;
        await wait(250 * 2 ** attempt);
      }
    }
    onPhase?.(`${screen.role} STORAGE_VERIFY`);
    const saved = await store.download(screen.storage_path);
    if (hash(saved) !== hash(body)) {
      throw new Error(`${screen.role}: Storage copy does not match the generated PNG`);
    }
    const metadata = await sharp(saved).metadata();
    if (metadata.format !== "png" || metadata.width !== screen.width || metadata.height !== screen.height) {
      throw new Error(`${screen.role}: saved PNG dimensions do not match the staged canvas`);
    }
  }
}

export async function stageThreeScreens(options: {
  brandResolver?: (input: { businessName: string; website: string }) => Promise<StitchBrandReference>;
  fetcher?: typeof fetch;
  gateway?: StitchGateway;
  onPrepared?: (manifest: ThreeScreenManifest) => Promise<void>;
  onScreenGenerated?: (role: StitchScreenRole, screen: StitchScreenMetadata) => Promise<void>;
  prospect: Prospect;
  store?: ThreeScreenStore;
}): Promise<ThreeScreenManifest> {
  const { prospect } = options;
  const gateway = options.gateway ?? getServerStitchGateway();
  const store = options.store ?? createSupabaseThreeScreenStore();
  const fetcher = options.fetcher ?? fetch;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let phase = "BRAND_REFERENCE";
  let projectId: string | null = null;
  let updatedAt = prospect.updated_at;
  let attemptScreens: StitchAttempt["screens"] = [];
  let attemptPrompt: string | null = null;
  let screensValidated = false;
  const record = async (recordPhase: string, error?: string) => {
    if (!store.recordAttempt) return;
    updatedAt = await store.recordAttempt(prospect, {
      phase: recordPhase,
      project_id: projectId,
      started_at: startedAt,
      elapsed_ms: Date.now() - started,
      screens: attemptScreens,
      validated: screensValidated,
      ...(attemptPrompt ? { prompt: attemptPrompt } : {}),
      ...(error ? { error } : {}),
    }, updatedAt);
  };
  try {
  const brand = await (options.brandResolver ?? discoverStitchBrandReference)({
    businessName: prospect.business_name,
    website: prospect.website,
  });
  // Keep each staged set isolated from older screens and experiments.
  phase = "PROJECT_CREATE";
  projectId = await gateway.createProject(`Monarch - ${prospect.business_name}`);
  await record("PROJECT_CREATED");
  phase = "REFERENCE_UPLOAD";
  if (!gateway.uploadReferenceImage) {
    throw new Error("Stitch gateway cannot upload the layout and official-logo references");
  }
  const homeReferenceId = await gateway.uploadReferenceImage(
    projectId,
    await readFile(STITCH_HOME_FRAMEWORK_IMAGE_PATH),
    "Monarch Home layout reference - not prospect branding",
  );
  const bookingReferenceId = await gateway.uploadReferenceImage(
    projectId,
    await readFile(STITCH_BOOKING_FRAMEWORK_IMAGE_PATH),
    "Monarch Booking body layout reference - not prospect branding",
  );
  const communityReferenceId = await gateway.uploadReferenceImage(
    projectId,
    await readFile(STITCH_COMMUNITY_FRAMEWORK_IMAGE_PATH),
    "Monarch Community feed body layout reference - not navigation or prospect branding",
  );
  const phoneReferenceId = await gateway.uploadReferenceImage(
    projectId,
    await readFile(STITCH_BLACK_PHONE_PRESENTATION_IMAGE_PATH),
    "Monarch black phone hardware presentation reference - not app UI or branding",
  );
  const logoBytes = brand.logo
    ? brand.logo.contentType === "image/png"
      ? brand.logo.body
      : new Uint8Array(await sharp(brand.logo.body).png().toBuffer())
    : null;
  const logoReferenceId = logoBytes
    ? await gateway.uploadReferenceImage(
      projectId,
      logoBytes,
      `Official ${prospect.business_name} logo from ${brand.logo!.sourceUrl}`,
    )
    : null;
  const prompt = renderUnifiedThreeScreenPrompt({
    businessName: prospect.business_name,
    website: prospect.website,
    homeReferenceId,
    bookingReferenceId,
    communityReferenceId,
    phoneReferenceId,
    ...(logoReferenceId && brand.logo ? {
      logoReferenceId,
      logoSourceUrl: brand.logo.sourceUrl,
    } : {}),
    ...(brand.primaryColor ? { primaryColor: brand.primaryColor } : {}),
    ...(brand.secondaryColor ? { secondaryColor: brand.secondaryColor } : {}),
    ...(brand.paletteSourceUrl ? { paletteSourceUrl: brand.paletteSourceUrl } : {}),
  });
  attemptPrompt = prompt;
  // All three screens must arrive from exactly one generation response.
  phase = "GENERATE";
  const generated = await gateway.generate({ deviceType: "MOBILE", projectId, prompt });
  attemptScreens = generated.map((screen) => ({
    role: screen.screenName,
    screen_id: screen.screenId,
    screenshot_url: screen.screenshotUrl,
    width: screen.width,
    height: screen.height,
  }));
  await record("SCREENS_RETURNED");
  phase = "SCREEN_VALIDATE";
  const screens = orderThreeScreenResources(generated);
  const seenIds = new Set<string>();
  for (const [index, screen] of screens.entries()) {
    const role = STITCH_THREE_SCREEN_ROLES[index]!;
    if (screen.projectId !== projectId || seenIds.has(screen.screenId)) {
      throw new Error(`${role}: Stitch returned a duplicate screen ID or the wrong project`);
    }
    seenIds.add(screen.screenId);
    assertPresentationCanvas(screen, role);
    if (index > 0 && !sameCanvasShape(screens[0]!, screen)) {
      throw new Error(`${role}: canvas shape differs from Home / Discovery`);
    }
  }
  attemptScreens = screens.map((screen, index) => ({
    role: STITCH_THREE_SCREEN_ROLES[index]!,
    screen_id: screen.screenId,
    screenshot_url: screen.screenshotUrl,
    width: screen.width,
    height: screen.height,
  }));
  screensValidated = true;
  await record("SCREENS_VALIDATED");

  const manifest: ThreeScreenManifest = {
    attemptStartedAt: startedAt,
    brand: {
      logoIssue: brand.logoIssue,
      logoReferenceId,
      logoSourceUrl: brand.logo?.sourceUrl ?? null,
      paletteSourceUrl: brand.paletteSourceUrl,
      primaryColor: brand.primaryColor,
      secondaryColor: brand.secondaryColor,
    },
    businessName: prospect.business_name,
    originalProjectId: prospect.stitch_project_id,
    originalUpdatedAt: updatedAt,
    projectId,
    prospectId: prospect.id,
    prompts: [prompt],
    screens: screens.map((screen, index) => ({
      height: FIXED_PHONE_CANVAS.height,
      project_id: projectId!,
      role: STITCH_THREE_SCREEN_ROLES[index]!,
      screen_id: screen.screenId,
      screen_name: screen.screenName ?? STITCH_THREE_SCREEN_ROLES[index]!,
      stitch_html_url: screen.htmlUrl,
      stitch_screenshot_url: screen.screenshotUrl,
      storage_path: `prospects/${prospect.id}/stitch/${safeScreenId(screen.screenId)}.png`,
      width: FIXED_PHONE_CANVAS.width,
    })),
    version: 3,
  };
  // Capture all IDs and signed URLs before a download or Storage issue.
  await options.onPrepared?.(manifest);
  const prepared: Array<{
    body: Uint8Array;
    screen: StoredStitchScreen & { role: StitchScreenRole };
  }> = [];
  let homeShellFingerprint: string | null = null;
  for (const [index, screen] of screens.entries()) {
    const role = STITCH_THREE_SCREEN_ROLES[index]!;
    await options.onScreenGenerated?.(role, screen);
    phase = `${role} SCREEN_DOWNLOAD`;
    const image = await downloadPng(screen, fetcher);
    if (image.width !== screen.width || image.height !== screen.height) {
      throw new Error(`${role}: downloaded PNG dimensions differ from Stitch metadata`);
    }
    phase = `${role} FRAME_RENDER`;
    const finalImage = await renderFixedPhonePresentation(image.body);
    const fingerprint = await fixedPhoneShellFingerprint(finalImage.body);
    if (index === 0) homeShellFingerprint = fingerprint;
    else if (fingerprint !== homeShellFingerprint) {
      throw new Error(`${role}: fixed phone shell differs from Home / Discovery`);
    }
    prepared.push({
      body: finalImage.body,
      screen: manifest.screens[index]!,
    });
  }
  // Nothing is stored until the one generation response and all PNGs pass.
  await persistPrepared(prepared, store, (nextPhase) => { phase = nextPhase; });
  await record("ASSETS_STORED");
  manifest.originalUpdatedAt = updatedAt;
  return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "GENERATE" && projectId && /abort|timeout/i.test(message)) {
      // Read-only reconciliation after an ambiguous timeout. Reference uploads
      // may also appear in this list; never treat these as a valid three-screen set.
      try {
        const observed = await gateway.listScreens(projectId);
        attemptScreens = observed.map((screen) => ({
          role: screen.screenName, screen_id: screen.screenId,
          screenshot_url: screen.screenshotUrl,
          width: screen.width, height: screen.height,
        }));
      } catch { /* Preserve the original timeout for controlled manual recovery. */ }
    }
    let recordIssue = "";
    try { await record("FAILED", `${phase}: ${message}`); }
    catch (recordError) {
      recordIssue = `; attempt logging failed: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
    }
    throw new Error(`Stitch ${phase} failed after ${Date.now() - started}ms: ${message}${recordIssue}`, { cause: error });
  }
}

// Recover resources from a completed generation whose Storage upload failed.
// This path performs get_screen reads only; it never invokes generation.
export async function stageExistingThreeScreens(options: {
  fetcher?: typeof fetch;
  gateway?: StitchGateway;
  prospect: Prospect;
  screenIds: readonly [string, string, string];
  store?: ThreeScreenStore;
}): Promise<ThreeScreenManifest> {
  const { prospect, screenIds } = options;
  const gateway = options.gateway ?? getServerStitchGateway();
  if (!gateway.getScreen) throw new Error("Stitch gateway cannot retrieve existing screens");
  const store = options.store ?? createSupabaseThreeScreenStore();
  const fetcher = options.fetcher ?? fetch;
  const attempt = prospect.stitch_attempt && typeof prospect.stitch_attempt === "object" &&
    !Array.isArray(prospect.stitch_attempt) ? prospect.stitch_attempt : null;
  const attemptScreens = attempt?.screens;
  const matchesAttempt = Array.isArray(attemptScreens) && screenIds.every((id) =>
    attemptScreens.some((item) => item && typeof item === "object" &&
      !Array.isArray(item) && item.screen_id === id));
  const attemptProjectId = matchesAttempt && typeof attempt?.project_id === "string"
    ? attempt.project_id.trim() : null;
  const projectId = attemptProjectId || prospect.stitch_project_id?.trim();
  const attemptPrompt = matchesAttempt && typeof attempt?.prompt === "string"
    ? attempt.prompt : null;
  if (attemptProjectId && (attempt?.validated !== true || !attemptPrompt)) {
    throw new Error("Recorded Stitch attempt was not validated for recovery");
  }
  const useFixedPresentation = Boolean(attemptProjectId && attemptPrompt && attempt?.validated === true);
  if (!projectId || new Set(screenIds).size !== 3) {
    throw new Error("Recovery needs one existing project and three distinct screen IDs");
  }
  const prepared: Array<{
    body: Uint8Array;
    screen: StoredStitchScreen & { role: StitchScreenRole };
  }> = [];
  const prompts: string[] = [];
  let firstSource: StitchScreenMetadata | null = null;
  let homeShellFingerprint: string | null = null;
  for (const [index, role] of STITCH_THREE_SCREEN_ROLES.entries()) {
    const metadata = await gateway.getScreen(projectId, screenIds[index]!);
    if (metadata.projectId !== projectId || metadata.screenId !== screenIds[index] ||
      metadata.width / metadata.height > MAX_WIDTH_TO_HEIGHT_RATIO ||
      metadata.height / metadata.width > MAX_HEIGHT_TO_WIDTH_RATIO ||
      (firstSource && !sameCanvasShape(firstSource, metadata))) {
      throw new Error(`${role}: recovered Stitch screen failed resource or viewport checks`);
    }
    firstSource ??= metadata;
    const image = await downloadPng(metadata, fetcher);
    if (!useFixedPresentation) prompts.push(renderThreeScreenPrompt({
      businessName: prospect.business_name,
      ...(prepared[0] ? { firstScreenReference: {
        screenId: prepared[0].screen.screen_id,
        screenshotUrl: prepared[0].screen.stitch_screenshot_url,
        width: prepared[0].screen.width,
        height: prepared[0].screen.height,
      } } : {}),
      previousScreenIds: screenIds.slice(0, index),
      role,
      website: prospect.website,
    }));
    const finalImage = useFixedPresentation
      ? await renderFixedPhonePresentation(image.body)
      : image;
    if (useFixedPresentation) {
      const fingerprint = await fixedPhoneShellFingerprint(finalImage.body);
      if (index === 0) homeShellFingerprint = fingerprint;
      else if (fingerprint !== homeShellFingerprint) {
        throw new Error(`${role}: fixed phone shell differs from Home / Discovery`);
      }
    }
    prepared.push({
      body: finalImage.body,
      screen: {
        height: finalImage.height,
        project_id: projectId,
        role,
        screen_id: metadata.screenId,
        screen_name: metadata.screenName ?? role,
        stitch_html_url: metadata.htmlUrl,
        stitch_screenshot_url: metadata.screenshotUrl,
        storage_path: `prospects/${prospect.id}/stitch/${safeScreenId(metadata.screenId)}.png`,
        width: finalImage.width,
      },
    });
  }
  await persistPrepared(prepared, store);
  return {
    ...(useFixedPresentation && typeof attempt?.started_at === "string"
      ? { attemptStartedAt: attempt.started_at } : {}),
    businessName: prospect.business_name,
    originalProjectId: prospect.stitch_project_id,
    originalUpdatedAt: prospect.updated_at,
    projectId,
    prospectId: prospect.id,
    prompts: useFixedPresentation ? [attemptPrompt!] : prompts,
    screens: prepared.map(({ screen }) => screen),
    version: useFixedPresentation ? 3 : 1,
  };
}

export async function commitThreeScreens(
  manifest: ThreeScreenManifest,
  store: ThreeScreenStore = createSupabaseThreeScreenStore(),
): Promise<void> {
  if ((manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3) ||
    manifest.screens.length !== 3 ||
    manifest.prompts.length !== (manifest.version >= 2 ? 1 : 3) ||
    manifest.screens.some((screen, index) =>
      screen.role !== STITCH_THREE_SCREEN_ROLES[index] ||
      screen.project_id !== manifest.projectId ||
      !screen.storage_path.startsWith(`prospects/${manifest.prospectId}/stitch/`)
    )) {
    throw new Error("Invalid three-screen manifest; no prospect was updated");
  }
  let homeFrame: PhoneFrameGeometry | null = null;
  let homeShellFingerprint: string | null = null;
  for (const [index, screen] of manifest.screens.entries()) {
    const saved = await store.download(screen.storage_path);
    const metadata = await sharp(saved).metadata();
    if (metadata.format !== "png" || metadata.width !== screen.width || metadata.height !== screen.height) {
      throw new Error(`${screen.role}: stored PNG failed final verification`);
    }
    if (manifest.version === 3) {
      const fingerprint = await fixedPhoneShellFingerprint(saved);
      if (index === 0) homeShellFingerprint = fingerprint;
      else if (fingerprint !== homeShellFingerprint) {
        throw new Error(`${screen.role}: fixed phone shell differs from Home / Discovery`);
      }
    } else if (manifest.version === 2) {
      const frame = await verifyBlackPhoneFrame(saved);
      if (!frame.valid || !frame.geometry) {
        throw new Error(`${screen.role}: stored PNG has no usable black phone outline: ${frame.reason}`);
      }
      if (index === 0) {
        assertApprovedHomeFrame(frame.geometry);
        homeFrame = frame.geometry;
      } else {
        assertMatchingPhoneFrame(homeFrame!, frame.geometry, screen.role);
      }
    }
  }
  await store.commit(manifest);
}
