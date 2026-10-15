import { describe, expect, it, vi } from "vitest";
import type { sheets_v4 } from "googleapis/build/src/apis/sheets/index.js";

import { createGoogleLeadSheetGateway } from "../src/lib/google/lead-sheet.js";

function sheetsFixture(headers = ["Business name", "Business email", "Website", "Outreach", "Response"]) {
  const get = vi.fn(async () => ({ data: { values: [headers, ["Skin Hub Med Spa", "hello@example.com", "https://skinhubmedspa.com/", "Not Sent", "No Response"]] } }));
  const batchUpdate = vi.fn(async () => ({ data: {} }));
  const sheets = { spreadsheets: { values: { get, batchUpdate } } } as unknown as sheets_v4.Sheets;
  return { gateway: createGoogleLeadSheetGateway(sheets), get, batchUpdate };
}

describe("lead sheet gateway", () => {
  it("reads the configured Leads tab and preserves row numbers", async () => {
    const test = sheetsFixture();
    expect(await test.gateway.readRows()).toEqual([{
      rowNumber: 2,
      businessName: "Skin Hub Med Spa",
      website: "https://skinhubmedspa.com/",
      outreach: "Not Sent",
      response: "No Response",
    }]);
    expect(test.get).toHaveBeenCalledWith(expect.objectContaining({ range: "Leads!A1:E1000" }));
  });

  it("rejects changed headers before writing anything", async () => {
    const test = sheetsFixture(["Wrong", "Business email", "Website", "Outreach", "Response"]);
    await expect(test.gateway.readRows()).rejects.toThrow("headers have changed");
    expect(test.batchUpdate).not.toHaveBeenCalled();
  });

  it("writes only validated dropdown values in D and E", async () => {
    const test = sheetsFixture();
    await test.gateway.writeStatuses([
      { rowNumber: 2, column: "D", value: "Sent" },
      { rowNumber: 2, column: "E", value: "Responded" },
    ]);
    expect(test.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: "Leads!D2", values: [["Sent"]] },
          { range: "Leads!E2", values: [["Responded"]] },
        ],
      },
    }));
    await expect(test.gateway.writeStatuses([{ rowNumber: 1, column: "D", value: "Sent" }]))
      .rejects.toThrow("outside lead rows");
    expect(test.batchUpdate).toHaveBeenCalledTimes(1);
  });
});
