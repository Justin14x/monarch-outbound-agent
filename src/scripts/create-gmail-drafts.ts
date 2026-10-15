import {
  createGmailDrafts,
  formatGmailDraftBatchResult,
} from "../modules/emails/gmail-draft-creator.js";

const businessName = process.argv.slice(2).join(" ").trim();
if (!businessName) {
  console.error('Usage: npm run gmail:draft -- "Business Name"');
  process.exitCode = 1;
} else {
  try {
    const result = await createGmailDrafts({ businessName });
    console.log(formatGmailDraftBatchResult(result));
    if (result.processed === 0 || result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `GMAIL DRAFT CREATION FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  }
}
