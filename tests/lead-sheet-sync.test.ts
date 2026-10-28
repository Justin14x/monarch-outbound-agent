import { describe, expect, it, vi } from "vitest";

import type { GmailReplyGateway } from "../src/lib/gmail/server.js";
import type { LeadSheetGateway, LeadSheetRow, LeadSheetStatusUpdate } from "../src/lib/google/lead-sheet.js";
import {
  syncLeadSheetStatuses,
  type LeadSyncStore,
} from "../src/modules/leads/lead-sheet-sync.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

const SENT_AT = "2026-10-11T15:00:00.000Z";

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: "prospect-1",
    business_name: "Skin Hub Med Spa",
    website: "https://skinhubmedspa.com/",
    normalized_domain: "skinhubmedspa.com",
    workflow_status: "DRAFT_CREATED",
    gmail_message_id: null,
    sent_at: null,
    contact_email: "hello@skinhubmedspa.com",
    ...overrides,
  } as Prospect;
}

function fixture(rows: LeadSheetRow[], prospects: Prospect[]) {
  const state = rows.map((row) => ({ ...row }));
  const writes: LeadSheetStatusUpdate[] = [];
  const sheet: LeadSheetGateway = {
    readRows: async () => state.map((row) => ({ ...row })),
    writeStatuses: async (updates) => {
      writes.push(...updates);
      for (const update of updates) {
        const row = state.find((candidate) => candidate.rowNumber === update.rowNumber);
        if (!row) throw new Error("missing row");
        if (update.column === "D") row.outreach = update.value;
        else row.response = update.value;
      }
    },
  };
  const store: LeadSyncStore = { listAll: async () => prospects };
  const findFirstReply = vi.fn<GmailReplyGateway["findFirstReply"]>(async () => null);
  const gmail: GmailReplyGateway = { findFirstReply };
  return { sheet, store, gmail, state, writes, findFirstReply };
}

const lead: LeadSheetRow = {
  rowNumber: 2,
  businessName: "Skin Hub Med Spa",
  businessEmail: "hello@skinhubmedspa.com",
  website: "https://www.skinhubmedspa.com/",
  outreach: "Not Sent",
  response: "No Response",
};

describe("lead sheet synchronization", () => {
  it("never marks a Gmail draft as sent", async () => {
    const test = fixture([lead], [prospect()]);
    const result = await syncLeadSheetStatuses(test.sheet, test.gmail, test.store);
    expect(result).toMatchObject({ matched: 1, sentUpdated: 0, repliesUpdated: 0 });
    expect(test.writes).toEqual([]);
    expect(test.findFirstReply).not.toHaveBeenCalled();
  });

  it("marks confirmed sends and exact-thread replies, then stays idempotent", async () => {
    const item = prospect({ workflow_status: "SENT", gmail_message_id: "sent-1", sent_at: SENT_AT });
    const test = fixture([lead], [item]);
    test.findFirstReply.mockResolvedValue({ messageId: "reply-1", repliedAt: "2026-10-12T00:00:00.000Z" });
    const first = await syncLeadSheetStatuses(test.sheet, test.gmail, test.store);
    expect(first).toMatchObject({ matched: 1, sentUpdated: 1, repliesUpdated: 1 });
    expect(test.state[0]).toMatchObject({ outreach: "Sent", response: "Responded" });
    expect(test.findFirstReply).toHaveBeenCalledWith("sent-1", SENT_AT);
    const second = await syncLeadSheetStatuses(test.sheet, test.gmail, test.store);
    expect(second).toMatchObject({ sentUpdated: 0, repliesUpdated: 0 });
    expect(test.writes).toHaveLength(2);
  });

  it("does not mark a malformed SENT record or ambiguous sheet domain", async () => {
    const item = prospect({ workflow_status: "SENT", sent_at: SENT_AT });
    const duplicate = { ...lead, rowNumber: 3, website: "http://skinhubmedspa.com" };
    const test = fixture([lead, duplicate], [item]);
    const result = await syncLeadSheetStatuses(test.sheet, test.gmail, test.store);
    expect(result.matched).toBe(0);
    expect(result.issues.join(" ")).toContain("Multiple sheet rows");
    expect(test.writes).toEqual([]);
  });

  it("records the sent state even if Gmail reply lookup fails", async () => {
    const item = prospect({ workflow_status: "SENT", gmail_message_id: "sent-1", sent_at: SENT_AT });
    const test = fixture([lead], [item]);
    test.findFirstReply.mockRejectedValue(new Error("Gmail unavailable"));
    const result = await syncLeadSheetStatuses(test.sheet, test.gmail, test.store);
    expect(result).toMatchObject({ sentUpdated: 1, repliesUpdated: 0 });
    expect(result.issues.join(" ")).toContain("Gmail unavailable");
    expect(test.state[0]).toMatchObject({ outreach: "Sent", response: "No Response" });
  });
});
