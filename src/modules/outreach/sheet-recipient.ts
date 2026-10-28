import { LEAD_SHEET_LAST_ROW, LEAD_SHEET_SPREADSHEET_ID, LEAD_SHEET_TAB_ID } from "../../config/lead-sheet.js";
import type { LeadSheetRow } from "../../lib/google/lead-sheet.js";
import { validEmail } from "../emails/gmail-draft-creator.js";
import { updateProspect } from "../prospects/prospect.repository.js";
import type { Prospect, UpdateProspectInput, WorkflowStatus } from "../prospects/prospect.types.js";

export interface SheetRecipient {
  email: string;
  sourceUrl: string;
}

export function readSheetRecipient(row: LeadSheetRow): SheetRecipient {
  if (!Number.isInteger(row.rowNumber) || row.rowNumber < 2 || row.rowNumber > LEAD_SHEET_LAST_ROW) {
    throw new Error("Lead sheet row number is outside the configured range");
  }
  const email = row.businessEmail.trim().toLowerCase();
  if (!validEmail(email)) {
    throw new Error(`Sheet row ${row.rowNumber} has a missing or invalid Business email in column B`);
  }
  return {
    email,
    sourceUrl: `https://docs.google.com/spreadsheets/d/${LEAD_SHEET_SPREADSHEET_ID}/edit#gid=${LEAD_SHEET_TAB_ID}&range=B${row.rowNumber}`,
  };
}

type ProspectUpdater = (id: string, changes: UpdateProspectInput) => Promise<Prospect>;

/** The lead Sheet is the recipient source for the scheduled outreach flow. */
export async function synchronizeSheetRecipient(
  prospect: Prospect,
  row: LeadSheetRow,
  save: ProspectUpdater = updateProspect,
): Promise<Prospect> {
  const { email, sourceUrl } = readSheetRecipient(row);
  const currentEmail = prospect.contact_email?.trim().toLowerCase() ?? null;
  const changedRecipient = currentEmail !== email;

  // Never retarget an existing Gmail draft or a sent message silently.
  if (prospect.workflow_status === "DRAFT_CREATED" || prospect.workflow_status === "SENT") {
    if (changedRecipient) {
      throw new Error(`Sheet row ${row.rowNumber} email differs from the existing ${prospect.workflow_status === "SENT" ? "sent message" : "Gmail draft"} recipient; manual review required`);
    }
    if (prospect.workflow_status === "SENT") return prospect;
    if (prospect.email_verified && prospect.email_source_url === sourceUrl) return prospect;
    return save(prospect.id, { email_source_url: sourceUrl, email_verified: true });
  }

  switch (prospect.workflow_status) {
    case "STITCH_COMPLETE":
    case "EMAIL_NOT_FOUND":
    case "EMAIL_FOUND":
    case "EMAIL_GENERATED":
      break;
    default:
      return prospect;
  }
  if ((prospect.gmail_draft_id || prospect.gmail_message_id || prospect.sent_at) && changedRecipient) {
    throw new Error(`Sheet row ${row.rowNumber} email differs from an existing Gmail message recipient; manual review required`);
  }
  const nextStatus: WorkflowStatus = prospect.workflow_status === "STITCH_COMPLETE" ||
    prospect.workflow_status === "EMAIL_NOT_FOUND" ||
    (prospect.workflow_status === "EMAIL_GENERATED" && changedRecipient)
    ? "EMAIL_FOUND"
    : prospect.workflow_status;
  if (!changedRecipient && prospect.email_verified && prospect.email_source_url === sourceUrl &&
      nextStatus === prospect.workflow_status) return prospect;
  return save(prospect.id, {
    contact_email: email,
    contact_name: changedRecipient ? null : prospect.contact_name,
    email_source_url: sourceUrl,
    email_verified: true,
    error_message: null,
    workflow_status: nextStatus,
    ...(prospect.workflow_status === "EMAIL_GENERATED" && changedRecipient
      ? { email_subject: null, email_body: null }
      : {}),
  });
}
