import {
  MONARCH_OUTREACH_BODY_TEMPLATE,
  MONARCH_OUTREACH_NO_VISUAL_BODY_TEMPLATE,
  MONARCH_OUTREACH_SENDER_NAME,
  MONARCH_OUTREACH_SIGNATURE_LABEL,
  MONARCH_OUTREACH_SUBJECT_TEMPLATE,
  MONARCH_OUTREACH_VISUAL_SENTENCE,
} from "../../config/outreach-email-template.js";
import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type { Prospect } from "../prospects/prospect.types.js";

export interface GeneratedOutreachEmail {
  body: string;
  subject: string;
  hasVisual: boolean;
}

export interface OutreachEmailStore {
  listCandidates(options: {
    businessName: string;
    limit: number;
  }): Promise<Prospect[]>;
  saveGenerated(id: string, email: GeneratedOutreachEmail): Promise<void>;
}

export interface OutreachEmailResult {
  businessName: string;
  contactEmail: string;
  email: GeneratedOutreachEmail | null;
  error: string | null;
  status: "GENERATED" | "FAILED";
}

export interface OutreachEmailBatchResult {
  failed: number;
  generated: number;
  processed: number;
  results: OutreachEmailResult[];
}

export interface GenerateOutreachEmailsOptions {
  businessName: string;
  limit?: number;
  store?: OutreachEmailStore;
}

export class OutreachEmailError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutreachEmailError";
  }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim();
}

function hasStoredVisual(prospect: Prospect): boolean {
  const images = prospect.app_image_urls;
  if (!Array.isArray(images)) return false;
  const prefix = `prospects/${prospect.id}/stitch/`;
  const paths = images.flatMap((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      return [];
    }
    const valid = (
      typeof image.screen_id === "string" &&
      image.screen_id.trim().length > 0 &&
      typeof image.storage_path === "string" &&
      image.storage_path.startsWith(prefix) &&
      /^[a-zA-Z0-9_-]+\.png$/.test(image.storage_path.slice(prefix.length))
    );
    return valid ? [image.storage_path] : [];
  });
  return new Set(paths).size >= 3;
}

function substitute(template: string, fields: Record<string, string>): string {
  return template.replace(/{{([a-z_]+)}}/g, (_, key: string) => {
    if (!(key in fields)) {
      throw new OutreachEmailError(`Unknown outreach template field: ${key}`);
    }
    return fields[key] ?? "";
  });
}

export function renderOutreachEmail(prospect: Prospect): GeneratedOutreachEmail {
  if (prospect.workflow_status !== "EMAIL_FOUND" || !prospect.email_verified) {
    throw new OutreachEmailError("Prospect is not eligible for email generation");
  }
  if (!prospect.contact_email?.trim() || !prospect.email_source_url?.trim()) {
    throw new OutreachEmailError("Verified contact email and source URL are required");
  }

  const businessName = oneLine(prospect.business_name);
  const website = oneLine(prospect.website);
  const senderName = oneLine(MONARCH_OUTREACH_SENDER_NAME);
  if (!businessName || !website || !senderName) {
    throw new OutreachEmailError("Business name, website, and sender name are required");
  }
  let parsedWebsite: URL;
  try {
    parsedWebsite = new URL(website);
  } catch {
    throw new OutreachEmailError("Prospect website is invalid");
  }
  if (!["http:", "https:"].includes(parsedWebsite.protocol)) {
    throw new OutreachEmailError("Prospect website must use HTTP or HTTPS");
  }

  const hasVisual = hasStoredVisual(prospect);
  const fields = {
    business_name: businessName,
    sender_name: senderName,
    signature_company: MONARCH_OUTREACH_SIGNATURE_LABEL,
    visual_sentence: hasVisual
      ? substitute(MONARCH_OUTREACH_VISUAL_SENTENCE, {
          business_name: businessName,
        })
      : "",
    website,
  };
  const subject = substitute(MONARCH_OUTREACH_SUBJECT_TEMPLATE, fields);
  const body = substitute(hasVisual ? MONARCH_OUTREACH_BODY_TEMPLATE : MONARCH_OUTREACH_NO_VISUAL_BODY_TEMPLATE, fields)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!subject || !body) {
    throw new OutreachEmailError("Outreach template rendered an empty subject or body");
  }
  return { body, hasVisual, subject };
}

export function createSupabaseOutreachEmailStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): OutreachEmailStore {
  return {
    async listCandidates({ businessName, limit }) {
      const { data, error } = await client
        .from("prospects")
        .select("*")
        .eq("business_name", businessName)
        .eq("workflow_status", "EMAIL_FOUND")
        .eq("email_verified", true)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        throw new OutreachEmailError(
          `Could not list email generation candidates: ${error.message}`,
          { cause: error },
        );
      }
      return data ?? [];
    },

    async saveGenerated(id, email) {
      const { data, error } = await client
        .from("prospects")
        .update({
          email_subject: email.subject,
          email_body: email.body,
          error_message: null,
          workflow_status: "EMAIL_GENERATED",
        })
        .eq("id", id)
        .eq("workflow_status", "EMAIL_FOUND")
        .eq("email_verified", true)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new OutreachEmailError(
          `Could not save generated email for prospect ${id}: ${error.message}`,
          { cause: error },
        );
      }
      if (!data) {
        throw new OutreachEmailError(
          `Prospect ${id} is no longer eligible for email generation`,
        );
      }
    },
  };
}

export async function generateOutreachEmails(
  options: GenerateOutreachEmailsOptions,
): Promise<OutreachEmailBatchResult> {
  const businessName = options.businessName.trim();
  if (!businessName) throw new OutreachEmailError("Business name is required");
  const limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new RangeError("limit must be an integer between 1 and 25");
  }
  const store = options.store ?? createSupabaseOutreachEmailStore();
  const prospects = await store.listCandidates({ businessName, limit });
  const results: OutreachEmailResult[] = [];
  for (const prospect of prospects) {
    try {
      const email = renderOutreachEmail(prospect);
      await store.saveGenerated(prospect.id, email);
      results.push({
        businessName: prospect.business_name,
        contactEmail: prospect.contact_email ?? "",
        email,
        error: null,
        status: "GENERATED",
      });
    } catch (error) {
      results.push({
        businessName: prospect.business_name,
        contactEmail: prospect.contact_email ?? "",
        email: null,
        error: error instanceof Error ? error.message : "Unknown email generation error",
        status: "FAILED",
      });
    }
  }
  return {
    failed: results.filter(({ status }) => status === "FAILED").length,
    generated: results.filter(({ status }) => status === "GENERATED").length,
    processed: results.length,
    results,
  };
}

export function formatOutreachEmailBatchResult(
  result: OutreachEmailBatchResult,
): string {
  const lines = [
    "OUTREACH EMAIL GENERATION COMPLETE",
    `Processed: ${result.processed}`,
    `Generated: ${result.generated}`,
    `Failed: ${result.failed}`,
  ];
  for (const row of result.results) {
    lines.push("", `Business: ${row.businessName}`, `Status: ${row.status}`);
    if (row.error) lines.push(`Error: ${row.error}`);
    if (row.email) {
      lines.push(
        `To: ${row.contactEmail}`,
        `Subject: ${row.email.subject}`,
        "",
        row.email.body,
      );
    }
  }
  return lines.join("\n");
}
