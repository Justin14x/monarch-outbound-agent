import {
  formatStitchRequestBatchResult,
  prepareStitchRequests,
} from "../modules/stitch/index.js";

const args = process.argv.slice(2);
const rawLimit = args.find((value) => /^\d+$/.test(value));
const limit = rawLimit === undefined ? 10 : Number(rawLimit);
const includeLogoFailuresAsNoLogo = args.includes("--include-logo-failures");

try {
  const result = await prepareStitchRequests({
    includeLogoFailuresAsNoLogo,
    limit,
  });
  console.log(formatStitchRequestBatchResult(result));
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`STITCH REQUEST PREPARATION FAILED\n\n${reason}`);
  process.exitCode = 1;
}
