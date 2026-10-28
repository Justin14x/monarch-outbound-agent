import { randomUUID } from "node:crypto";
import sharp from "sharp";

import type { GmailDraftGateway } from "../../lib/gmail/server.js";
import { withGmailDraftLock } from "../../lib/gmail/draft-lock.js";
import { GMAIL_SENDER_DISPLAY_NAME } from "../../config/gmail.js";
import {
  MONARCH_OUTREACH_PLAIN_VISUAL_SENTENCE,
  MONARCH_OUTREACH_SIGNATURE_LABEL,
  MONARCH_OUTREACH_SIGNATURE_URL,
  MONARCH_OUTREACH_VISUAL_SENTENCE,
} from "../../config/outreach-email-template.js";
import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type { Prospect } from "../prospects/prospect.types.js";

export interface GmailDraftStore {
  listCandidates(options: {
    businessName: string;
    limit: number;
  }): Promise<Prospect[]>;
  saveDraftId(id: string, draftId: string): Promise<void>;
  markDraftCreated(id: string, draftId: string): Promise<void>;
}

export interface GmailConceptImageStore {
  downloadEmailImage(path: string): Promise<Buffer>;
}

export interface GmailDraftResult {
  businessName: string;
  draftId: string | null;
  error: string | null;
  status: "CREATED" | "RECOVERED" | "FAILED";
}

export interface GmailDraftBatchResult {
  created: number;
  recovered: number;
  failed: number;
  processed: number;
  results: GmailDraftResult[];
}

export interface CreateGmailDraftsOptions {
  businessName: string;
  limit?: number;
  store?: GmailDraftStore;
  gateway?: GmailDraftGateway;
  senderEmail?: string;
  imageStore?: GmailConceptImageStore;
}

export class GmailDraftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GmailDraftError";
  }
}

export function validEmail(value: string): boolean {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/i.test(value) &&
    !/[\r\n\x00-\x1f\x7f]/.test(value);
}

function headerValue(value: string, name: string): string {
  if (!value.trim() || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new GmailDraftError(`${name} is empty or contains invalid header characters`);
  }
  return /^[\x20-\x7e]+$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([255, 216, 255]);
const MAX_INLINE_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_INLINE_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_SHOWCASE_SCREENS = 3;
const SHOWCASE_WIDTH = 1800;
const SHOWCASE_PADDING = 60;
const SHOWCASE_GAP = 30;
const SHOWCASE_SCREEN_WIDTH = Math.floor((SHOWCASE_WIDTH - 2 * SHOWCASE_PADDING - 2 * SHOWCASE_GAP) / 3);
const DEFAULT_SIGNATURE_LOGO_URL =
  "https://raw.githubusercontent.com/Justin14x/monarch-outbound-agent/4b8c841637aee6cc1036cb642fc7e8e1942c5ada/assets/monarch-systems-logo.png";

export function hasMonarchSignatureLine(body: string): boolean {
  return body.replace(/\r\n|\r/g, "\n").trimEnd().endsWith(`\n${MONARCH_OUTREACH_SIGNATURE_LABEL}`);
}

function validatedSignatureLogoUrl(value: string | null | undefined): string | null {
  value = value?.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new GmailDraftError("MONARCH_SIGNATURE_LOGO_URL must be an HTTPS image URL"); }
  const ownedWebsite = ["monarchsystems.app", "www.monarchsystems.app"].includes(url.hostname);
  const pinnedRepositoryAsset = url.toString() === DEFAULT_SIGNATURE_LOGO_URL;
  if (url.protocol !== "https:" || (!ownedWebsite && !pinnedRepositoryAsset) ||
      url.username || url.password || url.search || url.hash) {
    throw new GmailDraftError("MONARCH_SIGNATURE_LOGO_URL must be a stable HTTPS URL on monarchsystems.app");
  }
  return url.toString();
}

export function monarchSignatureLogoUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  return validatedSignatureLogoUrl(environment.MONARCH_SIGNATURE_LOGO_URL?.trim() || DEFAULT_SIGNATURE_LOGO_URL);
}

export function findConceptImagePaths(prospect: Prospect): string[] {
  if (!Array.isArray(prospect.app_image_urls)) return [];
  const prefix = `prospects/${prospect.id}/stitch/`;
  const valid = prospect.app_image_urls.filter((item): item is {
    screen_id: string;
    screen_name?: string;
    storage_path: string;
  } => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return typeof item.screen_id === "string" && item.screen_id.trim().length > 0 &&
      typeof item.storage_path === "string" &&
      item.storage_path.startsWith(prefix) &&
      /^[a-zA-Z0-9_-]+\.png$/.test(item.storage_path.slice(prefix.length));
  });
  const home = valid.find((item) => typeof item.screen_name === "string" && item.screen_name.toLowerCase() === "home");
  const ordered = home ? [home, ...valid.filter((item) => item !== home)] : valid;
  return [...new Set(ordered.map((item) => item.storage_path))].slice(0, MAX_SHOWCASE_SCREENS);
}

export function findConceptImagePath(prospect: Prospect): string | null {
  return findConceptImagePaths(prospect)[0] ?? null;
}

export function createSupabaseGmailConceptImageStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): GmailConceptImageStore {
  return {
    async downloadEmailImage(path) {
      const { data, error } = await client.storage.from("prospect-assets").download(path);
      if (error || !data) {
        throw new GmailDraftError(`Could not download Stitch app image: ${error?.message ?? "image missing"}`);
      }
      if (data.size > MAX_INLINE_IMAGE_BYTES) {
        throw new GmailDraftError("Stitch app image is too large for an inline Gmail draft");
      }
      // The stored PNG remains untouched. Email displays each screen at 188px,
      // so 564px provides a sharp 3x source without embedding the full render.
      return optimizeEmailScreenshot(Buffer.from(await data.arrayBuffer()));
    },
  };
}

export async function optimizeEmailScreenshot(source: Buffer): Promise<Buffer> {
  if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new GmailDraftError("Stored Stitch app image is not a PNG");
  }
  return sharp(source).resize({ width: 564, withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true, progressive: false }).toBuffer();
}

export async function combineEmailScreenshots(images: readonly Buffer[]): Promise<Buffer> {
  if (images.length !== MAX_SHOWCASE_SCREENS) {
    throw new GmailDraftError("The email showcase requires exactly three app screenshots");
  }
  const resized = await Promise.all(images.map(async (image) => {
    const metadata = await sharp(image).metadata();
    if (!["png", "jpeg"].includes(metadata.format ?? "") || !metadata.width || !metadata.height ||
        metadata.height / metadata.width > 3 || metadata.height / metadata.width < 1.1) {
      throw new GmailDraftError("App screenshot has an unsupported format or aspect ratio");
    }
    const data = await sharp(image).resize({ width: SHOWCASE_SCREEN_WIDTH }).jpeg({ quality: 86 }).toBuffer();
    const resizedMetadata = await sharp(data).metadata();
    return { data, height: resizedMetadata.height! };
  }));
  const height = Math.max(...resized.map((image) => image.height)) + 2 * SHOWCASE_PADDING;
  const composite = await sharp({
    create: { width: SHOWCASE_WIDTH, height, channels: 3, background: "#f3f1ee" },
  }).composite(resized.map((image, index) => ({
    input: image.data,
    left: SHOWCASE_PADDING + index * (SHOWCASE_SCREEN_WIDTH + SHOWCASE_GAP),
    top: SHOWCASE_PADDING,
  }))).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (composite.length > MAX_INLINE_IMAGE_BYTES) {
    throw new GmailDraftError("Combined app showcase is too large for an inline Gmail draft");
  }
  return composite;
}

function base64Lines(value: Buffer | string): string {
  const encoded = Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function renderShowcase(contentIds: readonly string[], businessName: string): string {
  if (contentIds.length === 0) return "";
  return `<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse"><tr><td align="center"><img src="cid:${contentIds[0]}" alt="${escapeHtml(businessName)} Home, Booking, and Community app concepts" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr></table>`;
}

function renderHtmlBody(body: string, contentIds: readonly string[], signatureLogoUrl: string | null, businessName: string): string {
  const paragraphs = body.replace(/\r\n|\r/g, "\n").split(/\n\s*\n/);
  const visualIndex = paragraphs.findIndex((paragraph) => paragraph.trim() === MONARCH_OUTREACH_VISUAL_SENTENCE);
  const insertAfter = Math.min(1, paragraphs.length - 1);
  const html = paragraphs.flatMap((paragraph, index) => {
    if (index === visualIndex) return [renderShowcase(contentIds, businessName)];
    const lines = paragraph.split("\n");
    const renderedLines = lines.map((line) =>
      line === MONARCH_OUTREACH_SIGNATURE_LABEL
        ? `${signatureLogoUrl ? `<img src="${escapeHtml(signatureLogoUrl)}" alt="" width="24" height="24" style="display:inline-block;width:24px;height:24px;vertical-align:middle;border:0;border-radius:4px">&nbsp;` : ""}<a href="${escapeHtml(MONARCH_OUTREACH_SIGNATURE_URL)}">${escapeHtml(MONARCH_OUTREACH_SIGNATURE_LABEL)}</a>`
        : escapeHtml(line),
    );
    const parts = [`<p>${renderedLines.join("<br>")}</p>`];
    if (visualIndex < 0 && contentIds.length && index === insertAfter) parts.push(renderShowcase(contentIds, businessName));
    return parts;
  }).join("\r\n");
  return `<!doctype html><html><body>${html}</body></html>`;
}

export function buildGmailDraftRaw(
  prospect: Prospect,
  senderEmail: string,
  inlineImage?: Buffer,
  signatureLogoUrl: string | null = monarchSignatureLogoUrl(),
): string {
  if (prospect.workflow_status !== "EMAIL_GENERATED" || !prospect.email_verified) {
    throw new GmailDraftError("Prospect is not eligible for Gmail draft creation");
  }
  const recipient = prospect.contact_email?.trim();
  const sender = senderEmail.trim();
  if (!recipient || !validEmail(recipient) || !validEmail(sender)) {
    throw new GmailDraftError("A valid sender and verified recipient are required");
  }
  if (!prospect.email_subject?.trim() || !prospect.email_body?.trim()) {
    throw new GmailDraftError("Generated email subject and body are required");
  }
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(prospect.id)) {
    throw new GmailDraftError("Prospect ID must be a UUID");
  }
  const images = inlineImage ? [inlineImage] : [];
  if (images.reduce((total, image) => total + image.length, 0) > MAX_TOTAL_INLINE_IMAGE_BYTES) {
    throw new GmailDraftError("Combined app concept images are too large for an inline Gmail draft");
  }
  for (const image of images) {
    if (image.length < JPEG_SIGNATURE.length || image.length > MAX_INLINE_IMAGE_BYTES ||
        (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
         !image.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE))) {
      throw new GmailDraftError("Inline app concept must be a valid PNG or JPEG within 15 MB");
    }
  }
  if (prospect.email_body.includes(MONARCH_OUTREACH_VISUAL_SENTENCE) && images.length !== 1) {
    throw new GmailDraftError("The approved outreach copy requires one combined inline app showcase");
  }
  const plainBody = prospect.email_body.replace(
    MONARCH_OUTREACH_VISUAL_SENTENCE,
    MONARCH_OUTREACH_PLAIN_VISUAL_SENTENCE,
  );
  const plain = plainBody.replace(/\r\n|\r|\n/g, "\r\n");
  // A Content-ID identifies a MIME part globally, not just within one prospect.
  // Fresh IDs also keep repeated test sends and draft replacements independent.
  const mimeNonce = randomUUID().replaceAll("-", "");
  const contentIds = images.map(() => `app-concept-${prospect.id}-${mimeNonce}@monarch.local`);
  signatureLogoUrl = validatedSignatureLogoUrl(signatureLogoUrl);
  const alternative = `monarch-alt-${prospect.id}-${mimeNonce}`;
  const related = `monarch-related-${prospect.id}-${mimeNonce}`;
  const hasInlineImages = images.length > 0;
  const headers = [
    `From: ${GMAIL_SENDER_DISPLAY_NAME} <${sender}>`,
    `To: ${recipient}`,
    `Subject: ${headerValue(prospect.email_subject, "Email subject")}`,
    `X-Monarch-Prospect-ID: ${prospect.id}`,
    "MIME-Version: 1.0",
    hasInlineImages
      ? `Content-Type: multipart/related; type="multipart/alternative"; boundary="${related}"`
      : `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
  ];
  const parts = hasInlineImages
    ? [`--${related}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, ""]
    : [];
  parts.push(
    `--${alternative}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(plain),
    `--${alternative}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(renderHtmlBody(prospect.email_body, contentIds, signatureLogoUrl, prospect.business_name)),
    `--${alternative}--`,
  );
  for (const [index, image] of images.entries()) {
    const isPng = image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    const extension = isPng ? "png" : "jpg";
    parts.push(
    `--${related}`,
    `Content-Type: ${isPng ? "image/png" : "image/jpeg"}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: inline; filename="app-screen-${index + 1}.${extension}"`,
    `Content-ID: <${contentIds[index]}>`,
    "",
    base64Lines(image),
  );
  }
  if (hasInlineImages) parts.push(`--${related}--`);
  const mime = [...headers, ...parts, ""].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export function createSupabaseGmailDraftStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): GmailDraftStore {
  return {
    async listCandidates({ businessName, limit }) {
      const { data, error } = await client
        .from("prospects")
        .select("*")
        .eq("business_name", businessName)
        .eq("workflow_status", "EMAIL_GENERATED")
        .eq("email_verified", true)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        throw new GmailDraftError(`Could not list Gmail draft candidates: ${error.message}`, {
          cause: error,
        });
      }
      return data ?? [];
    },

    async saveDraftId(id, draftId) {
      const { data, error } = await client
        .from("prospects")
        .update({ gmail_draft_id: draftId, error_message: null })
        .eq("id", id)
        .eq("workflow_status", "EMAIL_GENERATED")
        .eq("email_verified", true)
        .is("gmail_draft_id", null)
        .select("id")
        .maybeSingle();
      if (error || !data) {
        throw new GmailDraftError(
          `Could not persist Gmail draft ID for prospect ${id}: ${error?.message ?? "prospect changed"}`,
          error ? { cause: error } : undefined,
        );
      }
    },

    async markDraftCreated(id, draftId) {
      const { data, error } = await client
        .from("prospects")
        .update({ workflow_status: "DRAFT_CREATED", error_message: null })
        .eq("id", id)
        .eq("gmail_draft_id", draftId)
        .eq("workflow_status", "EMAIL_GENERATED")
        .eq("email_verified", true)
        .select("id")
        .maybeSingle();
      if (error || !data) {
        throw new GmailDraftError(
          `Could not mark Gmail draft created for prospect ${id}: ${error?.message ?? "prospect changed"}`,
          error ? { cause: error } : undefined,
        );
      }
    },
  };
}

export async function createGmailDrafts(
  options: CreateGmailDraftsOptions,
): Promise<GmailDraftBatchResult> {
  // Injected gateways are isolated test doubles; real local commands share an
  // exclusive lock so two processes cannot both pass Gmail reconciliation.
  return options.gateway
    ? createGmailDraftsUnlocked(options)
    : withGmailDraftLock(() => createGmailDraftsUnlocked(options));
}

async function createGmailDraftsUnlocked(
  options: CreateGmailDraftsOptions,
): Promise<GmailDraftBatchResult> {
  const businessName = options.businessName.trim();
  if (!businessName) throw new GmailDraftError("Business name is required");
  const limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new RangeError("limit must be an integer between 1 and 25");
  }
  const store = options.store ?? createSupabaseGmailDraftStore();
  const prospects = await store.listCandidates({ businessName, limit });
  if (prospects.length === 0) {
    return { created: 0, recovered: 0, failed: 0, processed: 0, results: [] };
  }
  if (Boolean(options.gateway) !== Boolean(options.senderEmail)) {
    throw new GmailDraftError("A test gateway and sender email must be supplied together");
  }
  const server =
    options.gateway && options.senderEmail
      ? { gateway: options.gateway, senderEmail: options.senderEmail }
      : await (await import("../../lib/gmail/server.js")).getServerGmailGateway();
  const results: GmailDraftResult[] = [];
  for (const prospect of prospects) {
    let draftId: string | null = prospect.gmail_draft_id;
    try {
      let status: GmailDraftResult["status"] = "RECOVERED";
      if (!draftId) {
        const existing = await server.gateway.findDraftByProspectId(prospect.id);
        if (existing) {
          draftId = existing.id;
        } else {
          const imagePaths = findConceptImagePaths(prospect);
          const imageStore = imagePaths.length
            ? options.imageStore ?? createSupabaseGmailConceptImageStore()
            : null;
          const inlineImages = imageStore
            ? await Promise.all(imagePaths.map((path) => imageStore.downloadEmailImage(path)))
            : [];
          if (prospect.email_body?.includes(MONARCH_OUTREACH_VISUAL_SENTENCE) && inlineImages.length !== 3) {
            throw new GmailDraftError("The approved outreach copy requires exactly three stored app screenshots");
          }
          const showcase = inlineImages.length === 3
            ? await combineEmailScreenshots(inlineImages)
            : inlineImages[0];
          const raw = buildGmailDraftRaw(prospect, server.senderEmail, showcase);
          draftId = await server.gateway.createDraft(raw);
          status = "CREATED";
        }
        // Persist the Gmail ID before the final status update. On a retry, we
        // inspect this exact draft instead of creating a second one.
        await store.saveDraftId(prospect.id, draftId);
      }
      const draft = await server.gateway.getDraft(draftId);
      if (!draft || draft.prospectId !== prospect.id) {
        throw new GmailDraftError(
          `Gmail draft ${draftId} is missing or does not match prospect ${prospect.id}; no replacement draft was created`,
        );
      }
      await store.markDraftCreated(prospect.id, draftId);
      results.push({
        businessName: prospect.business_name,
        draftId,
        error: null,
        status,
      });
    } catch (error) {
      results.push({
        businessName: prospect.business_name,
        draftId,
        error: error instanceof Error ? error.message : "Unknown Gmail draft error",
        status: "FAILED",
      });
    }
  }
  return {
    created: results.filter((item) => item.status === "CREATED").length,
    recovered: results.filter((item) => item.status === "RECOVERED").length,
    failed: results.filter((item) => item.status === "FAILED").length,
    processed: results.length,
    results,
  };
}

export function formatGmailDraftBatchResult(result: GmailDraftBatchResult): string {
  return [
    "GMAIL DRAFT CREATION COMPLETE",
    `Processed: ${result.processed}`,
    `Created: ${result.created}`,
    `Recovered: ${result.recovered}`,
    `Failed: ${result.failed}`,
    ...result.results.map(
      (item) =>
        `${item.businessName} | ${item.status} | ${item.draftId ?? "no draft ID"}${item.error ? ` | ${item.error}` : ""}`,
    ),
  ].join("\n");
}
