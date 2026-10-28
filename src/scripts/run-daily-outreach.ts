import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { getServerLeadSheetGateway } from "../lib/google/lead-sheet.js";
import { getServerGmailReplyGateway } from "../lib/gmail/server.js";
import { getServerSupabaseClient } from "../lib/supabase/server.js";
import { syncLeadSheetStatuses } from "../modules/leads/lead-sheet-sync.js";
import { processLeadForSend, runDailyOutreach } from "../modules/outreach/daily-run.js";
import { slotBounds } from "../modules/outreach/slot.js";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const slot = args.has("--slot=morning") ? "morning" : args.has("--slot=late") ? "late" : null;
const expectedArgs = new Set(["--live", "--dry-run", "--slot=morning", "--slot=late"]);

async function remainingSlotQuota(bounds: { start: string; end: string }): Promise<number> {
  const { count, error } = await getServerSupabaseClient().from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("workflow_status", "SENT")
    .gte("sent_at", bounds.start)
    .lt("sent_at", bounds.end);
  if (error || count === null) throw new Error(`Could not read this slot's confirmed send count: ${error?.message ?? "no count"}`);
  return Math.max(0, 5 - count);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => !expectedArgs.has(arg)) ||
      (args.has("--slot=morning") && args.has("--slot=late")) ||
      (live && (!slot || args.has("--dry-run")))) {
    throw new Error("Usage: npm run outreach:run -- --dry-run | --live --slot=morning|late");
  }
  const sheet = await getServerLeadSheetGateway();
  if (!live) {
    const rows = (await sheet.readRows()).filter((row) => row.outreach === "Not Sent").slice(0, 5);
    console.log(`DRY RUN: no Gmail send, Supabase write, or Sheet write\nNext unsent rows: ${rows.map((row) => `${row.rowNumber} ${row.businessName}`).join("; ") || "none"}`);
    return;
  }
  const bounds = slotBounds(slot!);
  const lockPath = resolve(process.cwd(), ".outreach-run.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("An outreach run may already be active. Reconcile Gmail and Supabase before removing .outreach-run.lock");
    }
    throw error;
  }
  try {
    const result = await runDailyOutreach({
      sheet, processLead: processLeadForSend, remainingQuota: () => remainingSlotQuota(bounds),
    });
    console.log(`DAILY OUTREACH COMPLETE\nSent: ${result.sent}\nPreviously sent, reconciled: ${result.reconciled}\nSheet rows updated: ${result.rows.join(", ") || "none"}\nStopped: ${result.stoppedReason ?? "No eligible unsent leads or five sends completed"}`);
    try {
      const sync = await syncLeadSheetStatuses(sheet, await getServerGmailReplyGateway());
      console.log(`SHEET REPLY SYNC COMPLETE\nSent cells repaired: ${sync.sentUpdated}\nResponses marked: ${sync.repliesUpdated}\nIssues: ${sync.issues.join("; ") || "none"}`);
    } catch (error) {
      console.error(`SHEET REPLY SYNC FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    if (result.stoppedReason) process.exitCode = 1;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

await main().catch((error) => {
  console.error(`DAILY OUTREACH FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
