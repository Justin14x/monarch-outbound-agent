import {
  formatOutreachEmailBatchResult,
  generateOutreachEmails,
} from "../modules/emails/index.js";

const businessName = process.argv.slice(2).join(" ").trim();
if (!businessName) {
  console.error('Usage: npm run emails:generate -- "Business Name"');
  process.exitCode = 1;
} else {
  try {
    const result = await generateOutreachEmails({ businessName });
    console.log(formatOutreachEmailBatchResult(result));
    if (result.processed === 0 || result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `OUTREACH EMAIL GENERATION FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  }
}
