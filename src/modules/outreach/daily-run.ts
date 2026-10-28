import { createProspect, getProspectByNormalizedDomain, getProspect, updateProspect } from "../prospects/prospect.repository.js";
import { normalizeWebsite } from "../prospects/website-normalization.js";
import type { Prospect } from "../prospects/prospect.types.js";
import type { LeadSheetGateway, LeadSheetRow } from "../../lib/google/lead-sheet.js";
import { getServerSupabaseClient } from "../../lib/supabase/server.js";
import { stageThreeScreens, commitThreeScreens } from "../stitch/three-screen-generator.js";
import { generateOutreachEmails } from "../emails/outreach-email-generator.js";
import {
  buildGmailDraftRaw,
  combineEmailScreenshots,
  createGmailDrafts,
  createSupabaseGmailConceptImageStore,
  findConceptImagePaths,
  validEmail,
} from "../emails/gmail-draft-creator.js";
import { getServerGmailGateway } from "../../lib/gmail/server.js";
import { getServerGmailSendGateway, type ConfirmedSentMessage, type GmailSendGateway } from "../../lib/gmail/send.js";
import { MONARCH_OUTREACH_OPT_OUT_SENTENCE, MONARCH_OUTREACH_POSTAL_ADDRESS } from "../../config/outreach-email-template.js";
import { readSheetRecipient, synchronizeSheetRecipient } from "./sheet-recipient.js";

export const DAILY_SEND_LIMIT = 5;

export interface DailyRunResult {
  sent: number;
  reconciled: number;
  rows: number[];
  stoppedReason: string | null;
}

export type LeadSendResult = "SENT" | "RECONCILED" | "QUOTA_REACHED";

export interface DailyRunOptions {
  sheet: LeadSheetGateway;
  processLead: (row: LeadSheetRow, allowNewSend: boolean) => Promise<LeadSendResult>;
  limit?: number;
  remainingQuota?: () => Promise<number>;
}

export async function runDailyOutreach(options: DailyRunOptions): Promise<DailyRunResult> {
  const limit = options.limit ?? DAILY_SEND_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > DAILY_SEND_LIMIT) {
    throw new RangeError("A daily outreach block may send at most five messages");
  }
  const result: DailyRunResult = { sent: 0, reconciled: 0, rows: [], stoppedReason: null };
  const handled = new Set<number>();
  while (result.sent < limit) {
    const rows = await options.sheet.readRows();
    const row = rows.find((candidate) => candidate.outreach === "Not Sent" && !handled.has(candidate.rowNumber));
    if (!row) break;
    handled.add(row.rowNumber);
    if (!row.businessName || !row.website) {
      result.stoppedReason = `Sheet row ${row.rowNumber} is missing a business name or website`;
      break;
    }
    try {
      readSheetRecipient(row);
      const remaining = options.remainingQuota ? await options.remainingQuota() : limit - result.sent;
      const outcome = await options.processLead(row, remaining > 0);
      if (outcome === "QUOTA_REACHED") break;
      await options.sheet.writeStatuses([{ rowNumber: row.rowNumber, column: "D", value: "Sent" }]);
      const readback = (await options.sheet.readRows()).find((item) => item.rowNumber === row.rowNumber);
      if (readback?.outreach !== "Sent") throw new Error("Sheet Sent status failed readback verification");
      if (outcome === "SENT") result.sent++;
      else result.reconciled++;
      result.rows.push(row.rowNumber);
    } catch (error) {
      result.stoppedReason = `Sheet row ${row.rowNumber}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  return result;
}

async function ensureProspect(row: LeadSheetRow): Promise<Prospect> {
  const { normalizedDomain, website } = normalizeWebsite(row.website);
  let prospect = await getProspectByNormalizedDomain(normalizedDomain);
  if (!prospect) {
    try {
      prospect = await createProspect({
        business_name: row.businessName,
        website,
        normalized_domain: normalizedDomain,
        workflow_status: "IMPORTED",
        logo_status: "PENDING",
      });
    } catch (error) {
      prospect = await getProspectByNormalizedDomain(normalizedDomain);
      if (!prospect) throw error;
    }
  }
  if (prospect.business_name.trim().toLowerCase() !== row.businessName.trim().toLowerCase()) {
    throw new Error("Sheet business name differs from the existing prospect; review before sending");
  }
  return prospect;
}

async function advanceProspect(prospect: Prospect, row: LeadSheetRow): Promise<Prospect> {
  const businessName = prospect.business_name;
  if (["IMPORTED", "LOGO_FOUND", "LOGO_NOT_FOUND", "LOGO_READY"].includes(prospect.workflow_status)) {
    prospect = await updateProspect(prospect.id, {
      workflow_status: "STITCH_PENDING", stitch_status: "PENDING", error_message: null,
    });
  }
  if (prospect.workflow_status === "STITCH_PENDING") {
    // Stage creates exactly one three-screen Stitch generation request. An
    // uncertain failure is never automatically retried by the next run.
    try {
      const manifest = await stageThreeScreens({ prospect });
      await commitThreeScreens(manifest);
      prospect = await updateProspect(prospect.id, {
        workflow_status: "STITCH_COMPLETE", stitch_status: "COMPLETE", error_message: null,
      });
    } catch (error) {
      await updateProspect(prospect.id, {
        workflow_status: "STITCH_FAILED", stitch_status: "FAILED",
        error_message: error instanceof Error ? error.message.slice(0, 2000) : "Stitch generation failed",
      });
      throw error;
    }
  }
  // Column B is the recipient source; the scheduled worker does not crawl
  // websites or search public sources for addresses.
  prospect = await synchronizeSheetRecipient(prospect, row);
  if (prospect.workflow_status === "EMAIL_FOUND") {
    if (findConceptImagePaths(prospect).length !== 3) throw new Error("Three stored app screens are required before outreach");
    const result = await generateOutreachEmails({ businessName, limit: 1 });
    if (result.processed !== 1 || result.generated !== 1) throw new Error("Outreach email generation failed");
    prospect = (await getProspect(prospect.id))!;
  }
  if (prospect.workflow_status === "EMAIL_GENERATED") {
    const result = await createGmailDrafts({ businessName, limit: 1 });
    if (result.processed !== 1 || result.failed > 0) throw new Error(result.results[0]?.error ?? "Gmail draft creation failed");
    prospect = (await getProspect(prospect.id))!;
  }
  return prospect;
}

function assertSentMatchesProspect(sent: ConfirmedSentMessage, prospect: Prospect): void {
  if (sent.prospectId !== prospect.id || sent.recipient !== prospect.contact_email?.trim().toLowerCase() ||
      sent.subject !== prospect.email_subject) {
    throw new Error("Gmail Sent message does not match the verified prospect recipient and subject");
  }
}

async function recordConfirmedSend(prospect: Prospect, sent: ConfirmedSentMessage): Promise<void> {
  assertSentMatchesProspect(sent, prospect);
  if (prospect.workflow_status === "SENT") {
    if (prospect.gmail_message_id !== sent.id) throw new Error("Supabase and Gmail Sent IDs disagree");
    return;
  }
  const client = getServerSupabaseClient();
  const { data, error } = await client.from("prospects")
    .update({ workflow_status: "SENT", gmail_message_id: sent.id, sent_at: sent.sentAt, error_message: null })
    .eq("id", prospect.id)
    .eq("workflow_status", "DRAFT_CREATED")
    .eq("gmail_draft_id", prospect.gmail_draft_id!)
    .is("gmail_message_id", null)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error(`Gmail confirmed the send but Supabase could not record it: ${error?.message ?? "prospect changed"}`);
}

async function recoverBusinessDraft(prospect: Prospect, gmail: GmailSendGateway): Promise<Prospect> {
  const recipient = prospect.contact_email!.trim().toLowerCase();
  let draftId = await gmail.findDraftByProspectId(prospect.id, recipient);
  if (!draftId) {
    const paths = findConceptImagePaths(prospect);
    if (paths.length !== 3) throw new Error("Cannot rebuild a business draft without three stored screens");
    const images = await Promise.all(paths.map((path) => createSupabaseGmailConceptImageStore().downloadEmailImage(path)));
    const showcase = await combineEmailScreenshots(images);
    const server = await getServerGmailGateway();
    const raw = buildGmailDraftRaw({ ...prospect, workflow_status: "EMAIL_GENERATED" }, server.senderEmail, showcase);
    draftId = await server.gateway.createDraft(raw);
  }
  const candidate = await gmail.inspectDraft(draftId);
  if (!candidate || !candidate.hasShowcase || !candidate.hasRequiredFooter ||
      candidate.prospectId !== prospect.id || candidate.recipient !== recipient ||
      candidate.subject !== prospect.email_subject) {
    throw new Error("Recovered Gmail business draft does not match the prospect");
  }
  const client = getServerSupabaseClient();
  const { data, error } = await client.from("prospects")
    .update({ gmail_draft_id: draftId })
    .eq("id", prospect.id)
    .eq("workflow_status", "DRAFT_CREATED")
    .eq("gmail_draft_id", prospect.gmail_draft_id!)
    .is("gmail_message_id", null)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(`Could not record recovered Gmail business draft: ${error?.message ?? "prospect changed"}`);
  return data;
}

export async function processLeadForSend(
  row: LeadSheetRow,
  allowNewSend = true,
  suppliedGmail?: GmailSendGateway,
): Promise<LeadSendResult> {
  const sheetRecipient = readSheetRecipient(row);
  const gmail = suppliedGmail ?? await getServerGmailSendGateway();
  const existingProspect = !allowNewSend
    ? await getProspectByNormalizedDomain(normalizeWebsite(row.website).normalizedDomain)
    : null;
  if (!allowNewSend && !existingProspect) return "QUOTA_REACHED";
  let prospect = existingProspect ?? await ensureProspect(row);
  if (prospect.business_name.trim().toLowerCase() !== row.businessName.trim().toLowerCase()) {
    throw new Error("Sheet business name differs from the existing prospect; review before sending");
  }
  if (allowNewSend && prospect.workflow_status !== "SENT") prospect = await advanceProspect(prospect, row);
  if (prospect.workflow_status === "DRAFT_CREATED" || prospect.workflow_status === "SENT") {
    prospect = await synchronizeSheetRecipient(prospect, row);
  }
  if (!allowNewSend && prospect.workflow_status !== "SENT" && prospect.workflow_status !== "DRAFT_CREATED") {
    return "QUOTA_REACHED";
  }
  if (prospect.workflow_status !== "DRAFT_CREATED" && prospect.workflow_status !== "SENT") {
    throw new Error(`Prospect is not send-ready: ${prospect.workflow_status}`);
  }
  if (!prospect.email_verified || prospect.contact_email?.trim().toLowerCase() !== sheetRecipient.email ||
      !validEmail(prospect.contact_email.trim()) || !prospect.email_source_url ||
      !prospect.email_subject || !prospect.email_body || findConceptImagePaths(prospect).length !== 3) {
    throw new Error("Verified email, approved copy, and three stored screens are required before sending");
  }
  const existing = await gmail.findSentByProspectId(prospect.id, prospect.contact_email.trim().toLowerCase());
  if (existing) {
    await recordConfirmedSend(prospect, existing);
    return "RECONCILED";
  }
  if (!prospect.email_body.includes(MONARCH_OUTREACH_OPT_OUT_SENTENCE) ||
      !prospect.email_body.includes(MONARCH_OUTREACH_POSTAL_ADDRESS)) {
    throw new Error("Stored outreach copy lacks the opt-out sentence or postal address");
  }
  if (!allowNewSend) return "QUOTA_REACHED";
  if (prospect.workflow_status === "SENT") throw new Error("Supabase says SENT but Gmail has no matching Sent message");
  let draft = prospect.gmail_draft_id ? await gmail.inspectDraft(prospect.gmail_draft_id) : null;
  if (!draft) {
    // A prior deliverability test may have consumed the stored draft by
    // sending it to the owner's inbox. Recover/create a business draft only
    // after Sent-mail reconciliation proves the business was not contacted.
    prospect = await recoverBusinessDraft(prospect, gmail);
    draft = await gmail.inspectDraft(prospect.gmail_draft_id!);
  }
  if (!draft) throw new Error("Gmail business draft is missing after recovery");
  if (!draft.hasShowcase || !draft.hasRequiredFooter || draft.prospectId !== prospect.id || draft.recipient !== prospect.contact_email!.trim().toLowerCase() ||
      draft.subject !== prospect.email_subject) {
    throw new Error("Gmail draft lacks the required footer or differs from verified Supabase data");
  }
  const sent = await gmail.sendDraft(prospect.gmail_draft_id!, prospect.id);
  await recordConfirmedSend(prospect, sent);
  return "SENT";
}
