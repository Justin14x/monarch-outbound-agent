import { describe, expect, it } from "vitest";

import type { LeadSheetGateway } from "../src/lib/google/lead-sheet.js";
import { importProspectsFromLeadSheet } from "../src/modules/leads/lead-sheet-import.js";
import type { ProspectImportStore } from "../src/modules/prospects/prospect.csv-import.js";

describe("lead sheet prospect import", () => {
  it("reuses the CSV importer, preserves sheet row numbers, and is idempotent", async () => {
    const records = new Map<string, string>();
    const store: ProspectImportStore = {
      findByNormalizedDomain: async (domain) => records.has(domain) ? { id: records.get(domain)! } : null,
      create: async (input) => {
        expect(input.workflow_status).toBe("IMPORTED");
        expect(input.logo_status).toBe("PENDING");
        expect(input.email_verified).toBeUndefined();
        const id = `id-${records.size + 1}`;
        records.set(input.normalized_domain, id);
        return { id };
      },
    };
    const sheet: LeadSheetGateway = {
      readRows: async () => [
        { rowNumber: 2, businessName: "Skin Hub Med Spa", businessEmail: "hello@skinhubmedspa.com", website: "https://www.skinhubmedspa.com/", outreach: "Not Sent", response: "No Response" },
        { rowNumber: 4, businessName: "Other Spa", businessEmail: "info@otherspa.example", website: "http://otherspa.example/", outreach: "Not Sent", response: "No Response" },
        { rowNumber: 7, businessName: "Bad Spa", businessEmail: "bad@example.com", website: "not a website", outreach: "Not Sent", response: "No Response" },
      ],
      writeStatuses: async () => { throw new Error("import must not write sheet statuses"); },
    };
    const first = await importProspectsFromLeadSheet(sheet, store);
    expect(first).toMatchObject({ imported: 2, duplicates: 0, failed: 1 });
    expect(first.failedRows[0]?.rowNumber).toBe(7);
    const second = await importProspectsFromLeadSheet(sheet, store);
    expect(second).toMatchObject({ imported: 0, duplicates: 2, failed: 1 });
    expect(records.size).toBe(2);
  });
});
