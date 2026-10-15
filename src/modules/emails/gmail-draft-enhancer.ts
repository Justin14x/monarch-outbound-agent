import type { GmailDraftGateway, GmailDraftRecord } from "../../lib/gmail/server.js";
import { withGmailDraftLock } from "../../lib/gmail/draft-lock.js";
import { getServerSupabaseClient, type MonarchServerSupabaseClient } from "../../lib/supabase/server.js";
import type { Prospect } from "../prospects/prospect.types.js";
import {
  buildGmailDraftRaw,
  createSupabaseGmailConceptImageStore,
  findConceptImagePaths,
  GmailDraftError,
  hasMonarchSignatureLine,
  loadMonarchSignatureLogo,
  type GmailConceptImageStore,
} from "./gmail-draft-creator.js";

export interface GmailDraftEnhancementStore {
  getProspect(businessName: string): Promise<Prospect>;
}

export interface EnhanceGmailDraftOptions {
  businessName: string;
  store?: GmailDraftEnhancementStore;
  gateway?: GmailDraftGateway;
  senderEmail?: string;
  imageStore?: GmailConceptImageStore;
}

export function createSupabaseGmailDraftEnhancementStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): GmailDraftEnhancementStore {
  return {
    async getProspect(businessName) {
      const { data, error } = await client.from("prospects").select("*")
        .eq("business_name", businessName).single();
      if (error || !data) throw new GmailDraftError(`Could not load exact prospect: ${error?.message ?? "missing"}`);
      return data;
    },
  };
}

function matchesExistingDraft(draft: GmailDraftRecord | null, prospect: Prospect): boolean {
  if (!draft || draft.id !== prospect.gmail_draft_id || draft.isDraft === false) return false;
  if (draft.prospectId) return draft.prospectId === prospect.id;
  // Gmail may strip custom X- headers from saved drafts. In that case the
  // exact stored draft ID, recipient, and subject must all match.
  return draft.isDraft === true &&
    draft.recipient === prospect.contact_email &&
    draft.subject === prospect.email_subject;
}

export async function enhanceGmailDraft(options: EnhanceGmailDraftOptions): Promise<{
  draftId: string;
  subject: string;
  body: string;
  imagePaths: string[];
}> {
  return options.gateway
    ? enhanceGmailDraftUnlocked(options)
    : withGmailDraftLock(() => enhanceGmailDraftUnlocked(options));
}

async function enhanceGmailDraftUnlocked(options: EnhanceGmailDraftOptions) {
  const businessName = options.businessName.trim();
  if (!businessName) throw new GmailDraftError("Exact business name is required");
  if (Boolean(options.gateway) !== Boolean(options.senderEmail)) {
    throw new GmailDraftError("A test gateway and sender email must be supplied together");
  }
  const store = options.store ?? createSupabaseGmailDraftEnhancementStore();
  const prospect = await store.getProspect(businessName);
  if (prospect.workflow_status !== "DRAFT_CREATED" || !prospect.email_verified || !prospect.gmail_draft_id) {
    throw new GmailDraftError("Prospect must have an existing verified Gmail draft");
  }
  const imagePaths = findConceptImagePaths(prospect);
  if (!imagePaths.length) throw new GmailDraftError("No owned Stitch screenshot is stored for this prospect");
  const server = options.gateway && options.senderEmail
    ? { gateway: options.gateway, senderEmail: options.senderEmail }
    : await (await import("../../lib/gmail/server.js")).getServerGmailGateway();
  const existing = await server.gateway.getDraft(prospect.gmail_draft_id);
  if (!matchesExistingDraft(existing, prospect)) {
    throw new GmailDraftError("Existing Gmail draft is missing or belongs to a different prospect");
  }
  if (!prospect.email_subject?.trim() || !prospect.email_body?.trim()) {
    throw new GmailDraftError("Existing email subject and body are required");
  }
  const imageStore = options.imageStore ?? createSupabaseGmailConceptImageStore();
  const images = await Promise.all(imagePaths.map((path) => imageStore.downloadEmailImage(path)));
  const signaturePng = hasMonarchSignatureLine(prospect.email_body)
    ? await loadMonarchSignatureLogo()
    : undefined;
  const raw = buildGmailDraftRaw({
    ...prospect,
    workflow_status: "EMAIL_GENERATED",
  }, server.senderEmail, images, signaturePng);
  const draftId = await server.gateway.updateDraft(prospect.gmail_draft_id, raw);
  const updated = await server.gateway.getDraft(draftId);
  if (!matchesExistingDraft(updated, prospect)) {
    throw new GmailDraftError("Updated Gmail draft could not be verified for this prospect");
  }
  return { draftId, subject: prospect.email_subject, body: prospect.email_body, imagePaths };
}
