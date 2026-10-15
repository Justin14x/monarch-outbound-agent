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
  renderFixedPhonePresentation,
} from "./fixed-phone-presentation.js";
import {
  assertApprovedHomeFrame,
  assertMatchingPhoneFrame,
  verifyBlackPhoneFrame,
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
      if (error) throw new Error(`Could not upload ${path}: ${error.message}`);
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
        })
        .eq("id", manifest.prospectId)
        .eq("business_name", manifest.businessName)
        .eq("updated_at", manifest.originalUpdatedAt)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`Could not commit three screens: ${error.message}`);
      if (!data) throw new Error("Prospect changed since staging; no image list was updated");
    },
  };
}

async function persistPrepared(
  prepared: Array<{ body: Uint8Array; screen: StoredStitchScreen & { role: StitchScreenRole } }>,
  store: ThreeScreenStore,
): Promise<void> {
  for (const { body, screen } of prepared) {
    try {
      await store.uploadNew(screen.storage_path, body);
    } catch (uploadError) {
      // A previous interrupted stage may have saved this immutable screen ID.
      // Accept it only when the private object is byte-for-byte identical.
      const existing = await store.download(screen.storage_path).catch(() => null);
      if (!existing || hash(existing) !== hash(body)) throw uploadError;
    }
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
  const brand = await (options.brandResolver ?? discoverStitchBrandReference)({
    businessName: prospect.business_name,
    website: prospect.website,
  });
  // Keep each staged set isolated from older screens and experiments.
  const projectId = await gateway.createProject(`Monarch - ${prospect.business_name}`);
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
  // All three screens must arrive from exactly one generation response.
  const generated = await gateway.generate({ deviceType: "MOBILE", projectId, prompt });
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

  const manifest: ThreeScreenManifest = {
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
    originalUpdatedAt: prospect.updated_at,
    projectId,
    prospectId: prospect.id,
    prompts: [prompt],
    screens: screens.map((screen, index) => ({
      height: FIXED_PHONE_CANVAS.height,
      project_id: projectId,
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
  let homeFrame: PhoneFrameGeometry | null = null;
  for (const [index, screen] of screens.entries()) {
    const role = STITCH_THREE_SCREEN_ROLES[index]!;
    await options.onScreenGenerated?.(role, screen);
    const image = await downloadPng(screen, fetcher);
    if (image.width !== screen.width || image.height !== screen.height) {
      throw new Error(`${role}: downloaded PNG dimensions differ from Stitch metadata`);
    }
    const finalImage = await renderFixedPhonePresentation(image.body);
    const frame = await verifyBlackPhoneFrame(finalImage.body);
    if (!frame.valid || !frame.geometry) {
      throw new Error(`${role}: normalized PNG has no usable black phone outline: ${frame.reason}`);
    }
    if (index === 0) {
      assertApprovedHomeFrame(frame.geometry);
      homeFrame = frame.geometry;
    } else {
      assertMatchingPhoneFrame(homeFrame!, frame.geometry, role);
    }
    prepared.push({
      body: finalImage.body,
      screen: manifest.screens[index]!,
    });
  }
  // Nothing is stored until the one generation response and all PNGs pass.
  await persistPrepared(prepared, store);
  return manifest;
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
  const projectId = prospect.stitch_project_id?.trim();
  if (!projectId || new Set(screenIds).size !== 3) {
    throw new Error("Recovery needs one existing project and three distinct screen IDs");
  }
  const prepared: Array<{
    body: Uint8Array;
    screen: StoredStitchScreen & { role: StitchScreenRole };
  }> = [];
  const prompts: string[] = [];
  for (const [index, role] of STITCH_THREE_SCREEN_ROLES.entries()) {
    const metadata = await gateway.getScreen(projectId, screenIds[index]!);
    if (metadata.projectId !== projectId || metadata.screenId !== screenIds[index] ||
      metadata.width / metadata.height > MAX_WIDTH_TO_HEIGHT_RATIO ||
      metadata.height / metadata.width > MAX_HEIGHT_TO_WIDTH_RATIO ||
      (prepared.length > 0 && !sameCanvasShape(prepared[0]!.screen, metadata))) {
      throw new Error(`${role}: recovered Stitch screen failed resource or viewport checks`);
    }
    const image = await downloadPng(metadata, fetcher);
    prompts.push(renderThreeScreenPrompt({
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
    prepared.push({
      body: image.body,
      screen: {
        height: image.height,
        project_id: projectId,
        role,
        screen_id: metadata.screenId,
        screen_name: metadata.screenName ?? role,
        stitch_html_url: metadata.htmlUrl,
        stitch_screenshot_url: metadata.screenshotUrl,
        storage_path: `prospects/${prospect.id}/stitch/${safeScreenId(metadata.screenId)}.png`,
        width: image.width,
      },
    });
  }
  await persistPrepared(prepared, store);
  return {
    businessName: prospect.business_name,
    originalProjectId: prospect.stitch_project_id,
    originalUpdatedAt: prospect.updated_at,
    projectId,
    prospectId: prospect.id,
    prompts,
    screens: prepared.map(({ screen }) => screen),
    version: 1,
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
  for (const [index, screen] of manifest.screens.entries()) {
    const saved = await store.download(screen.storage_path);
    const metadata = await sharp(saved).metadata();
    if (metadata.format !== "png" || metadata.width !== screen.width || metadata.height !== screen.height) {
      throw new Error(`${screen.role}: stored PNG failed final verification`);
    }
    if (manifest.version >= 2) {
      if (manifest.version === 3 &&
        (screen.width !== FIXED_PHONE_CANVAS.width || screen.height !== FIXED_PHONE_CANVAS.height)) {
        throw new Error(`${screen.role}: stored PNG does not use the fixed presentation canvas`);
      }
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
