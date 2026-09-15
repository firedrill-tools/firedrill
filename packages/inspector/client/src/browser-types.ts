import type {
  BrowserListPage,
  BrowserTestDefinitionInput,
  BrowserTestEvent,
  BrowserTestReportSummary,
  BrowserTestResult,
  SavedBrowserTest,
} from "@firedrill/browser-tests";

export type { BrowserTestDefinitionInput, BrowserTestResult };
export type BrowserSavedPage = BrowserListPage<SavedBrowserTest>;
export type BrowserReportPage = BrowserListPage<BrowserTestReportSummary>;
export interface BrowserAvailability {
  readonly available: boolean;
  readonly agentAvailable: boolean;
  readonly apiKeyConfigured: boolean;
  readonly activeRequestId?: string | null;
}
export interface BrowserRequest {
  readonly requestId: string;
  readonly status: "running" | "finished" | "failed";
  readonly events: readonly BrowserTestEvent[];
  readonly frame?: { readonly mediaType: "image/jpeg"; readonly base64: string };
  readonly result?: BrowserTestResult;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface StartBrowserRequest {
  readonly definition?: BrowserTestDefinitionInput;
  readonly path?: string;
  readonly useAgent?: boolean;
  readonly allowModel?: boolean;
  readonly allowRemote?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly parameters?: Readonly<Record<string, string>>;
  readonly stepTimeoutMs?: number;
  readonly capture?: {
    readonly screenshot: "always";
    readonly video: "off" | "always";
    readonly trace: "off" | "always";
  };
}
