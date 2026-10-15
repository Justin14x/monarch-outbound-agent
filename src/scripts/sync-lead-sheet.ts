import { getServerGmailReplyGateway } from "../lib/gmail/server.js";
import { getServerLeadSheetGateway } from "../lib/google/lead-sheet.js";
import { syncLeadSheetStatuses } from "../modules/leads/lead-sheet-sync.js";

try {
  const result = await syncLeadSheetStatuses(
    await getServerLeadSheetGateway(),
    await getServerGmailReplyGateway(),
  );
  console.log(`LEAD SHEET SYNC COMPLETE\nMatched: ${result.matched}\nSent updated: ${result.sentUpdated}\nReplies updated: ${result.repliesUpdated}`);
  for (const issue of result.issues) console.log(`- ${issue}`);
  if (result.issues.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`LEAD SHEET SYNC FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
