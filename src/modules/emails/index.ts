export {
  createWebsiteEmailFinder,
  EmailFinderTechnicalError,
  EmailNotFoundError,
} from "./email-finder.js";
export type {
  PublicEmailPage,
  PublicEmailSearchProvider,
  VerifiedEmail,
  VerifiedEmailFinder,
  WebsiteEmailFinderOptions,
} from "./email-finder.js";
export {
  createSupabaseEmailDiscoveryStore,
  discoverProspectEmails,
  EmailDiscoveryError,
  formatEmailDiscoveryResult,
} from "./email-processor.js";
export type {
  DiscoverProspectEmailsOptions,
  EmailDiscoveryBatchResult,
  EmailDiscoveryResult,
  EmailDiscoveryStore,
} from "./email-processor.js";
export {
  createSupabaseOutreachEmailStore,
  formatOutreachEmailBatchResult,
  generateOutreachEmails,
  OutreachEmailError,
  renderOutreachEmail,
} from "./outreach-email-generator.js";
export type {
  GenerateOutreachEmailsOptions,
  GeneratedOutreachEmail,
  OutreachEmailBatchResult,
  OutreachEmailResult,
  OutreachEmailStore,
} from "./outreach-email-generator.js";
export {
  buildGmailDraftRaw,
  createGmailDrafts,
  createSupabaseGmailDraftStore,
  findConceptImagePaths,
  formatGmailDraftBatchResult,
  GmailDraftError,
} from "./gmail-draft-creator.js";
export type {
  CreateGmailDraftsOptions,
  GmailDraftBatchResult,
  GmailConceptImageStore,
  GmailDraftResult,
  GmailDraftStore,
} from "./gmail-draft-creator.js";
export {
  createSupabaseGmailDraftEnhancementStore,
  enhanceGmailDraft,
} from "./gmail-draft-enhancer.js";
export type {
  EnhanceGmailDraftOptions,
  GmailDraftEnhancementStore,
} from "./gmail-draft-enhancer.js";
