import { sheets as createSheetsApi, type sheets_v4 } from "googleapis/build/src/apis/sheets/index.js";

import {
  LEAD_SHEET_HEADERS,
  LEAD_SHEET_LAST_ROW,
  LEAD_SHEET_SPREADSHEET_ID,
  LEAD_SHEET_TAB,
} from "../../config/lead-sheet.js";
import { getServerGoogleOAuthClient } from "../gmail/server.js";

export interface LeadSheetRow {
  rowNumber: number;
  businessName: string;
  businessEmail: string;
  website: string;
  outreach: string;
  response: string;
}

export interface LeadSheetStatusUpdate {
  rowNumber: number;
  column: "D" | "E";
  value: "Sent" | "Responded";
}

export interface LeadSheetGateway {
  readRows(): Promise<LeadSheetRow[]>;
  writeStatuses(updates: LeadSheetStatusUpdate[]): Promise<void>;
}

export function createGoogleLeadSheetGateway(sheets: sheets_v4.Sheets): LeadSheetGateway {
  return {
    async readRows() {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: LEAD_SHEET_SPREADSHEET_ID,
        range: `${LEAD_SHEET_TAB}!A1:E${LEAD_SHEET_LAST_ROW}`,
        valueRenderOption: "FORMATTED_VALUE",
      });
      const values = data.values ?? [];
      const headers = values[0] ?? [];
      if (LEAD_SHEET_HEADERS.some((header, index) => headers[index]?.trim() !== header)) {
        throw new Error("Lead sheet headers have changed; no statuses were written");
      }
      return values.slice(1).flatMap((row, index) => {
        const businessName = row[0]?.trim() ?? "";
        const website = row[2]?.trim() ?? "";
        if (!businessName && !website) return [];
        return [{
          rowNumber: index + 2,
          businessName,
          businessEmail: row[1]?.trim() ?? "",
          website,
          outreach: row[3]?.trim() ?? "",
          response: row[4]?.trim() ?? "",
        }];
      });
    },
    async writeStatuses(updates) {
      if (updates.length === 0) return;
      for (const update of updates) {
        if (!Number.isInteger(update.rowNumber) || update.rowNumber < 2 || update.rowNumber > LEAD_SHEET_LAST_ROW) {
          throw new Error("Refusing to write outside lead rows");
        }
        if (
          !(
            (update.column === "D" && update.value === "Sent") ||
            (update.column === "E" && update.value === "Responded")
          )
        ) throw new Error("Refusing invalid lead status update");
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: LEAD_SHEET_SPREADSHEET_ID,
        requestBody: {
          valueInputOption: "RAW",
          data: updates.map((update) => ({
            range: `${LEAD_SHEET_TAB}!${update.column}${update.rowNumber}`,
            values: [[update.value]],
          })),
        },
      });
    },
  };
}

export async function getServerLeadSheetGateway(): Promise<LeadSheetGateway> {
  const auth = await getServerGoogleOAuthClient();
  return createGoogleLeadSheetGateway(createSheetsApi({ version: "v4", auth }));
}
