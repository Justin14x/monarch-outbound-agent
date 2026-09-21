import {
  formatTransparentLogoBatchResult,
  processTransparentLogos,
} from "../modules/logos/transparent-logo-processor.js";

const rawLimit = process.argv[2];
const limit = rawLimit === undefined ? 10 : Number(rawLimit);

try {
  const result = await processTransparentLogos({ limit });
  console.log(formatTransparentLogoBatchResult(result));
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`TRANSPARENT LOGO PROCESSING FAILED\n\n${reason}`);
  process.exitCode = 1;
}
