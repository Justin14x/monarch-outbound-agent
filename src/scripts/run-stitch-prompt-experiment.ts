import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { runStitchPromptExperiment, validateExperimentPrompt } from "../modules/stitch/stitch-prompt-experiment.js";

const args = process.argv.slice(2);
const run = args.includes("--run");
const referenceFlag = args.indexOf("--reference-image");
const referenceArgument = referenceFlag >= 0 ? args[referenceFlag + 1] : undefined;
const files = args.filter((arg, index) =>
  arg !== "--run" && arg !== "--reference-image" && (referenceFlag < 0 || index !== referenceFlag + 1)
);
if (files.length !== 1 || !files[0]?.endsWith(".md") ||
    (referenceFlag >= 0 && (!referenceArgument || referenceArgument.startsWith("--") ||
      path.extname(referenceArgument).toLowerCase() !== ".png"))) {
  console.error("Usage: npm run stitch:experiment -- <prompt.md> [--reference-image <image.png>] [--run]");
  process.exitCode = 1;
} else {
  const promptFile = path.resolve(files[0]);
  const prompt = validateExperimentPrompt(await readFile(promptFile, "utf8"));
  const referenceImagePath = referenceArgument ? path.resolve(referenceArgument) : undefined;
  if (referenceImagePath && !(await stat(referenceImagePath)).isFile()) {
    throw new Error(`Reference image is not a file: ${referenceImagePath}`);
  }
  console.log(`STITCH PROMPT EXPERIMENT\nFile: ${promptFile}\nDevice: MOBILE\nMode: ${referenceImagePath ? "upload reference + edit_screens" : "generate_screen_from_text"}\nReference: ${referenceImagePath ?? "none"}\nGeneration/edit calls: ${run ? 1 : 0}\n\n${prompt}\n`);
  if (!run) {
    console.log("Preview only. Add --run to create an isolated project and generate once.");
  } else {
    const parent = path.resolve("output/stitch-experiments");
    await mkdir(parent, { recursive: true });
    const outputDir = await mkdtemp(path.join(parent, `${path.basename(promptFile, ".md")}-`));
    const result = await runStitchPromptExperiment({
      outputDir,
      prompt,
      ...(referenceImagePath ? { referenceImagePath } : {}),
      title: `Monarch prompt experiment - ${path.basename(promptFile, ".md")}`,
    });
    console.log(`RESULT: ${result.status}\nProject: ${result.projectId}\nReference screen: ${result.referenceScreenId ?? "none"}\nScreens: ${result.screens.length}\nManifest: ${path.join(outputDir, "result.json")}`);
    result.screens.forEach((screen, index) => {
      console.log(`${index + 1}. ${screen.screenName ?? "Untitled"} | ${screen.screenId} | ${screen.width}×${screen.height}\n   ${screen.screenshotUrl}\n   ${screen.localPath}`);
    });
  }
}
