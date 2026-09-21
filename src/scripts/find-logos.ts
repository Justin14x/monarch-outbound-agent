import {
  formatLogoBatchResult,
  processPendingProspectLogos,
} from "../modules/logos/index.js";

const rawLimit = process.argv[2];
const limit = rawLimit === undefined ? 10 : Number(rawLimit);

try {
  const result = await processPendingProspectLogos({ limit });
  console.log(formatLogoBatchResult(result));
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`LOGO FINDER FAILED\n\n${reason}`);
  process.exitCode = 1;
}
