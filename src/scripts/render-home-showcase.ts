import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderHomeShowcase, type HomeShowcaseConfig } from "../modules/showcase/home-renderer.js";

const configPath = path.resolve(process.argv[2] ?? "examples/showcase/skin-hub-home.json");
const outputPath = process.argv[3] ?? "output/showcase/skin-hub-home.png";
const config = JSON.parse(await readFile(configPath, "utf8")) as HomeShowcaseConfig;
const result = await renderHomeShowcase(config, outputPath);
console.log(`HOME SHOWCASE RENDERED\n${result.path}\n${result.width}×${result.height}\nSHA-256 ${result.sha256}`);
