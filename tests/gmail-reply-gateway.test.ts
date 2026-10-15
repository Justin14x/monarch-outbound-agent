import { describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

import { createGoogleGmailReplyGateway } from "../src/lib/gmail/server.js";

function gmailFixture(sentLabels = ["SENT"]) {
  const getMessage = vi.fn(async () => ({
    data: { id: "sent-1", threadId: "thread-1", labelIds: sentLabels, payload: { headers: [{ name: "To", value: "Skin Hub <hello@skinhubmedspa.com>" }] } },
  }));
  const getThread = vi.fn(async () => ({
    data: {
      messages: [
        { id: "sent-1", internalDate: "1791730800000", payload: { headers: [{ name: "From", value: "contact.monarchsystems@gmail.com" }] } },
        { id: "other", internalDate: "1791817200000", payload: { headers: [{ name: "From", value: "other@example.com" }] } },
        { id: "reply-1", internalDate: "1791817260000", payload: { headers: [{ name: "From", value: "Skin Hub <hello@skinhubmedspa.com>" }] } },
      ],
    },
  }));
  const gmail = { users: { messages: { get: getMessage }, threads: { get: getThread } } } as unknown as gmail_v1.Gmail;
  return { gateway: createGoogleGmailReplyGateway(gmail), getMessage, getThread };
}

describe("Gmail reply metadata", () => {
  it("accepts only a reply from the exact contact in the confirmed sent thread", async () => {
    const test = gmailFixture();
    const reply = await test.gateway.findFirstReply(
      "sent-1", "2026-10-11T15:00:00.000Z",
    );
    expect(reply).toMatchObject({ messageId: "reply-1" });
    expect(test.getMessage).toHaveBeenCalledWith(expect.objectContaining({ format: "metadata" }));
    expect(test.getThread).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-1", format: "metadata" }));
  });

  it("rejects an unsent message before inspecting its thread", async () => {
    const test = gmailFixture(["DRAFT"]);
    await expect(test.gateway.findFirstReply("sent-1", "2026-10-11T15:00:00.000Z"))
      .rejects.toThrow("not a confirmed sent message");
    expect(test.getThread).not.toHaveBeenCalled();
  });

  it("does not treat other senders as replies", async () => {
    const test = gmailFixture();
    test.getThread.mockResolvedValueOnce({ data: { messages: [{ id: "other", internalDate: "1791817200000", payload: { headers: [{ name: "From", value: "different@example.com" }] } }] } });
    expect(await test.gateway.findFirstReply("sent-1", "2026-10-11T15:00:00.000Z")).toBeNull();
  });

  it("refuses to infer a recipient from a sent message without a single To address", async () => {
    const test = gmailFixture();
    test.getMessage.mockResolvedValueOnce({ data: { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"], payload: { headers: [{ name: "To", value: "a@example.com, b@example.com" }] } } });
    await expect(test.gateway.findFirstReply("sent-1", "2026-10-11T15:00:00.000Z"))
      .rejects.toThrow("exactly one To recipient");
    expect(test.getThread).not.toHaveBeenCalled();
  });
});
