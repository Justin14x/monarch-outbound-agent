import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import {
  listProspects,
  updateProspect,
} from "../prospects/prospect.repository.js";
import type {
  Prospect,
  UpdateProspectInput,
} from "../prospects/prospect.types.js";
import {
  createLogoFinder,
  LogoNotFoundError,
  type DetectedLogo,
  type LogoFinder,
} from "./logo-finder.js";

const ASSET_BUCKET = "prospect-assets";

export interface LogoProcessingStore {
  listPending(limit: number): Promise<Prospect[]>;
  readAsset(path: string): Promise<Uint8Array>;
  updateProspect(id: string, changes: UpdateProspectInput): Promise<void>;
  uploadOriginalLogo(prospectId: string, logo: DetectedLogo): Promise<string>;
}

export interface LogoProcessingResult {
  businessName: string;
  confidence: "HIGH" | "MEDIUM" | null;
  detectedLogo: string | null;
  error: string | null;
  originalLogoPath: string | null;
  sourceUrl: string | null;
  status: "FAILED" | "FOUND" | "NOT_FOUND";
  website: string;
}

export interface LogoBatchResult {
  failed: number;
  found: number;
  notFound: number;
  processed: number;
  results: LogoProcessingResult[];
}

export interface ProcessLogoBatchOptions {
  finder?: LogoFinder;
  limit?: number;
  store?: LogoProcessingStore;
}

export class LogoStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogoStorageError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown logo-processing error";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function createSupabaseLogoProcessingStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): LogoProcessingStore {
  return {
    listPending(limit) {
      return listProspects(
        {
          limit,
          logoStatus: "PENDING",
          workflowStatus: "IMPORTED",
        },
        client,
      );
    },
    async readAsset(path) {
      const { data, error } = await client.storage.from(ASSET_BUCKET).download(path);
      if (error) {
        throw new LogoStorageError(`Could not read back ${path}: ${error.message}`, {
          cause: error,
        });
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async updateProspect(id, changes) {
      await updateProspect(id, changes, client);
    },
    async uploadOriginalLogo(prospectId, logo) {
      const path = `prospects/${prospectId}/logo/original.${logo.extension}`;
      const { data, error } = await client.storage
        .from(ASSET_BUCKET)
        .upload(path, logo.body, {
          cacheControl: "3600",
          contentType: logo.contentType,
          upsert: true,
        });
      if (error) {
        throw new LogoStorageError(`Could not upload ${path}: ${error.message}`, {
          cause: error,
        });
      }
      return data.path;
    },
  };
}

async function markFailed(
  store: LogoProcessingStore,
  prospect: Prospect,
  reason: string,
): Promise<LogoProcessingResult> {
  const conciseReason = reason.slice(0, 2_000);
  try {
    await store.updateProspect(prospect.id, {
      error_message: conciseReason,
      logo_status: "FAILED",
      workflow_status: "FAILED",
    });
  } catch (updateError) {
    return {
      businessName: prospect.business_name,
      confidence: null,
      detectedLogo: null,
      error: `${conciseReason}; could not persist failure state: ${errorMessage(updateError)}`,
      originalLogoPath: null,
      sourceUrl: null,
      status: "FAILED",
      website: prospect.website,
    };
  }

  return {
    businessName: prospect.business_name,
    confidence: null,
    detectedLogo: null,
    error: conciseReason,
    originalLogoPath: null,
    sourceUrl: null,
    status: "FAILED",
    website: prospect.website,
  };
}

async function processProspect(
  prospect: Prospect,
  finder: LogoFinder,
  store: LogoProcessingStore,
): Promise<LogoProcessingResult> {
  try {
    await store.updateProspect(prospect.id, {
      error_message: null,
      logo_status: "SEARCHING",
      workflow_status: "LOGO_SEARCHING",
    });
  } catch (error) {
    return markFailed(
      store,
      prospect,
      `Could not start logo processing: ${errorMessage(error)}`,
    );
  }

  let detected: DetectedLogo;
  try {
    detected = await finder.find({
      businessName: prospect.business_name,
      website: prospect.website,
    });
  } catch (error) {
    if (error instanceof LogoNotFoundError) {
      const reason = error.message.slice(0, 2_000);
      try {
        await store.updateProspect(prospect.id, {
          error_message: reason,
          logo_status: "NOT_FOUND",
          workflow_status: "LOGO_NOT_FOUND",
        });
        return {
          businessName: prospect.business_name,
          confidence: null,
          detectedLogo: null,
          error: reason,
          originalLogoPath: null,
          sourceUrl: null,
          status: "NOT_FOUND",
          website: prospect.website,
        };
      } catch (updateError) {
        return markFailed(
          store,
          prospect,
          `${reason}; could not persist not-found state: ${errorMessage(updateError)}`,
        );
      }
    }
    return markFailed(store, prospect, errorMessage(error));
  }

  try {
    const path = await store.uploadOriginalLogo(prospect.id, detected);
    const downloaded = await store.readAsset(path);
    if (!equalBytes(detected.body, downloaded)) {
      throw new LogoStorageError(
        `Storage read-back verification failed for ${path}: bytes did not match`,
      );
    }

    await store.updateProspect(prospect.id, {
      error_message: null,
      logo_source_url: detected.sourceUrl,
      logo_status: "FOUND",
      original_logo_url: path,
      workflow_status: "LOGO_FOUND",
    });

    const dimensions =
      detected.width !== null && detected.height !== null
        ? ` ${detected.width}x${detected.height}`
        : "";
    return {
      businessName: prospect.business_name,
      confidence: detected.confidence,
      detectedLogo: `${detected.contentType}${dimensions}`,
      error: null,
      originalLogoPath: path,
      sourceUrl: detected.sourceUrl,
      status: "FOUND",
      website: prospect.website,
    };
  } catch (error) {
    return markFailed(store, prospect, errorMessage(error));
  }
}

export async function processPendingProspectLogos(
  options: ProcessLogoBatchOptions = {},
): Promise<LogoBatchResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }

  const finder = options.finder ?? createLogoFinder();
  const store = options.store ?? createSupabaseLogoProcessingStore();
  const prospects = await store.listPending(limit);
  const results: LogoProcessingResult[] = [];

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

function tableCell(value: string | null): string {
  return (value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatLogoBatchResult(result: LogoBatchResult): string {
  const lines = [
    "LOGO FINDER COMPLETE",
    "",
    `Processed: ${result.processed}`,
    `Found: ${result.found}`,
    `Not found: ${result.notFound}`,
    `Failed: ${result.failed}`,
    "",
    "| Business | Website | Detected Logo | Source URL | Supabase Asset | Status |",
    "|---|---|---|---|---|---|",
  ];

  for (const row of result.results) {
    const status = row.confidence
      ? `${row.status} (${row.confidence})`
      : row.status;
    lines.push(
      `| ${tableCell(row.businessName)} | ${tableCell(row.website)} | ${tableCell(row.detectedLogo)} | ${tableCell(row.sourceUrl)} | ${tableCell(row.originalLogoPath)} | ${tableCell(status)} |`,
    );
    if (row.error) lines.push(`  Error: ${row.error}`);
  }

  return lines.join("\n");
}
