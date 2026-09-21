import { describe, expect, it } from "vitest";

import {
  importProspectsFromCsv,
  type ProspectImportStore,
} from "../src/modules/prospects/prospect.csv-import.js";
import type { CreateProspectInput } from "../src/modules/prospects/prospect.types.js";

function createMemoryStore(existingDomains: string[] = []) {
  const records = new Map(
    existingDomains.map((domain, index) => [domain, { id: `existing-${index}` }]),
  );
  const createdInputs: CreateProspectInput[] = [];

  const store: ProspectImportStore = {
    async findByNormalizedDomain(normalizedDomain) {
      return records.get(normalizedDomain) ?? null;
    },
    async create(input) {
      const id = `created-${createdInputs.length}`;
      createdInputs.push(input);
      records.set(input.normalized_domain, { id });
      return { id };
    },
  };

  return { createdInputs, store };
}

describe("CSV prospect import", () => {
  it("imports a valid CSV with the initial workflow and logo statuses", async () => {
    const { createdInputs, store } = createMemoryStore();

    const result = await importProspectsFromCsv(
      "business_name,website\nAcme Dental,https://www.Example.com/",
      store,
    );

    expect(result).toMatchObject({
      totalRows: 1,
      imported: 1,
      duplicates: 0,
      failed: 0,
    });
    expect(createdInputs).toEqual([
      {
        business_name: "Acme Dental",
        website: "https://www.example.com/",
        normalized_domain: "example.com",
        workflow_status: "IMPORTED",
        logo_status: "PENDING",
      },
    ]);
  });

  it("reports a missing business name without aborting the import", async () => {
    const { store } = createMemoryStore();

    const result = await importProspectsFromCsv(
      "business_name,website\n,https://example.com\nGood Co,https://good.co",
      store,
    );

    expect(result).toMatchObject({ totalRows: 2, imported: 1, failed: 1 });
    expect(result.failedRows[0]).toMatchObject({
      rowNumber: 2,
      reason: "business_name is required",
    });
  });

  it("reports a missing website", async () => {
    const { store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      "business_name,website\nAcme Dental,",
      store,
    );

    expect(result).toMatchObject({ imported: 0, failed: 1 });
    expect(result.failedRows[0]?.reason).toBe("website is required");
  });

  it("reports an invalid website", async () => {
    const { store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      "business_name,website\nAcme Dental,not a URL",
      store,
    );

    expect(result).toMatchObject({ imported: 0, failed: 1 });
    expect(result.failedRows[0]?.reason).toContain("valid");
  });

  it("skips a domain that already exists in Supabase", async () => {
    const { createdInputs, store } = createMemoryStore(["example.com"]);
    const result = await importProspectsFromCsv(
      "business_name,website\nAcme Dental,https://example.com",
      store,
    );

    expect(result).toMatchObject({ imported: 0, duplicates: 1, failed: 0 });
    expect(result.duplicateRows[0]).toMatchObject({
      normalizedDomain: "example.com",
      reason: "normalized domain already exists",
    });
    expect(createdInputs).toHaveLength(0);
  });

  it("treats www and non-www URLs as duplicates", async () => {
    const { store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      [
        "business_name,website",
        "Acme One,https://www.example.com",
        "Acme Two,https://example.com",
      ].join("\n"),
      store,
    );

    expect(result).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
  });

  it("treats http and https URLs as duplicates", async () => {
    const { store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      [
        "business_name,website",
        "Acme One,http://example.com",
        "Acme Two,https://example.com",
      ].join("\n"),
      store,
    );

    expect(result).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
  });

  it("treats trailing-slash variants as duplicates", async () => {
    const { store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      [
        "business_name,website",
        "Acme One,https://example.com/",
        "Acme Two,https://example.com",
      ].join("\n"),
      store,
    );

    expect(result).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
  });

  it("imports multiple valid prospects", async () => {
    const { createdInputs, store } = createMemoryStore();
    const result = await importProspectsFromCsv(
      [
        "business_name,website",
        "Nara Pilates,https://narapilates.com",
        "Skin Hub Med Spa,https://skinhubmedspa.com",
        "FREEHAND,https://www.freehanddallas.com",
      ].join("\n"),
      store,
    );

    expect(result).toMatchObject({
      totalRows: 3,
      imported: 3,
      duplicates: 0,
      failed: 0,
    });
    expect(createdInputs.map((input) => input.normalized_domain)).toEqual([
      "narapilates.com",
      "skinhubmedspa.com",
      "freehanddallas.com",
    ]);
  });

  it("is idempotent when the same CSV is imported twice", async () => {
    const { store } = createMemoryStore();
    const csv = "business_name,website\nAcme Dental,https://example.com";

    const first = await importProspectsFromCsv(csv, store);
    const second = await importProspectsFromCsv(csv, store);

    expect(first).toMatchObject({ imported: 1, duplicates: 0 });
    expect(second).toMatchObject({ imported: 0, duplicates: 1 });
  });

  it("reports a database failure for one row and continues with later rows", async () => {
    const { store } = createMemoryStore();
    const originalCreate = store.create;
    let createAttempts = 0;
    store.create = async (input) => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("temporary database error");
      return originalCreate(input);
    };

    const result = await importProspectsFromCsv(
      [
        "business_name,website",
        "First Co,https://first.example",
        "Second Co,https://second.example",
      ].join("\n"),
      store,
    );

    expect(result).toMatchObject({ totalRows: 2, imported: 1, failed: 1 });
    expect(result.failedRows[0]?.reason).toBe("temporary database error");
  });
});
