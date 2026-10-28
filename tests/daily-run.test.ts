import { describe, expect, it, vi } from "vitest";

import { runDailyOutreach } from "../src/modules/outreach/daily-run.js";
import { slotBounds } from "../src/modules/outreach/slot.js";
import type { LeadSheetGateway, LeadSheetRow } from "../src/lib/google/lead-sheet.js";

function sheetFixture(count = 8) {
  const rows: LeadSheetRow[] = Array.from({ length: count }, (_, index) => ({
    rowNumber: index + 2,
    businessName: `Spa ${index + 1}`,
    businessEmail: `spa${index + 1}@example.com`,
    website: `https://spa${index + 1}.example`,
    outreach: "Not Sent",
    response: "No Response",
  }));
  const writeStatuses = vi.fn(async (updates: { rowNumber: number; column: "D" | "E"; value: string }[]) => {
    for (const update of updates) rows.find((row) => row.rowNumber === update.rowNumber)!.outreach = update.value;
  });
  const sheet = { readRows: vi.fn(async () => rows.map((row) => ({ ...row }))), writeStatuses } as LeadSheetGateway;
  return { rows, sheet, writeStatuses };
}

describe("sequential daily outreach", () => {
  it("sends exactly five, in top-to-bottom order, verifying each Sheet write before the next", async () => {
    const { rows, sheet, writeStatuses } = sheetFixture();
    const processed: number[] = [];
    const result = await runDailyOutreach({ sheet, processLead: async (row) => {
      if (processed.length) expect(rows[processed.at(-1)! - 2]?.outreach).toBe("Sent");
      processed.push(row.rowNumber);
      return "SENT";
    } });
    expect(result).toMatchObject({ sent: 5, reconciled: 0, rows: [2, 3, 4, 5, 6], stoppedReason: null });
    expect(processed).toEqual([2, 3, 4, 5, 6]);
    expect(writeStatuses).toHaveBeenCalledTimes(5);
    expect(rows[5]?.outreach).toBe("Not Sent");
  });

  it("stops on the first failed lead without skipping to the next", async () => {
    const { rows, sheet } = sheetFixture();
    const processLead = vi.fn(async () => { throw new Error("no verified email"); });
    const result = await runDailyOutreach({ sheet, processLead });
    expect(result.sent).toBe(0);
    expect(result.stoppedReason).toContain("no verified email");
    expect(processLead).toHaveBeenCalledTimes(1);
    expect(rows.every((row) => row.outreach === "Not Sent")).toBe(true);
  });

  it("stops before processing when the Sheet email is missing or malformed", async () => {
    for (const businessEmail of ["", "not-an-email", "one@example.com;two@example.com"]) {
      const { rows, sheet, writeStatuses } = sheetFixture();
      rows[0]!.businessEmail = businessEmail;
      const processLead = vi.fn(async () => "SENT" as const);
      const result = await runDailyOutreach({ sheet, processLead });
      expect(result.stoppedReason).toContain("Business email in column B");
      expect(processLead).not.toHaveBeenCalled();
      expect(writeStatuses).not.toHaveBeenCalled();
    }
  });

  it("reconciles a previously sent row without counting it as a new send", async () => {
    const { sheet } = sheetFixture(6);
    const result = await runDailyOutreach({ sheet, processLead: async (row) => row.rowNumber === 2 ? "RECONCILED" : "SENT" });
    expect(result).toMatchObject({ sent: 5, reconciled: 1, rows: [2, 3, 4, 5, 6, 7] });
  });

  it("refuses to continue when the Sent cell does not read back", async () => {
    const { sheet } = sheetFixture();
    sheet.writeStatuses = vi.fn(async () => {});
    const processLead = vi.fn(async () => "SENT" as const);
    const result = await runDailyOutreach({ sheet, processLead });
    expect(result.sent).toBe(0);
    expect(result.stoppedReason).toContain("readback verification");
    expect(processLead).toHaveBeenCalledTimes(1);
  });

  it("honors an external slot quota on rerun", async () => {
    const { sheet } = sheetFixture();
    let remaining = 2;
    const result = await runDailyOutreach({
      sheet,
      remainingQuota: async () => remaining,
      processLead: async (_row, allowNewSend) => {
        if (!allowNewSend) return "QUOTA_REACHED";
        remaining--;
        return "SENT";
      },
    });
    expect(result.sent).toBe(2);
    expect(result.stoppedReason).toBeNull();
  });
});

describe("Chicago send windows", () => {
  it("uses the correct UTC offset before and after daylight saving time", () => {
    expect(slotBounds("morning", new Date("2026-10-20T13:30:00Z"))).toEqual({
      start: "2026-10-20T13:30:00.000Z", end: "2026-10-20T14:15:00.000Z",
    });
    expect(slotBounds("morning", new Date("2026-11-02T14:30:00Z"))).toEqual({
      start: "2026-11-02T14:30:00.000Z", end: "2026-11-02T15:15:00.000Z",
    });
  });

  it("rejects weekends and calls outside the calendar window", () => {
    expect(() => slotBounds("morning", new Date("2026-10-18T13:30:00Z"))).toThrow("only on weekdays");
    expect(() => slotBounds("late", new Date("2026-10-20T13:30:00Z"))).toThrow("only on weekdays");
  });
});
