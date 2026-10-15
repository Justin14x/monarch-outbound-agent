import { enhanceGmailDraft } from "../modules/emails/gmail-draft-enhancer.js";

const businessName = process.argv.slice(2).join(" ").trim();
if (!businessName) {
  console.error('Usage: npm run gmail:enhance -- "Business Name"');
  process.exitCode = 1;
} else {
  try {
    const result = await enhanceGmailDraft({ businessName });
    console.log(`Gmail draft enhanced: ${result.draftId} | ${result.imagePaths.join(", ")}`);
    console.log("Draft only. No email was sent.");
  } catch (error) {
    console.error(`GMAIL DRAFT ENHANCEMENT FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}
