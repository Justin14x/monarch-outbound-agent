import type {
  Tables,
  TablesInsert,
  TablesUpdate,
} from "../../types/database.generated.js";

export type Prospect = Tables<"prospects">;

export const WORKFLOW_STATUSES = [
  "IMPORTED",
  "LOGO_SEARCHING",
  "LOGO_FOUND",
  "LOGO_NOT_FOUND",
  "LOGO_PROCESSING",
  "LOGO_READY",
  "STITCH_PENDING",
  "STITCH_GENERATING",
  "STITCH_COMPLETE",
  "STITCH_FAILED",
  "EMAIL_SEARCHING",
  "EMAIL_FOUND",
  "EMAIL_NOT_FOUND",
  "EMAIL_GENERATED",
  "DRAFT_CREATED",
  "READY_FOR_REVIEW",
  "APPROVED",
  "SENT",
  "FAILED",
] as const;

export const LOGO_STATUSES = [
  "PENDING",
  "SEARCHING",
  "FOUND",
  "NOT_FOUND",
  "PROCESSING",
  "READY",
  "FAILED",
] as const;

export const STITCH_STATUSES = [
  "PENDING",
  "GENERATING",
  "COMPLETE",
  "FAILED",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type LogoStatus = (typeof LOGO_STATUSES)[number];
export type StitchStatus = (typeof STITCH_STATUSES)[number];

type DatabaseManagedFields = "created_at" | "id" | "updated_at";
type StatusFields = "logo_status" | "stitch_status" | "workflow_status";

export type CreateProspectInput = Omit<
  TablesInsert<"prospects">,
  DatabaseManagedFields | StatusFields
> & {
  logo_status?: LogoStatus | null;
  stitch_status?: StitchStatus | null;
  workflow_status?: WorkflowStatus;
};
export type UpdateProspectInput = Omit<
  TablesUpdate<"prospects">,
  DatabaseManagedFields | StatusFields
> & {
  logo_status?: LogoStatus | null;
  stitch_status?: StitchStatus | null;
  workflow_status?: WorkflowStatus;
};

export interface ListProspectsOptions {
  emailVerified?: boolean;
  limit?: number;
  offset?: number;
  logoStatus?: LogoStatus;
  stitchStatus?: StitchStatus;
  workflowStatus?: WorkflowStatus;
}
