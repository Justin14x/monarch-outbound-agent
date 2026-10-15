import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { getServerSupabaseClient } from "../../dist/lib/supabase/server.js";
import { renderFixedPhonePresentation, FIXED_PHONE_CANVAS } from "../../dist/modules/stitch/fixed-phone-presentation.js";
import { verifyBlackPhoneFrame, assertMatchingPhoneFrame } from "../../dist/modules/stitch/phone-frame-verifier.js";
import {
  commitThreeScreens,
  createSupabaseThreeScreenStore,
} from "../../dist/modules/stitch/three-screen-generator.js";

// This one-time promotion uses the exact Stitch resources and local PNGs the
// user visually approved. It never regenerates a screen or touches Gmail.
const BUSINESS = "Skin Hub Med Spa";
const PROSPECT_ID = "5f25bff2-11dd-4f19-b842-dc804ef1eea9";
const DRAFT_ID = "r2082983137942098642";
const PROJECT_ID = "9751653539473084782";
const SCREEN_IDS = [
  "aa74283198c14142b84182789902f6a8",
  "a194072e169541b1ae4a86e97cc67258",
  "fe1e2dc3284e4c47b6066fe10b5651c1",
];
const SOURCE_DIRECTORY = join(process.cwd(), "output", "stitch-experiments", "skin-hub-black-phone-one-call-JEVKzx");
const commit = process.argv.slice(2).includes("--commit");

const original = JSON.parse(await readFile(join(SOURCE_DIRECTORY, "manifest.json"), "utf8"));
if (original.projectId !== PROJECT_ID || original.businessName !== BUSINESS ||
  original.screens?.length !== 3 || original.prompts?.length !== 1 ||
  original.screens.some((screen, index) => screen.screen_id !== SCREEN_IDS[index])) {
  throw new Error("The approved Stitch source manifest has changed; no promotion was attempted");
}

const client = getServerSupabaseClient();
const { data: prospects, error } = await client.from("prospects").select("*")
  .eq("id", PROSPECT_ID).eq("business_name", BUSINESS).limit(2);
if (error || prospects?.length !== 1) throw new Error(`Exact Skin Hub prospect not found: ${error?.message ?? "missing"}`);
const prospect = prospects[0];
if (prospect.gmail_draft_id !== DRAFT_ID || prospect.workflow_status !== "DRAFT_CREATED" ||
  prospect.sent_at !== null || !prospect.email_verified) {
  throw new Error("Skin Hub draft/workflow state changed; no promotion was attempted");
}
const { data: bucket, error: bucketError } = await client.storage.getBucket("prospect-assets");
if (bucketError || !bucket || bucket.public) throw new Error("prospect-assets must remain a private bucket");

const prepared = [];
for (const [index, sourceScreen] of original.screens.entries()) {
  const raw = new Uint8Array(await readFile(join(SOURCE_DIRECTORY, `candidate-${index + 1}.png`)));
  const image = await renderFixedPhonePresentation(raw);
  const metadata = await sharp(image.body).metadata();
  if (metadata.format !== "png" || metadata.width !== FIXED_PHONE_CANVAS.width ||
    metadata.height !== FIXED_PHONE_CANVAS.height) {
    throw new Error(`${sourceScreen.role}: normalized PNG dimensions are incorrect`);
  }
  const frame = await verifyBlackPhoneFrame(image.body);
  if (!frame.valid || !frame.geometry) throw new Error(`${sourceScreen.role}: normalized phone frame was not detected`);
  if (index > 0) assertMatchingPhoneFrame(prepared[0].geometry, frame.geometry, sourceScreen.role);
  const digest = createHash("sha256").update(image.body).digest("hex");
  prepared.push({
    body: image.body,
    digest,
    geometry: frame.geometry,
    screen: {
      ...sourceScreen,
      height: image.height,
      width: image.width,
      project_id: PROJECT_ID,
      storage_path: `prospects/${PROSPECT_ID}/stitch/${SCREEN_IDS[index]}-fixed-${digest.slice(0, 12)}.png`,
    },
  });
}

const paths = prepared.map((item) => item.screen.storage_path);
console.log(JSON.stringify({
  mode: commit ? "COMMIT" : "DRY_RUN",
  business: BUSINESS,
  projectId: PROJECT_ID,
  draftId: DRAFT_ID,
  oldImagePaths: (prospect.app_image_urls ?? []).map((item) => item.storage_path),
  newImages: prepared.map((item) => ({
    role: item.screen.role,
    screenId: item.screen.screen_id,
    storagePath: item.screen.storage_path,
    width: item.screen.width,
    height: item.screen.height,
    sha256: item.digest,
  })),
}, null, 2));
if (!commit) process.exit(0);

// Save a local recovery snapshot before any external write. Old private
// Storage objects are retained and no upsert or delete operation is used.
await writeFile(join(SOURCE_DIRECTORY, "pre-promotion-skin-hub.json"), JSON.stringify({
  id: prospect.id,
  app_image_urls: prospect.app_image_urls,
  stitch_project_id: prospect.stitch_project_id,
  stitch_prompt: prospect.stitch_prompt,
  stitch_status: prospect.stitch_status,
  updated_at: prospect.updated_at,
}, null, 2));

const store = createSupabaseThreeScreenStore(client);
for (const item of prepared) {
  const existing = await store.download(item.screen.storage_path).catch(() => null);
  if (existing) {
    if (createHash("sha256").update(existing).digest("hex") !== item.digest) {
      throw new Error(`${item.screen.role}: existing private Storage copy differs from the approved local PNG`);
    }
  } else {
    await store.uploadNew(item.screen.storage_path, item.body);
  }
  const saved = await store.download(item.screen.storage_path);
  if (createHash("sha256").update(saved).digest("hex") !== item.digest) {
    throw new Error(`${item.screen.role}: private Storage copy differs from the approved local PNG`);
  }
}

if (JSON.stringify((prospect.app_image_urls ?? []).map((item) => item.storage_path)) !== JSON.stringify(paths)) {
  await commitThreeScreens({
    brand: original.brand,
    businessName: BUSINESS,
    originalProjectId: prospect.stitch_project_id,
    originalUpdatedAt: prospect.updated_at,
    projectId: PROJECT_ID,
    prospectId: PROSPECT_ID,
    prompts: original.prompts,
    screens: prepared.map((item) => item.screen),
    version: 3,
  }, store);
}

const { data: updated, error: verifyError } = await client.from("prospects")
  .select("id,business_name,app_image_urls,stitch_project_id,stitch_status,workflow_status,gmail_draft_id,sent_at")
  .eq("id", PROSPECT_ID).single();
if (verifyError || !updated || updated.stitch_project_id !== PROJECT_ID ||
  updated.stitch_status !== "COMPLETE" || updated.workflow_status !== "DRAFT_CREATED" ||
  updated.gmail_draft_id !== DRAFT_ID || updated.sent_at !== null ||
  JSON.stringify(updated.app_image_urls?.map((item) => item.storage_path)) !== JSON.stringify(paths)) {
  throw new Error(`Supabase promotion could not be verified: ${verifyError?.message ?? "state mismatch"}`);
}
console.log("SKIN HUB FIXED-FRAME IMAGES VERIFIED IN PRIVATE SUPABASE STORAGE; GMAIL UNCHANGED");
