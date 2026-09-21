import { MONARCH_STITCH_PROMPT } from "../../config/stitch-prompt.js";
import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import { validateTransparentPng } from "../logos/transparent-logo-generator.js";
import type {
  Prospect,
  UpdateProspectInput,
} from "../prospects/prospect.types.js";
import { normalizeWebsite } from "../prospects/website-normalization.js";

const ASSET_BUCKET = "prospect-assets";

export interface StitchRequest {
  business_name: string;
  has_logo: boolean;
  logo_storage_path: string | null;
  stitch_prompt: string;
  website: string;
}

export interface StitchRequestStore {
  listCandidates(
    limit: number,
    includeLogoFailuresAsNoLogo: boolean,
  ): Promise<Prospect[]>;
  readLogo(path: string): Promise<Uint8Array>;
  updateProspect(id: string, changes: UpdateProspectInput): Promise<void>;
}

export interface StitchRequestResult {
  businessName: string;
  error: string | null;
  request: StitchRequest | null;
  status: "FAILED" | "PREPARED" | "SKIPPED";
  workflowStatus: string;
}

export interface StitchRequestBatchResult {
  failed: number;
  prepared: number;
  processed: number;
  results: StitchRequestResult[];
  skipped: number;
}

export interface PrepareStitchRequestsOptions {
  includeLogoFailuresAsNoLogo?: boolean;
  limit?: number;
  masterPrompt?: string;
  store?: StitchRequestStore;
}

export class StitchRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StitchRequestError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown Stitch request preparation error";
}

function expectedTransparentLogoPath(prospectId: string): string {
  return `prospects/${prospectId}/logo/transparent.png`;
}

function isIntentionalNoLogoPath(
  prospect: Prospect,
  includeLogoFailuresAsNoLogo: boolean,
): boolean {
  if (
    prospect.workflow_status === "LOGO_NOT_FOUND" &&
    prospect.logo_status === "NOT_FOUND"
  ) {
    return true;
  }

  if (
    prospect.workflow_status === "STITCH_PENDING" &&
    prospect.transparent_logo_url === null
  ) {
    return true;
  }

  return (
    includeLogoFailuresAsNoLogo &&
    prospect.workflow_status === "FAILED" &&
    prospect.logo_status === "FAILED" &&
    prospect.transparent_logo_url === null
  );
}

function logoPathFor(
  prospect: Prospect,
  includeLogoFailuresAsNoLogo: boolean,
): string | null {
  const storedPath = prospect.transparent_logo_url?.trim() || null;

  if (
    prospect.workflow_status === "LOGO_READY" ||
    prospect.workflow_status === "STITCH_PENDING"
  ) {
    if (storedPath === null) {
      if (isIntentionalNoLogoPath(prospect, includeLogoFailuresAsNoLogo)) {
        return null;
      }
      throw new StitchRequestError(
        "transparent_logo_url is required for a logo-ready prospect",
      );
    }

    const expectedPath = expectedTransparentLogoPath(prospect.id);
    if (storedPath !== expectedPath) {
      throw new StitchRequestError(
        `transparent_logo_url must be the canonical Storage path ${expectedPath}`,
      );
    }
    return storedPath;
  }

  if (isIntentionalNoLogoPath(prospect, includeLogoFailuresAsNoLogo)) {
    if (storedPath !== null) {
      throw new StitchRequestError(
        "A no-logo Stitch request cannot reference a transparent logo",
      );
    }
    return null;
  }

  throw new StitchRequestError(
    "Prospect is not eligible for Stitch request preparation",
  );
}

export function buildStitchRequest(
  prospect: Prospect,
  options: {
    includeLogoFailuresAsNoLogo?: boolean;
    masterPrompt?: string;
  } = {},
): StitchRequest {
  const businessName = prospect.business_name.trim();
  if (!businessName) {
    throw new StitchRequestError("business_name is required");
  }

  const website = prospect.website.trim();
  if (!website) {
    throw new StitchRequestError("website is required");
  }
  try {
    normalizeWebsite(website);
  } catch (error) {
    throw new StitchRequestError(
      `website is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const masterPrompt = options.masterPrompt ?? MONARCH_STITCH_PROMPT;
  const promptTemplate = masterPrompt.trim();
  if (!promptTemplate) {
    throw new StitchRequestError("master Stitch prompt is required");
  }
  const stitchPrompt = `${promptTemplate} ${website}`;

  const logoStoragePath = logoPathFor(
    prospect,
    options.includeLogoFailuresAsNoLogo ?? false,
  );

  return {
    business_name: businessName,
    has_logo: logoStoragePath !== null,
    logo_storage_path: logoStoragePath,
    stitch_prompt: stitchPrompt,
    website,
  };
}

export function createSupabaseStitchRequestStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): StitchRequestStore {
  return {
    async listCandidates(limit, includeLogoFailuresAsNoLogo) {
      const statuses = ["LOGO_READY", "LOGO_NOT_FOUND", "STITCH_PENDING"];
      if (includeLogoFailuresAsNoLogo) statuses.push("FAILED");

      const { data, error } = await client
        .from("prospects")
        .select("*")
        .in("workflow_status", statuses)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        throw new StitchRequestError(
          `Could not list Stitch request candidates: ${error.message}`,
          { cause: error },
        );
      }
      return data ?? [];
    },
    async readLogo(path) {
      const { data, error } = await client.storage
        .from(ASSET_BUCKET)
        .download(path);
      if (error) {
        throw new StitchRequestError(
          `Transparent logo is missing or unreadable at ${path}: ${error.message}`,
          { cause: error },
        );
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async updateProspect(id, changes) {
      const { data, error } = await client
        .from("prospects")
        .update(changes)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new StitchRequestError(
          `Could not update prospect ${id}: ${error.message}`,
          { cause: error },
        );
      }
      if (!data) {
        throw new StitchRequestError(`Prospect ${id} was not found`);
      }
    },
  };
}

async function prepareProspect(
  prospect: Prospect,
  store: StitchRequestStore,
  masterPrompt: string,
  includeLogoFailuresAsNoLogo: boolean,
): Promise<StitchRequestResult> {
  try {
    const request = buildStitchRequest(prospect, {
      includeLogoFailuresAsNoLogo,
      masterPrompt,
    });

    if (request.logo_storage_path !== null) {
      const logo = await store.readLogo(request.logo_storage_path);
      await validateTransparentPng(logo);
    }

    await store.updateProspect(prospect.id, {
      error_message: null,
      stitch_prompt: request.stitch_prompt,
      stitch_status: "PENDING",
      workflow_status: "STITCH_PENDING",
    });

    return {
      businessName: request.business_name,
      error: null,
      request,
      status: "PREPARED",
      workflowStatus: "STITCH_PENDING",
    };
  } catch (error) {
    const reason = errorMessage(error).slice(0, 2_000);
    try {
      await store.updateProspect(prospect.id, {
        error_message: reason,
        stitch_status: "FAILED",
        workflow_status: "FAILED",
      });
    } catch (updateError) {
      return {
        businessName: prospect.business_name,
        error: `${reason}; could not persist failure state: ${errorMessage(updateError)}`,
        request: null,
        status: "FAILED",
        workflowStatus: "FAILED",
      };
    }

    return {
      businessName: prospect.business_name,
      error: reason,
      request: null,
      status: "FAILED",
      workflowStatus: "FAILED",
    };
  }
}

export async function prepareStitchRequests(
  options: PrepareStitchRequestsOptions = {},
): Promise<StitchRequestBatchResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }

  const masterPrompt = options.masterPrompt ?? MONARCH_STITCH_PROMPT;
  const includeLogoFailuresAsNoLogo =
    options.includeLogoFailuresAsNoLogo ?? false;
  const store = options.store ?? createSupabaseStitchRequestStore();
  const prospects = await store.listCandidates(
    limit,
    includeLogoFailuresAsNoLogo,
  );
  const results: StitchRequestResult[] = [];
  for (const prospect of prospects) {
    results.push(
      await prepareProspect(
        prospect,
        store,
        masterPrompt,
        includeLogoFailuresAsNoLogo,
      ),
    );
  }

  return {
    failed: results.filter(({ status }) => status === "FAILED").length,
    prepared: results.filter(({ status }) => status === "PREPARED").length,
    processed: results.length,
    results,
    skipped: results.filter(({ status }) => status === "SKIPPED").length,
  };
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatStitchRequestBatchResult(
  result: StitchRequestBatchResult,
): string {
  const lines = [
    "STITCH REQUEST PREPARATION COMPLETE",
    "",
    `Processed: ${result.processed}`,
    `Prepared: ${result.prepared}`,
    `Failed: ${result.failed}`,
    `Skipped: ${result.skipped}`,
    "",
    "| Business | Website | Logo Included | Prompt Prepared | Workflow Status |",
    "|---|---|---|---|---|",
  ];

  for (const row of result.results) {
    lines.push(
      `| ${tableCell(row.businessName)} | ${tableCell(row.request?.website ?? "—")} | ${row.request?.has_logo ? "Yes" : "No"} | ${row.request ? "Yes" : "No"} | ${row.workflowStatus} |`,
    );
    if (row.error) lines.push(`  Error: ${row.error}`);
  }

  const example = result.results.find(({ request }) => request !== null)?.request;
  if (example) {
    lines.push(
      "",
      "Example request payload:",
      "",
      JSON.stringify(example, null, 2),
    );
  }

  return lines.join("\n");
}
