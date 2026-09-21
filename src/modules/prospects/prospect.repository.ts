import {
  getServerSupabaseClient,
  type MonarchServerSupabaseClient,
} from "../../lib/supabase/server.js";
import type {
  CreateProspectInput,
  ListProspectsOptions,
  Prospect,
  UpdateProspectInput,
} from "./prospect.types.js";

export class ProspectDataError extends Error {
  constructor(
    operation: string,
    public readonly databaseError: unknown,
  ) {
    super(`Could not ${operation} prospect`, { cause: databaseError });
    this.name = "ProspectDataError";
  }
}

export class ProspectNotFoundError extends Error {
  constructor(id: string) {
    super(`Prospect ${id} was not found`);
    this.name = "ProspectNotFoundError";
  }
}

export async function createProspect(
  input: CreateProspectInput,
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): Promise<Prospect> {
  const { data, error } = await client
    .from("prospects")
    .insert(input)
    .select("*")
    .single();

  if (error) throw new ProspectDataError("create", error);
  return data;
}

export async function getProspect(
  id: string,
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): Promise<Prospect | null> {
  const { data, error } = await client
    .from("prospects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new ProspectDataError("read", error);
  return data;
}

export async function listProspects(
  options: ListProspectsOptions = {},
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): Promise<Prospect[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative integer");
  }

  let query = client
    .from("prospects")
    .select("*")
    .order("created_at", { ascending: false });

  if (options.workflowStatus !== undefined) {
    query = query.eq("workflow_status", options.workflowStatus);
  }

  if (options.stitchStatus !== undefined) {
    query = query.eq("stitch_status", options.stitchStatus);
  }

  if (options.logoStatus !== undefined) {
    query = query.eq("logo_status", options.logoStatus);
  }

  if (options.emailVerified !== undefined) {
    query = query.eq("email_verified", options.emailVerified);
  }

  const { data, error } = await query.range(offset, offset + limit - 1);

  if (error) throw new ProspectDataError("list", error);
  return data ?? [];
}

export async function updateProspect(
  id: string,
  changes: UpdateProspectInput,
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): Promise<Prospect> {
  const { data, error } = await client
    .from("prospects")
    .update(changes)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) throw new ProspectDataError("update", error);
  if (!data) throw new ProspectNotFoundError(id);
  return data;
}

export async function deleteProspect(
  id: string,
  client: MonarchServerSupabaseClient = getServerSupabaseClient(),
): Promise<void> {
  const { data, error } = await client
    .from("prospects")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) throw new ProspectDataError("delete", error);
  if (!data) throw new ProspectNotFoundError(id);
}
