import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  formatCsvProspectImportResult,
  importProspectsFromCsv,
} from "../modules/prospects/prospect.csv-import.js";

const csvPath = process.argv[2];

if (!csvPath) {
  console.error("Usage: npm run prospects:import -- <path-to-csv>");
  process.exitCode = 1;
} else {
  try {
    const csv = await readFile(resolve(csvPath), "utf8");
    const result = await importProspectsFromCsv(csv);
    console.log(formatCsvProspectImportResult(result));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`CSV IMPORT FAILED\n\n${reason}`);
    process.exitCode = 1;
  }
}
