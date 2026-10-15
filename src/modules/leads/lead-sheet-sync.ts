import type { GmailReplyGateway } from "../../lib/gmail/server.js";
import type { LeadSheetGateway, LeadSheetRow, LeadSheetStatusUpdate } from "../../lib/google/lead-sheet.js";
import { listProspects } from "../prospects/prospect.repository.js";
import type { Prospect } from "../prospects/prospect.types.js";
import { normalizeWebsite } from "../prospects/website-normalization.js";

export interface LeadSyncStore {
  listAll(): Promise<Prospect[]>;
}

export interface LeadSheetSyncResult {
  matched: number;
  sentUpdated: number;
  repliesUpdated: number;
  issues: string[];
}

export function createSupabaseLeadSyncStore(): LeadSyncStore {
  return {
    async listAll() {
      const prospects: Prospect[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await listProspects({ limit: 100, offset });
        prospects.push(...page);
        if (page.length < 100) return prospects;
      }
    },
  };
}

function indexRows(rows: LeadSheetRow[], issues: string[]): Map<string, LeadSheetRow> {
  const byDomain = new Map<string, LeadSheetRow>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    try {
      const domain = normalizeWebsite(row.website).normalizedDomain;
      if (byDomain.has(domain)) ambiguous.add(domain);
      else byDomain.set(domain, row);
    } catch {
      issues.push(`Sheet row ${row.rowNumber}: invalid website; skipped`);
    }
  }
  for (const domain of ambiguous) {
    byDomain.delete(domain);
    issues.push(`Multiple sheet rows have domain ${domain}; skipped to avoid updating the wrong lead`);
  }
  return byDomain;
}

export async function syncLeadSheetStatuses(
  sheet: LeadSheetGateway,
  gmail: GmailReplyGateway,
  store: LeadSyncStore = createSupabaseLeadSyncStore(),
): Promise<LeadSheetSyncResult> {
  const issues: string[] = [];
  const rows = await sheet.readRows();
  const byDomain = indexRows(rows, issues);
  const prospects = await store.listAll();
  const updates: LeadSheetStatusUpdate[] = [];
  let matched = 0;
  let sentUpdated = 0;
  let repliesUpdated = 0;

  for (const prospect of prospects) {
    const row = byDomain.get(prospect.normalized_domain);
    if (!row) continue;
    matched++;
    if (prospect.workflow_status !== "SENT") {
      if (row.outreach === "Sent" || row.response === "Responded") {
        issues.push(`Sheet row ${row.rowNumber}: sheet is ahead of Supabase; left unchanged`);
      }
      continue;
    }
    if (!prospect.sent_at || !prospect.gmail_message_id) {
      issues.push(`Prospect ${prospect.id}: SENT is missing a Gmail message ID or timestamp`);
      continue;
    }
    if (row.outreach === "Not Sent") {
      updates.push({ rowNumber: row.rowNumber, column: "D", value: "Sent" });
      sentUpdated++;
    } else if (row.outreach !== "Sent") {
      issues.push(`Sheet row ${row.rowNumber}: unexpected Outreach value; left unchanged`);
    }

    let responded = row.response === "Responded";
    if (!responded) {
      try {
        const reply = await gmail.findFirstReply(
          prospect.gmail_message_id,
          prospect.sent_at,
        );
        responded = reply !== null;
      } catch (error) {
        issues.push(`Prospect ${prospect.id}: reply check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (responded && row.response === "No Response") {
      updates.push({ rowNumber: row.rowNumber, column: "E", value: "Responded" });
      repliesUpdated++;
    } else if (row.response !== "No Response" && row.response !== "Responded") {
      issues.push(`Sheet row ${row.rowNumber}: unexpected Response value; left unchanged`);
    }
  }

  await sheet.writeStatuses(updates);
  if (updates.length > 0) {
    const after = await sheet.readRows();
    for (const update of updates) {
      const row = after.find((candidate) => candidate.rowNumber === update.rowNumber);
      const actual = update.column === "D" ? row?.outreach : row?.response;
      if (actual !== update.value) {
        throw new Error(`Lead sheet row ${update.rowNumber} ${update.column} failed readback verification`);
      }
    }
  }
  return { matched, sentUpdated, repliesUpdated, issues };
}
