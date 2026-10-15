import {
  formatStitchGenerationResult,
  generateStitchApps,
} from "../modules/stitch/index.js";

const args = process.argv.slice(2);
const forceNewProject = args.includes("--new-project");
const businessName = args.filter((arg) => arg !== "--new-project").join(" ").trim();
if (!businessName) {
  console.error(
    'Usage: npm run stitch:generate -- "Business Name" [--new-project]\nA business name is required so live generations remain explicitly scoped.',
  );
  process.exitCode = 1;
} else {
  try {
    const result = await generateStitchApps({
      businessName,
      forceNewProject,
      includeFailed: true,
      limit: 1,
    });
    console.log(formatStitchGenerationResult(result));
    if (result.processed === 0 || result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `STITCH GENERATION FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  }
}
