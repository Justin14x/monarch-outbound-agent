import {
  discoverProspectEmails,
  formatEmailDiscoveryResult,
} from "../modules/emails/index.js";

const arguments_ = process.argv.slice(2);
const allowStitchFailed = arguments_.includes("--allow-stitch-failed");
const businessName = arguments_
  .filter((argument) => argument !== "--allow-stitch-failed")
  .join(" ")
  .trim();
if (!businessName) {
  console.error(
    'Usage: npm run emails:find -- "Business Name" [--allow-stitch-failed]\nA business name is required so live runs remain explicitly scoped.',
  );
  process.exitCode = 1;
} else {
  try {
    const result = await discoverProspectEmails({
      allowStitchFailed,
      businessName,
      includeNotFound: true,
      limit: 1,
    });
    console.log(formatEmailDiscoveryResult(result));
    if (result.processed === 0 || result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `VERIFIED EMAIL DISCOVERY FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  }
}
