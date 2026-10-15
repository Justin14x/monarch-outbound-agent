import type { LeadSheetGateway } from "../../lib/google/lead-sheet.js";
import {
  importProspectsFromCsv,
  type CsvProspectImportResult,
  type ProspectImportStore,
} from "../prospects/prospect.csv-import.js";

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function importProspectsFromLeadSheet(
  sheet: LeadSheetGateway,
  store?: ProspectImportStore,
): Promise<CsvProspectImportResult> {
  const rows = await sheet.readRows();
  const csv = [
    "business_name,website",
    ...rows.map((row) => `${csvCell(row.businessName)},${csvCell(row.website)}`),
  ].join("\n");
  const result = await importProspectsFromCsv(csv, store);
  for (const row of [...result.importedRows, ...result.duplicateRows, ...result.failedRows]) {
    row.rowNumber = rows[row.rowNumber - 2]?.rowNumber ?? row.rowNumber;
  }
  return result;
}
