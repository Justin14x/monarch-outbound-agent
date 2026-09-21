import { parse } from "csv-parse/sync";

import {
  createProspect,
  getProspectByNormalizedDomain,
  ProspectDataError,
} from "./prospect.repository.js";
import type { CreateProspectInput, Prospect } from "./prospect.types.js";
import { normalizeWebsite } from "./website-normalization.js";

const REQUIRED_COLUMNS = ["business_name", "website"] as const;

export interface ProspectImportStore {
  create(input: CreateProspectInput): Promise<Pick<Prospect, "id">>;
  findByNormalizedDomain(
    normalizedDomain: string,
  ): Promise<Pick<Prospect, "id"> | null>;
}

export interface ImportedProspectRow {
  rowNumber: number;
  businessName: string;
  website: string;
  normalizedDomain: string;
  prospectId: string;
}

export interface DuplicateProspectRow {
  rowNumber: number;
  businessName: string;
  website: string;
  normalizedDomain: string;
  prospectId: string | null;
  reason: string;
}

export interface FailedProspectRow {
  rowNumber: number;
  businessName: string;
  website: string;
  reason: string;
}

export interface CsvProspectImportResult {
  totalRows: number;
  imported: number;
  duplicates: number;
  failed: number;
  importedRows: ImportedProspectRow[];
  duplicateRows: DuplicateProspectRow[];
  failedRows: FailedProspectRow[];
}

export class CsvImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvImportFormatError";
  }
}

const supabaseProspectStore: ProspectImportStore = {
  create: createProspect,
  findByNormalizedDomain: getProspectByNormalizedDomain,
};

function parseCsv(csv: string): string[][] {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid CSV";
    throw new CsvImportFormatError(`Could not parse CSV: ${reason}`);
  }

  if (records.length === 0) {
    throw new CsvImportFormatError("CSV is empty");
  }

  return records;
}

function getRequiredColumnIndexes(header: string[]): Record<(typeof REQUIRED_COLUMNS)[number], number> {
  const normalizedHeader = header.map((column) => column.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter(
    (column) => !normalizedHeader.includes(column),
  );

  if (missing.length > 0) {
    throw new CsvImportFormatError(
      `CSV is missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  return {
    business_name: normalizedHeader.indexOf("business_name"),
    website: normalizedHeader.indexOf("website"),
  };
}

function getErrorReason(error: unknown): string {
  if (error instanceof ProspectDataError) {
    const databaseError = error.databaseError;
    if (
      typeof databaseError === "object" &&
      databaseError !== null &&
      "message" in databaseError &&
      typeof databaseError.message === "string"
    ) {
      return databaseError.message;
    }
  }
  if (error instanceof Error) return error.message;
  return "unknown import error";
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof ProspectDataError)) return false;
  const databaseError = error.databaseError;
  return (
    typeof databaseError === "object" &&
    databaseError !== null &&
    "code" in databaseError &&
    databaseError.code === "23505"
  );
}

export async function importProspectsFromCsv(
  csv: string,
  store: ProspectImportStore = supabaseProspectStore,
): Promise<CsvProspectImportResult> {
  const records = parseCsv(csv);
  const header = records[0];
  if (!header) throw new CsvImportFormatError("CSV is missing a header row");

  const indexes = getRequiredColumnIndexes(header);
  const rows = records.slice(1);
  const importedRows: ImportedProspectRow[] = [];
  const duplicateRows: DuplicateProspectRow[] = [];
  const failedRows: FailedProspectRow[] = [];
  const domainsSeenDuringImport = new Map<string, string | null>();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const businessName = (row[indexes.business_name] ?? "").trim();
    const rawWebsite = (row[indexes.website] ?? "").trim();

    if (!businessName) {
      failedRows.push({
        rowNumber,
        businessName,
        website: rawWebsite,
        reason: "business_name is required",
      });
      continue;
    }

    if (!rawWebsite) {
      failedRows.push({
        rowNumber,
        businessName,
        website: rawWebsite,
        reason: "website is required",
      });
      continue;
    }

    let normalized: ReturnType<typeof normalizeWebsite>;
    try {
      normalized = normalizeWebsite(rawWebsite);
    } catch (error) {
      failedRows.push({
        rowNumber,
        businessName,
        website: rawWebsite,
        reason: getErrorReason(error),
      });
      continue;
    }

    try {
      if (domainsSeenDuringImport.has(normalized.normalizedDomain)) {
        duplicateRows.push({
          rowNumber,
          businessName,
          website: rawWebsite,
          normalizedDomain: normalized.normalizedDomain,
          prospectId:
            domainsSeenDuringImport.get(normalized.normalizedDomain) ?? null,
          reason: "normalized domain already appeared in this import",
        });
        continue;
      }

      const existing = await store.findByNormalizedDomain(
        normalized.normalizedDomain,
      );
      if (existing) {
        domainsSeenDuringImport.set(normalized.normalizedDomain, existing.id);
        duplicateRows.push({
          rowNumber,
          businessName,
          website: rawWebsite,
          normalizedDomain: normalized.normalizedDomain,
          prospectId: existing.id,
          reason: "normalized domain already exists",
        });
        continue;
      }

      const created = await store.create({
        business_name: businessName,
        website: normalized.website,
        normalized_domain: normalized.normalizedDomain,
        workflow_status: "IMPORTED",
        logo_status: "PENDING",
      });
      domainsSeenDuringImport.set(normalized.normalizedDomain, created.id);
      importedRows.push({
        rowNumber,
        businessName,
        website: normalized.website,
        normalizedDomain: normalized.normalizedDomain,
        prospectId: created.id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        domainsSeenDuringImport.set(normalized.normalizedDomain, null);
        duplicateRows.push({
          rowNumber,
          businessName,
          website: rawWebsite,
          normalizedDomain: normalized.normalizedDomain,
          prospectId: null,
          reason: "normalized domain already exists",
        });
        continue;
      }

      failedRows.push({
        rowNumber,
        businessName,
        website: rawWebsite,
        reason: getErrorReason(error),
      });
    }
  }

  return {
    totalRows: rows.length,
    imported: importedRows.length,
    duplicates: duplicateRows.length,
    failed: failedRows.length,
    importedRows,
    duplicateRows,
    failedRows,
  };
}

export function formatCsvProspectImportResult(
  result: CsvProspectImportResult,
): string {
  const lines = [
    "CSV IMPORT COMPLETE",
    "",
    `Total rows: ${result.totalRows}`,
    `Imported: ${result.imported}`,
    `Duplicates: ${result.duplicates}`,
    `Failed: ${result.failed}`,
  ];

  if (result.duplicateRows.length > 0) {
    lines.push("", "DUPLICATES");
    for (const row of result.duplicateRows) {
      lines.push(
        `Row ${row.rowNumber}: ${row.businessName || "(missing business_name)"} (${row.website || "missing website"}) - ${row.reason}`,
      );
    }
  }

  if (result.failedRows.length > 0) {
    lines.push("", "FAILED ROWS");
    for (const row of result.failedRows) {
      lines.push(
        `Row ${row.rowNumber}: ${row.businessName || "(missing business_name)"} (${row.website || "missing website"}) - ${row.reason}`,
      );
    }
  }

  return lines.join("\n");
}
