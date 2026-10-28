import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { getServerLeadSheetGateway, type LeadSheetGateway, type LeadSheetRow } from "../lib/google/lead-sheet.js";
import { getServerGmailSendGateway, type GmailSendGateway } from "../lib/gmail/send.js";
import { getServerGmailGateway } from "../lib/gmail/server.js";
import { getServerSupabaseClient } from "../lib/supabase/server.js";
import { enhanceGmailDraft } from "../modules/emails/gmail-draft-enhancer.js";
import { renderOutreachEmail } from "../modules/emails/outreach-email-generator.js";
import { processLeadForSend, runDailyOutreach } from "../modules/outreach/daily-run.js";
import { getProspectByNormalizedDomain, updateProspect } from "../modules/prospects/prospect.repository.js";
import { normalizeWebsite } from "../modules/prospects/website-normalization.js";

const FIRST_ROW = 2;
const LAST_ROW = 51;
const TARGET_SENDS = 5;
const RUN_DATE = "2026-10-19";

function chicagoDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function refreshExistingDraft(row: LeadSheetRow, gmail: GmailSendGateway): Promise<void> {
  const domain = normalizeWebsite(row.website).normalizedDomain;
  let prospect = await getProspectByNormalizedDomain(domain);
  if (!prospect || prospect.workflow_status !== "DRAFT_CREATED") return;
  const expected = renderOutreachEmail({ ...prospect, workflow_status: "EMAIL_FOUND" });
  const copyChanged = prospect.email_subject !== expected.subject || prospect.email_body !== expected.body;
  if (copyChanged) {
    prospect = await updateProspect(prospect.id, { email_subject: expected.subject, email_body: expected.body });
  }
  const draft = prospect.gmail_draft_id ? await gmail.inspectDraft(prospect.gmail_draft_id) : null;
  if (!draft) return; // The normal send path will safely recover a missing draft.
  if (draft.prospectId !== prospect.id || draft.recipient !== prospect.contact_email?.trim().toLowerCase()) {
    throw new Error(`Existing Gmail draft for row ${row.rowNumber} does not belong to the verified prospect`);
  }
  if (copyChanged || !draft.hasRequiredFooter) {
    const server = await getServerGmailGateway();
    const updated = await enhanceGmailDraft({
      businessName: prospect.business_name, gateway: server.gateway, senderEmail: server.senderEmail,
    });
    if (updated.draftId !== prospect.gmail_draft_id) throw new Error("Gmail changed the existing draft ID");
    const verified = await gmail.inspectDraft(updated.draftId);
    if (!verified?.hasShowcase || !verified.hasRequiredFooter || verified.recipient !== prospect.contact_email?.trim().toLowerCase()) {
      throw new Error(`Updated Gmail draft for row ${row.rowNumber} failed verification`);
    }
  }
}

function oneRowSheet(sheet: LeadSheetGateway, rowNumber: number): LeadSheetGateway {
  return {
    readRows: async () => (await sheet.readRows()).filter((row) => row.rowNumber === rowNumber),
    writeStatuses: async (updates) => {
      if (updates.some((update) => update.rowNumber !== rowNumber || update.column !== "D" || update.value !== "Sent")) {
        throw new Error("Refusing a Sheet update outside the selected lead's Outreach cell");
      }
      await sheet.writeStatuses(updates);
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--live" || chicagoDate() !== RUN_DATE) {
    throw new Error(`This one-time, live-only run is restricted to ${RUN_DATE} in America/Chicago`);
  }
  const lockPath = resolve(process.cwd(), ".outreach-run.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const sheet = await getServerLeadSheetGateway();
    const gmail = await getServerGmailSendGateway();
    const datedGmail: GmailSendGateway = {
      ...gmail,
      async sendDraft(draftId, prospectId) {
        if (chicagoDate() !== RUN_DATE) throw new Error("Monday ended before the Gmail send call");
        return gmail.sendDraft(draftId, prospectId);
      },
    };
    let sent = 0;
    let reconciled = 0;
    let skippedNoEmail = 0;
    let skippedStitchFailure = 0;
    for (let rowNumber = FIRST_ROW; rowNumber <= LAST_ROW; rowNumber++) {
      if (sent + reconciled >= TARGET_SENDS) break;
      if (chicagoDate() !== RUN_DATE) throw new Error("Monday ended before five eligible leads were sent");
      const row = (await sheet.readRows()).find((candidate) => candidate.rowNumber === rowNumber);
      if (!row) break;
      if (!row.businessName || !row.website) throw new Error(`Sheet row ${rowNumber} is missing its business name or website`);
      if (row.outreach === "Sent") {
        const prior = await getProspectByNormalizedDomain(normalizeWebsite(row.website).normalizedDomain);
        if (prior?.workflow_status !== "SENT" || !prior.gmail_message_id || !prior.sent_at) {
          throw new Error(`Sheet row ${rowNumber} says Sent but Supabase has no matching sent record`);
        }
        if (chicagoDate(new Date(prior.sent_at)) === RUN_DATE) reconciled++;
        console.log(`SKIPPED row ${rowNumber}: already marked Sent`);
        continue;
      }
      if (row.outreach !== "Not Sent") throw new Error(`Sheet row ${rowNumber} has unexpected Outreach value: ${row.outreach}`);
      console.log(`START row ${rowNumber}: ${row.businessName}`);
      const existing = await getProspectByNormalizedDomain(normalizeWebsite(row.website).normalizedDomain);
      if (existing?.workflow_status === "EMAIL_NOT_FOUND") {
        skippedNoEmail++;
        console.log(`SKIPPED row ${rowNumber}: no publicly verified business contact`);
        continue;
      }
      if (existing?.workflow_status === "STITCH_FAILED") {
        if (existing.retry_count > 0) {
          skippedStitchFailure++;
          console.log(`SKIPPED row ${rowNumber}: controlled Stitch retry already attempted`);
          continue;
        }
        const { data, error } = await getServerSupabaseClient().from("prospects")
          .update({ workflow_status: "STITCH_PENDING", stitch_status: "PENDING", error_message: null, retry_count: 1 })
          .eq("id", existing.id)
          .eq("workflow_status", "STITCH_FAILED")
          .eq("retry_count", 0)
          .select("id")
          .maybeSingle();
        if (error || !data) throw new Error(`Could not reserve one Stitch retry for row ${rowNumber}: ${error?.message ?? "prospect changed"}`);
        console.log(`RETRY row ${rowNumber}: one new Stitch generation attempt`);
      }
      await refreshExistingDraft(row, datedGmail);
      const result = await runDailyOutreach({
        sheet: oneRowSheet(sheet, rowNumber), limit: 1,
        processLead: (selectedRow, allowNewSend) => processLeadForSend(selectedRow, allowNewSend, datedGmail),
      });
      if (result.stoppedReason?.includes("No publicly verified business email was found")) {
        skippedNoEmail++;
        console.log(`SKIPPED row ${rowNumber}: no publicly verified business contact`);
        continue;
      }
      const afterAttempt = result.stoppedReason
        ? await getProspectByNormalizedDomain(normalizeWebsite(row.website).normalizedDomain)
        : null;
      if (afterAttempt?.workflow_status === "STITCH_FAILED") {
        skippedStitchFailure++;
        console.log(`SKIPPED row ${rowNumber}: Stitch generation failed; no retry`);
        continue;
      }
      if (result.stoppedReason || result.rows.length !== 1) {
        throw new Error(result.stoppedReason ?? `Row ${rowNumber} was not confirmed and updated`);
      }
      sent += result.sent;
      reconciled += result.reconciled;
      console.log(`CONFIRMED row ${rowNumber}: ${result.sent ? "new send" : "prior send reconciled"}`);
    }
    if (sent + reconciled !== TARGET_SENDS) {
      throw new Error(`Only ${sent + reconciled} of ${TARGET_SENDS} sends were confirmed; ${skippedNoEmail} lacked a verified email and ${skippedStitchFailure} failed Stitch generation`);
    }
    console.log(`MONDAY FIVE-SEND TARGET COMPLETE: ${sent} new sends, ${reconciled} already confirmed, ${skippedNoEmail} without verified email, ${skippedStitchFailure} failed Stitch generation`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

await main().catch((error) => {
  console.error(`MONDAY FIVE-SEND TARGET STOPPED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
