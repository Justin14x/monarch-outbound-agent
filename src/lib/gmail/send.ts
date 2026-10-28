import { gmail as createGmailApi, type gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

import { getServerGoogleOAuthClient } from "./server.js";
import { MONARCH_OUTREACH_OPT_OUT_SENTENCE, MONARCH_OUTREACH_POSTAL_ADDRESS } from "../../config/outreach-email-template.js";

export interface ConfirmedSentMessage {
  id: string;
  prospectId: string;
  recipient: string;
  subject: string;
  sentAt: string;
}

export interface GmailSendGateway {
  findSentByProspectId(prospectId: string, recipient: string): Promise<ConfirmedSentMessage | null>;
  findDraftByProspectId(prospectId: string, recipient: string): Promise<string | null>;
  inspectDraft(draftId: string): Promise<{ prospectId: string; recipient: string; subject: string; hasShowcase: boolean; hasRequiredFooter: boolean } | null>;
  sendDraft(draftId: string, prospectId: string): Promise<ConfirmedSentMessage>;
}

function header(message: gmail_v1.Schema$Message, name: string): string | null {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? null;
}

function oneRecipient(message: gmail_v1.Schema$Message): string {
  const to = header(message, "To");
  if (!to || header(message, "Cc") || header(message, "Bcc") || to.includes(",") || to.includes(";")) {
    throw new Error("Gmail message must have exactly one To recipient and no Cc/Bcc");
  }
  const match = to.match(/<([^<>\s]+@[^<>\s]+)>|^([^\s<>]+@[^\s<>]+)$/);
  if (!match) throw new Error("Gmail message has an invalid To address");
  return (match[1] ?? match[2])!.toLowerCase();
}

function confirmed(message: gmail_v1.Schema$Message, prospectId: string): ConfirmedSentMessage {
  if (!message.id || !message.labelIds?.includes("SENT") || header(message, "X-Monarch-Prospect-ID") !== prospectId) {
    throw new Error("Gmail did not confirm a SENT message for this prospect");
  }
  const timestamp = Number(message.internalDate);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Gmail sent message has no timestamp");
  const subject = header(message, "Subject");
  if (!subject) throw new Error("Gmail sent message has no subject");
  return { id: message.id, prospectId, recipient: oneRecipient(message), subject, sentAt: new Date(timestamp).toISOString() };
}

function parts(root: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  return [root, ...(root.parts ?? []).flatMap(parts)];
}

function hasCombinedShowcase(message: gmail_v1.Schema$Message): boolean {
  if (message.payload?.mimeType !== "multipart/related") return false;
  const all = parts(message.payload);
  const image = all.filter((part) => /^image\/(?:jpeg|png)$/.test(part.mimeType ?? ""));
  const html = all.find((part) => part.mimeType === "text/html")?.body?.data;
  const plain = all.find((part) => part.mimeType === "text/plain")?.body?.data;
  if (image.length !== 1 || !html || !plain || !image[0]?.body?.attachmentId && !image[0]?.body?.data) return false;
  const contentId = image[0].headers?.find((item) => item.name?.toLowerCase() === "content-id")?.value?.replace(/^<|>$/g, "");
  const disposition = image[0].headers?.find((item) => item.name?.toLowerCase() === "content-disposition")?.value ?? "";
  if (!contentId || !/^inline(?:;|$)/i.test(disposition) || !/^app-screen-1\.(?:jpg|png)$/i.test(image[0].filename ?? "")) return false;
  return Buffer.from(html, "base64url").toString("utf8").includes(`src="cid:${contentId}"`);
}

function hasRequiredFooter(message: gmail_v1.Schema$Message): boolean {
  if (!message.payload) return false;
  const all = parts(message.payload);
  return ["text/plain", "text/html"].every((mimeType) => {
    const data = all.find((part) => part.mimeType === mimeType)?.body?.data;
    if (!data) return false;
    const body = Buffer.from(data, "base64url").toString("utf8");
    // The draft renderer HTML-escapes apostrophes in visible copy. Compare
    // against that rendered form without weakening the plain-text check.
    const optOutPresent = body.includes(MONARCH_OUTREACH_OPT_OUT_SENTENCE) ||
      (mimeType === "text/html" && body.includes(MONARCH_OUTREACH_OPT_OUT_SENTENCE.replaceAll("'", "&#39;")));
    return optOutPresent && body.includes(MONARCH_OUTREACH_POSTAL_ADDRESS);
  });
}

export function createGoogleGmailSendGateway(gmail: gmail_v1.Gmail): GmailSendGateway {
  return {
    async findSentByProspectId(prospectId, recipient) {
      let pageToken: string | undefined;
      let match: ConfirmedSentMessage | null = null;
      let inspected = 0;
      do {
        const { data } = await gmail.users.messages.list({
          userId: "me", labelIds: ["SENT"], maxResults: 100,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of data.messages ?? []) {
          if (!item.id) continue;
          const { data: message } = await gmail.users.messages.get({
            userId: "me", id: item.id, format: "metadata",
            metadataHeaders: ["X-Monarch-Prospect-ID", "To", "Cc", "Bcc", "Subject"],
          });
          inspected++;
          if (header(message, "X-Monarch-Prospect-ID") !== prospectId) continue;
          const record = confirmed(message, prospectId);
          // Prior deliverability tests use the same prospect header but went
          // to the owner's personal inbox, not the verified business contact.
          if (record.recipient !== recipient.toLowerCase()) continue;
          if (match && match.id !== record.id) throw new Error("Multiple sent messages exist for this prospect; manual reconciliation required");
          match = record;
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken && inspected < 1000);
      if (pageToken) throw new Error("Sent-mail scan limit reached; cannot safely exclude an earlier send");
      return match;
    },
    async inspectDraft(draftId) {
      try {
        const { data: draft } = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
        const message = draft.message;
        if (!message?.labelIds?.includes("DRAFT")) return null;
        const prospectId = header(message, "X-Monarch-Prospect-ID");
        const subject = header(message, "Subject");
        if (!prospectId || !subject) throw new Error("Gmail draft lacks Monarch prospect ID or subject");
        return {
          prospectId, recipient: oneRecipient(message), subject,
          hasShowcase: hasCombinedShowcase(message), hasRequiredFooter: hasRequiredFooter(message),
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error.code === 404 || error.code === "404")) return null;
        throw error;
      }
    },
    async findDraftByProspectId(prospectId, recipient) {
      let pageToken: string | undefined;
      let matched: string | null = null;
      do {
        const { data } = await gmail.users.drafts.list({ userId: "me", maxResults: 100, ...(pageToken ? { pageToken } : {}) });
        for (const item of data.drafts ?? []) {
          if (!item.id) continue;
          const draft = await this.inspectDraft(item.id);
          if (draft?.prospectId !== prospectId || draft.recipient !== recipient.toLowerCase()) continue;
          if (matched && matched !== item.id) throw new Error("Multiple business drafts exist for this prospect; manual review required");
          matched = item.id;
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return matched;
    },
    async sendDraft(draftId, prospectId) {
      // Gmail draft send is intentionally non-retrying. An uncertain result is
      // reconciled against Sent mail before any subsequent attempt.
      const { data } = await gmail.users.drafts.send({
        userId: "me", requestBody: { id: draftId },
      }, { retry: false });
      if (!data.id) throw new Error("Gmail send returned no message ID; reconcile before retrying");
      const { data: message } = await gmail.users.messages.get({
        userId: "me", id: data.id, format: "metadata",
        metadataHeaders: ["X-Monarch-Prospect-ID", "To", "Cc", "Bcc", "Subject"],
      });
      return confirmed(message, prospectId);
    },
  };
}

export async function getServerGmailSendGateway(): Promise<GmailSendGateway> {
  const auth = await getServerGoogleOAuthClient();
  return createGoogleGmailSendGateway(createGmailApi({ version: "v1", auth }));
}
