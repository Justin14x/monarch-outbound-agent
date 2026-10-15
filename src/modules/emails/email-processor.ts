import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type {
  Prospect,
  UpdateProspectInput,
} from "../prospects/prospect.types.js";
import {
  createWebsiteEmailFinder,
  EmailNotFoundError,
  type VerifiedEmail,
  type VerifiedEmailFinder,
} from "./email-finder.js";

export interface EmailDiscoveryStore {
  listCandidates(options: {
    allowStitchFailed: boolean;
    businessName?: string;
    includeNotFound: boolean;
    limit: number;
  }): Promise<Prospect[]>;
  updateProspect(id: string, changes: UpdateProspectInput): Promise<void>;
}

export interface EmailDiscoveryResult {
  businessName: string;
  contactEmail: string | null;
  contactName: string | null;
  error: string | null;
  sourceUrl: string | null;
  status: "FAILED" | "FOUND" | "NOT_FOUND";
  workflowStatus: "EMAIL_FOUND" | "EMAIL_NOT_FOUND" | "FAILED";
}

export interface EmailDiscoveryBatchResult {
  failed: number;
  found: number;
  notFound: number;
  processed: number;
  results: EmailDiscoveryResult[];
}

export interface DiscoverProspectEmailsOptions {
  allowStitchFailed?: boolean;
  businessName?: string;
  finder?: VerifiedEmailFinder;
  includeNotFound?: boolean;
  limit?: number;
  store?: EmailDiscoveryStore;
}

export class EmailDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmailDiscoveryError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown email discovery error";
}

export function createSupabaseEmailDiscoveryStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): EmailDiscoveryStore {
  return {
    async listCandidates({
      allowStitchFailed,
      businessName,
      includeNotFound,
      limit,
    }) {
      const statuses = ["STITCH_COMPLETE"];
      if (allowStitchFailed) statuses.push("STITCH_FAILED");
      if (includeNotFound) statuses.push("EMAIL_NOT_FOUND");
      let query = client
        .from("prospects")
        .select("*")
        .in("workflow_status", statuses)
        .eq("email_verified", false)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (businessName) query = query.eq("business_name", businessName);
      const { data, error } = await query;
      if (error) {
        throw new EmailDiscoveryError(
          `Could not list email discovery candidates: ${error.message}`,
          { cause: error },
        );
      }
      return data ?? [];
    },

    async updateProspect(id, changes) {
      const { data, error } = await client
        .from("prospects")
        .update(changes)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new EmailDiscoveryError(
          `Could not update prospect ${id}: ${error.message}`,
          { cause: error },
        );
      }
      if (!data) throw new EmailDiscoveryError(`Prospect ${id} was not found`);
    },
  };
}

function foundResult(prospect: Prospect, email: VerifiedEmail): EmailDiscoveryResult {
  return {
    businessName: prospect.business_name,
    contactEmail: email.email,
    contactName: email.contactName,
    error: null,
    sourceUrl: email.sourceUrl,
    status: "FOUND",
    workflowStatus: "EMAIL_FOUND",
  };
}

async function processProspect(
  prospect: Prospect,
  finder: VerifiedEmailFinder,
  store: EmailDiscoveryStore,
): Promise<EmailDiscoveryResult> {
  try {
    await store.updateProspect(prospect.id, {
      error_message: null,
      workflow_status: "EMAIL_SEARCHING",
    });
    const verified = await finder.find({
      businessName: prospect.business_name,
      website: prospect.website,
    });
    await store.updateProspect(prospect.id, {
      contact_email: verified.email,
      contact_name: verified.contactName,
      email_source_url: verified.sourceUrl,
      email_verified: true,
      error_message: null,
      workflow_status: "EMAIL_FOUND",
    });
    return foundResult(prospect, verified);
  } catch (error) {
    if (error instanceof EmailNotFoundError) {
      try {
        await store.updateProspect(prospect.id, {
          contact_email: null,
          contact_name: null,
          email_source_url: null,
          email_verified: false,
          error_message: null,
          workflow_status: "EMAIL_NOT_FOUND",
        });
      } catch (updateError) {
        return {
          businessName: prospect.business_name,
          contactEmail: null,
          contactName: null,
          error: `${error.message}; could not persist not-found state: ${errorMessage(updateError)}`,
          sourceUrl: null,
          status: "FAILED",
          workflowStatus: "FAILED",
        };
      }
      return {
        businessName: prospect.business_name,
        contactEmail: null,
        contactName: null,
        error: error.message,
        sourceUrl: null,
        status: "NOT_FOUND",
        workflowStatus: "EMAIL_NOT_FOUND",
      };
    }

    const reason = errorMessage(error).slice(0, 2_000);
    try {
      await store.updateProspect(prospect.id, {
        error_message: reason,
        retry_count: prospect.retry_count + 1,
        workflow_status: "FAILED",
      });
    } catch (updateError) {
      return {
        businessName: prospect.business_name,
        contactEmail: null,
        contactName: null,
        error: `${reason}; could not persist failure state: ${errorMessage(updateError)}`,
        sourceUrl: null,
        status: "FAILED",
        workflowStatus: "FAILED",
      };
    }
    return {
      businessName: prospect.business_name,
      contactEmail: null,
      contactName: null,
      error: reason,
      sourceUrl: null,
      status: "FAILED",
      workflowStatus: "FAILED",
    };
  }
}

export async function discoverProspectEmails(
  options: DiscoverProspectEmailsOptions = {},
): Promise<EmailDiscoveryBatchResult> {
  const limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new RangeError("limit must be an integer between 1 and 25");
  }
  const store = options.store ?? createSupabaseEmailDiscoveryStore();
  const finder = options.finder ?? createWebsiteEmailFinder();
  const prospects = await store.listCandidates({
    allowStitchFailed: options.allowStitchFailed ?? false,
    ...(options.businessName ? { businessName: options.businessName } : {}),
    includeNotFound: options.includeNotFound ?? false,
    limit,
  });
  const results: EmailDiscoveryResult[] = [];
  for (const prospect of prospects) {
    results.push(await processProspect(prospect, finder, store));
  }
  return {
    failed: results.filter(({ status }) => status === "FAILED").length,
    found: results.filter(({ status }) => status === "FOUND").length,
    notFound: results.filter(({ status }) => status === "NOT_FOUND").length,
    processed: results.length,
    results,
  };
}

export function formatEmailDiscoveryResult(
  result: EmailDiscoveryBatchResult,
): string {
  const lines = [
    "VERIFIED EMAIL DISCOVERY COMPLETE",
    "",
    `Processed: ${result.processed}`,
    `Found: ${result.found}`,
    `Not found: ${result.notFound}`,
    `Failed: ${result.failed}`,
    "",
    "| Business | Contact Name | Verified Email | Public Source | Workflow Status |",
    "|---|---|---|---|---|",
  ];
  for (const row of result.results) {
    const cell = (value: string | null) =>
      (value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(
      `| ${cell(row.businessName)} | ${cell(row.contactName)} | ${cell(row.contactEmail)} | ${cell(row.sourceUrl)} | ${row.workflowStatus} |`,
    );
    if (row.error) lines.push(`  Note: ${row.error}`);
  }
  return lines.join("\n");
}
