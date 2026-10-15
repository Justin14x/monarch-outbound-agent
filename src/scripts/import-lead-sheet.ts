import { getServerLeadSheetGateway } from "../lib/google/lead-sheet.js";
import { importProspectsFromLeadSheet } from "../modules/leads/lead-sheet-import.js";

try {
  const result = await importProspectsFromLeadSheet(await getServerLeadSheetGateway());
  console.log(`LEAD SHEET IMPORT COMPLETE\nTotal rows: ${result.totalRows}\nImported: ${result.imported}\nDuplicates: ${result.duplicates}\nFailed: ${result.failed}`);
  for (const row of result.duplicateRows) console.log(`Row ${row.rowNumber}: duplicate ${row.normalizedDomain}`);
  for (const row of result.failedRows) console.log(`Row ${row.rowNumber}: ${row.reason}`);
  if (result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(`LEAD SHEET IMPORT FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
