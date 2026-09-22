import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type {
  Prospect,
  UpdateProspectInput,
} from "../prospects/prospect.types.js";
import {
  createOpenAITransparentLogoGenerator,
  type OriginalLogoInput,
  preserveExistingTransparentLogo,
  type TransparentLogoGenerator,
  validateTransparentPng,
} from "./transparent-logo-generator.js";

const ASSET_BUCKET = "prospect-assets";

export interface TransparentLogoStore {
  downloadOriginal(path: string): Promise<OriginalLogoInput>;
  listEligible(limit: number): Promise<Prospect[]>;
  readExistingTransparent(prospectId: string): Promise<Uint8Array | null>;
  readStored(path: string): Promise<Uint8Array>;
  updateProspect(id: string, changes: UpdateProspectInput): Promise<void>;
  uploadTransparent(prospectId: string, body: Uint8Array): Promise<string>;
}

export interface TransparentLogoProcessingResult {
  businessName: string;
  error: string | null;
  originalLogoPath: string | null;
  reusedExistingAsset: boolean;
  status: "FAILED" | "READY" | "SKIPPED";
  transparentLogoPath: string | null;
}

export interface TransparentLogoBatchResult {
  failed: number;
  processed: number;
  ready: number;
  results: TransparentLogoProcessingResult[];
  skipped: number;
}

export interface ProcessTransparentLogoOptions {
  generator?: TransparentLogoGenerator;
  limit?: number;
  store?: TransparentLogoStore;
}

export class TransparentLogoStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransparentLogoStorageError";
  }
}

function transparentPath(prospectId: string): string {
  return `prospects/${prospectId}/logo/transparent.png`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown transparent-logo processing error";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function isEligible(prospect: Prospect): prospect is Prospect & {
  original_logo_url: string;
} {
  return (
    prospect.workflow_status === "LOGO_FOUND" &&
    prospect.logo_status === "FOUND" &&
    prospect.original_logo_url !== null
  );
}

export function createSupabaseTransparentLogoStore(
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): TransparentLogoStore {
  async function download(path: string): Promise<Uint8Array> {
    const { data, error } = await client.storage.from(ASSET_BUCKET).download(path);
    if (error) {
      throw new TransparentLogoStorageError(
        `Could not download ${path}: ${error.message}`,
        { cause: error },
      );
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  return {
    async downloadOriginal(path) {
      return {
        body: await download(path),
        filename: path.split("/").at(-1) ?? "original-logo",
      };
    },
    async listEligible(limit) {
      const { data, error } = await client
        .from("prospects")
        .select("*")
        .eq("workflow_status", "LOGO_FOUND")
        .eq("logo_status", "FOUND")
        .not("original_logo_url", "is", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        throw new TransparentLogoStorageError(
          `Could not list eligible prospects: ${error.message}`,
          { cause: error },
        );
      }
      return data ?? [];
    },
    async readExistingTransparent(prospectId) {
      const path = transparentPath(prospectId);
      const folder = `prospects/${prospectId}/logo`;
      const { data: objects, error } = await client.storage
        .from(ASSET_BUCKET)
        .list(folder, { limit: 100, search: "transparent.png" });
      if (error) {
        throw new TransparentLogoStorageError(
          `Could not check ${path}: ${error.message}`,
          { cause: error },
        );
      }
      const exists = objects.some(({ name }) => name === "transparent.png");
      return exists ? download(path) : null;
    },
    readStored: download,
    async updateProspect(id, changes) {
      const { data, error } = await client
        .from("prospects")
        .update(changes)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new TransparentLogoStorageError(
          `Could not update prospect ${id}: ${error.message}`,
          { cause: error },
        );
      }
      if (!data) {
        throw new TransparentLogoStorageError(`Prospect ${id} was not found`);
      }
    },
    async uploadTransparent(prospectId, body) {
      const path = transparentPath(prospectId);
      const { data, error } = await client.storage
        .from(ASSET_BUCKET)
        .upload(path, body, {
          cacheControl: "3600",
          contentType: "image/png",
          upsert: true,
        });
      if (error) {
        throw new TransparentLogoStorageError(
          `Could not upload ${path}: ${error.message}`,
          { cause: error },
        );
      }
      return data.path;
    },
  };
}

async function markFailed(
  prospect: Prospect,
  store: TransparentLogoStore,
  reason: string,
): Promise<TransparentLogoProcessingResult> {
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
      error: `${conciseReason}; could not persist failure state: ${errorMessage(updateError)}`,
      originalLogoPath: prospect.original_logo_url,
      reusedExistingAsset: false,
      status: "FAILED",
      transparentLogoPath: null,
    };
  }

  return {
    businessName: prospect.business_name,
    error: conciseReason,
    originalLogoPath: prospect.original_logo_url,
    reusedExistingAsset: false,
    status: "FAILED",
    transparentLogoPath: null,
  };
}

async function markReady(
  prospect: Prospect,
  store: TransparentLogoStore,
  path: string,
  reusedExistingAsset: boolean,
): Promise<TransparentLogoProcessingResult> {
  await store.updateProspect(prospect.id, {
    error_message: null,
    logo_status: "READY",
    transparent_logo_url: path,
    workflow_status: "LOGO_READY",
  });
  return {
    businessName: prospect.business_name,
    error: null,
    originalLogoPath: prospect.original_logo_url,
    reusedExistingAsset,
    status: "READY",
    transparentLogoPath: path,
  };
}

async function processProspect(
  prospect: Prospect,
  generator: TransparentLogoGenerator,
  store: TransparentLogoStore,
): Promise<TransparentLogoProcessingResult> {
  if (!isEligible(prospect)) {
    return {
      businessName: prospect.business_name,
      error: "Prospect is not eligible for transparent-logo processing",
      originalLogoPath: prospect.original_logo_url,
      reusedExistingAsset: false,
      status: "SKIPPED",
      transparentLogoPath: prospect.transparent_logo_url,
    };
  }

  try {
    await store.updateProspect(prospect.id, {
      error_message: null,
      logo_status: "PROCESSING",
      workflow_status: "LOGO_PROCESSING",
    });

    const original = await store.downloadOriginal(prospect.original_logo_url);
    const preservedOriginal = await preserveExistingTransparentLogo(original);
    if (preservedOriginal !== null) {
      const path = await store.uploadTransparent(
        prospect.id,
        preservedOriginal,
      );
      const stored = await store.readStored(path);
      if (!equalBytes(preservedOriginal, stored)) {
        throw new TransparentLogoStorageError(
          `Storage read-back verification failed for ${path}: bytes did not match`,
        );
      }
      await validateTransparentPng(stored);
      return await markReady(prospect, store, path, true);
    }

    const existing = await store.readExistingTransparent(prospect.id);
    if (existing) {
      await validateTransparentPng(existing);
      return await markReady(
        prospect,
        store,
        transparentPath(prospect.id),
        true,
      );
    }

    const generated = await generator.generate(original);
    const validated = await validateTransparentPng(generated);
    const path = await store.uploadTransparent(prospect.id, validated.body);
    const stored = await store.readStored(path);
    if (!equalBytes(validated.body, stored)) {
      throw new TransparentLogoStorageError(
        `Storage read-back verification failed for ${path}: bytes did not match`,
      );
    }
    await validateTransparentPng(stored);
    return await markReady(prospect, store, path, false);
  } catch (error) {
    return markFailed(prospect, store, errorMessage(error));
  }
}

export async function processTransparentLogos(
  options: ProcessTransparentLogoOptions = {},
): Promise<TransparentLogoBatchResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }

  const generator =
    options.generator ?? createOpenAITransparentLogoGenerator();
  const store = options.store ?? createSupabaseTransparentLogoStore();
  const prospects = await store.listEligible(limit);
  const results: TransparentLogoProcessingResult[] = [];
  for (const prospect of prospects) {
    results.push(await processProspect(prospect, generator, store));
  }

  return {
    failed: results.filter(({ status }) => status === "FAILED").length,
    processed: results.length,
    ready: results.filter(({ status }) => status === "READY").length,
    results,
    skipped: results.filter(({ status }) => status === "SKIPPED").length,
  };
}

function tableCell(value: string | null): string {
  return (value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatTransparentLogoBatchResult(
  result: TransparentLogoBatchResult,
): string {
  const lines = [
    "TRANSPARENT LOGO PROCESSING COMPLETE",
    "",
    `Processed: ${result.processed}`,
    `Ready: ${result.ready}`,
    `Failed: ${result.failed}`,
    `Skipped: ${result.skipped}`,
    "",
    "| Business | Original Logo | Transparent Logo | Status |",
    "|---|---|---|---|",
  ];
  for (const row of result.results) {
    const status = row.reusedExistingAsset
      ? `${row.status} (existing valid asset reused)`
      : row.status;
    lines.push(
      `| ${tableCell(row.businessName)} | ${tableCell(row.originalLogoPath)} | ${tableCell(row.transparentLogoPath)} | ${status} |`,
    );
    if (row.error) lines.push(`  Error: ${row.error}`);
  }
  return lines.join("\n");
}
