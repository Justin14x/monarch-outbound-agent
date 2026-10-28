import { describe, expect, it, vi } from "vitest";

import type { LeadSheetRow } from "../src/lib/google/lead-sheet.js";
import { readSheetRecipient, synchronizeSheetRecipient } from "../src/modules/outreach/sheet-recipient.js";
import type { Prospect, UpdateProspectInput } from "../src/modules/prospects/prospect.types.js";

const row: LeadSheetRow = {
  rowNumber: 3,
  businessName: "Aesteem Aesthetics",
  businessEmail: " Lauren@AesteemAesthetics.com ",
  website: "https://aesteemaesthetics.com/",
  outreach: "Not Sent",
  response: "No Response",
};

function prospect(changes: Partial<Prospect> = {}): Prospect {
  return {
    id: "prospect-1",
    business_name: row.businessName,
    contact_email: null,
    contact_name: null,
    email_source_url: null,
    email_verified: false,
    workflow_status: "STITCH_COMPLETE",
    gmail_draft_id: null,
    gmail_message_id: null,
    sent_at: null,
    ...changes,
  } as Prospect;
}

function saver() {
  const save = vi.fn(async (_id: string, changes: UpdateProspectInput) => ({ ...prospect(), ...changes } as Prospect));
  return save;
}

describe("scheduled outreach Sheet recipient", () => {
  it("uses precisely column B and records the exact Sheet cell as its source", () => {
    expect(readSheetRecipient(row)).toEqual({
      email: "lauren@aesteemaesthetics.com",
      sourceUrl: "https://docs.google.com/spreadsheets/d/1ohJFtP__Dy2YrpXV-tMEi9BMia-l1VOGYlIFSsvUcso/edit#gid=964068620&range=B3",
    });
  });

  it("rejects missing, malformed, or multiple addresses rather than guessing", () => {
    for (const businessEmail of ["", "name @example.com", "a@example.com, b@example.com", "Name <a@example.com>"]) {
      expect(() => readSheetRecipient({ ...row, businessEmail })).toThrow("Business email in column B");
    }
  });

  it("moves a completed Stitch prospect directly to EMAIL_FOUND from the Sheet", async () => {
    const save = saver();
    await synchronizeSheetRecipient(prospect(), row, save);
    expect(save).toHaveBeenCalledWith("prospect-1", expect.objectContaining({
      contact_email: "lauren@aesteemaesthetics.com",
      email_verified: true,
      workflow_status: "EMAIL_FOUND",
      email_source_url: expect.stringContaining("range=B3"),
    }));
  });

  it("recovers EMAIL_NOT_FOUND without another website search", async () => {
    const save = saver();
    await synchronizeSheetRecipient(prospect({ workflow_status: "EMAIL_NOT_FOUND" }), row, save);
    expect(save).toHaveBeenCalledWith("prospect-1", expect.objectContaining({ workflow_status: "EMAIL_FOUND" }));
  });

  it("invalidates pre-draft generated copy if the Sheet recipient changed", async () => {
    const save = saver();
    await synchronizeSheetRecipient(prospect({
      workflow_status: "EMAIL_GENERATED",
      contact_email: "old@example.com",
      contact_name: "Old contact",
      email_subject: "Old subject",
      email_body: "Old body",
    }), row, save);
    expect(save).toHaveBeenCalledWith("prospect-1", expect.objectContaining({
      contact_email: "lauren@aesteemaesthetics.com",
      contact_name: null,
      email_subject: null,
      email_body: null,
      workflow_status: "EMAIL_FOUND",
    }));
  });

  it("refuses to silently retarget an existing draft or sent message", async () => {
    const save = saver();
    await expect(synchronizeSheetRecipient(prospect({
      workflow_status: "DRAFT_CREATED", contact_email: "old@example.com", gmail_draft_id: "draft-1",
    }), row, save)).rejects.toThrow("Gmail draft recipient; manual review required");
    await expect(synchronizeSheetRecipient(prospect({
      workflow_status: "SENT", contact_email: "old@example.com", gmail_message_id: "message-1",
    }), row, save)).rejects.toThrow("sent message recipient; manual review required");
    expect(save).not.toHaveBeenCalled();
  });
});
