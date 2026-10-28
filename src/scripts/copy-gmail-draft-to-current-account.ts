import { gmail as createGmailApi, type gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

import {
  getServerGmailGateway,
  getServerGoogleOAuthClient,
} from "../lib/gmail/server.js";
import { getServerSupabaseClient } from "../lib/supabase/server.js";
import {
  buildGmailDraftRaw,
  combineEmailScreenshots,
  createSupabaseGmailConceptImageStore,
  findConceptImagePaths,
} from "../modules/emails/gmail-draft-creator.js";

function header(message: gmail_v1.Schema$MessagePart, name: string): string | null {
  return message.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function parts(root: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  return [root, ...(root.parts ?? []).flatMap(parts)];
}

async function verifyDraft(
  draftId: string,
  expected: { sender: string; recipient: string; subject: string; prospectId: string },
): Promise<void> {
  const auth = await getServerGoogleOAuthClient();
  const { data: draft } = await createGmailApi({ version: "v1", auth }).users.drafts.get({
    userId: "me",
    id: draftId,
    format: "full",
  });
  const message = draft.message;
  const root = message?.payload;
  if (!root || !message?.labelIds?.includes("DRAFT") || message.labelIds.includes("SENT")) {
    throw new Error("Copied message is not an unsent Gmail draft");
  }
  if (
    header(root, "From")?.toLowerCase() !== expected.sender.toLowerCase() ||
    header(root, "To")?.toLowerCase() !== expected.recipient.toLowerCase() ||
    header(root, "Subject") !== expected.subject ||
    header(root, "X-Monarch-Prospect-ID") !== expected.prospectId
  ) {
    throw new Error("Copied draft headers do not match the saved Skin Hub prospect");
  }
  const leaves = parts(root);
  const plain = leaves.find((item) => item.mimeType === "text/plain");
  const html = leaves.find((item) => item.mimeType === "text/html");
  const images = leaves.filter((item) => item.mimeType === "image/png" || item.mimeType === "image/jpeg");
  if (!plain?.body?.data || !html?.body?.data || images.length !== 1) {
    throw new Error("Copied draft must contain text alternatives and exactly one inline showcase image");
  }
  const htmlText = Buffer.from(html.body.data, "base64url").toString("utf8");
  if (!/^app-screen-1\.(?:png|jpg)$/.test(images[0]?.filename ?? "")) {
    throw new Error("Copied draft is missing its combined showcase image");
  }
  for (const image of images) {
    const contentId = header(image, "Content-ID")?.replace(/^<|>$/g, "");
    if (!contentId || !htmlText.includes(`cid:${contentId}`)) {
      throw new Error(`Copied draft does not reference inline image ${image.filename}`);
    }
  }
}

async function main(): Promise<void> {
  const businessName = process.argv.slice(2).join(" ").trim();
  if (!businessName) throw new Error('Usage: npm run gmail:copy-draft -- "Business Name"');

  const client = getServerSupabaseClient();
  const { data: matches, error } = await client
    .from("prospects")
    .select("*")
    .eq("business_name", businessName)
    .limit(2);
  const prospect = matches?.[0];
  if (error || matches?.length !== 1 || !prospect) {
    throw new Error(`Expected exactly one prospect named ${businessName}: ${error?.message ?? "not found or ambiguous"}`);
  }
  if (
    prospect.workflow_status !== "DRAFT_CREATED" ||
    !prospect.gmail_draft_id ||
    !prospect.email_verified ||
    !prospect.contact_email ||
    !prospect.email_subject ||
    !prospect.email_body ||
    prospect.sent_at !== null
  ) {
    throw new Error("Prospect must have an unsent, verified, previously created draft");
  }

  const { gateway, senderEmail } = await getServerGmailGateway();
  const oldDraftId = prospect.gmail_draft_id;
  const existingById = await gateway.getDraft(oldDraftId);
  let currentDraftId: string;
  if (existingById) {
    if (existingById.prospectId !== prospect.id) {
      throw new Error("Stored draft ID belongs to a different prospect in the current mailbox");
    }
    currentDraftId = existingById.id;
  } else {
    const existingByProspect = await gateway.findDraftByProspectId(prospect.id);
    if (existingByProspect) {
      currentDraftId = existingByProspect.id;
    } else {
      const paths = findConceptImagePaths(prospect);
      if (paths.length !== 3) throw new Error("Expected exactly three saved app concept images");
      const imageStore = createSupabaseGmailConceptImageStore(client);
      const images = await Promise.all(paths.map((path) => imageStore.downloadEmailImage(path)));
      const showcase = await combineEmailScreenshots(images);
      const raw = buildGmailDraftRaw(
        { ...prospect, workflow_status: "EMAIL_GENERATED" },
        senderEmail,
        showcase,
      );
      currentDraftId = await gateway.createDraft(raw);
    }
  }

  await verifyDraft(currentDraftId, {
    sender: senderEmail,
    recipient: prospect.contact_email,
    subject: prospect.email_subject,
    prospectId: prospect.id,
  });
  if (currentDraftId !== oldDraftId) {
    const { data: updated, error: updateError } = await client
      .from("prospects")
      .update({ gmail_draft_id: currentDraftId })
      .eq("id", prospect.id)
      .eq("gmail_draft_id", oldDraftId)
      .eq("workflow_status", "DRAFT_CREATED")
      .is("sent_at", null)
      .select("id,gmail_draft_id,sent_at")
      .maybeSingle();
    if (updateError || !updated || updated.gmail_draft_id !== currentDraftId || updated.sent_at !== null) {
      throw new Error(`New draft exists, but could not update the prospect: ${updateError?.message ?? "record changed"}`);
    }
  }
  console.log(`GMAIL DRAFT COPIED\nBusiness: ${businessName}\nFrom: ${senderEmail}\nTo: ${prospect.contact_email}\nSubject: ${prospect.email_subject}\nPrevious draft ID: ${oldDraftId}\nCurrent draft ID: ${currentDraftId}\nOne combined showcase image verified inline. No email was sent.`);
}

try {
  await main();
} catch (error) {
  console.error(`GMAIL DRAFT COPY FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
