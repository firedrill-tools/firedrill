import type { SimulationReportAttachments as ReportAttachments } from "@firedrill/simulation";
import {
  attachmentDataUrl,
  attachmentPreviewDataUrl,
  type EmbeddedReportAttachment,
  embedReportAttachments,
} from "./report-attachments";
import type {
  SimulationEvidencePage,
  SimulationProject,
  SimulationRunComparison,
  SimulationRunDetail,
  SimulationRunList,
  SimulationRunRequest,
  SimulationRunRequestList,
  SimulationSourceDocument,
  SimulationSourceKind,
  SimulationStatePage,
  SimulationToolSourceDocument,
  StartSimulationRun,
} from "./types";

interface ApiFailure {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

export type RunFileAttachment = ReportAttachments["attachments"][number];

/** Read a single selected file with the report's byte ceiling, then verify it before any rendering. */
export async function readVerifiedAttachment(
  response: Response,
  file: Pick<RunFileAttachment, "bytes" | "hash">,
): Promise<ArrayBuffer> {
  if (!response.ok)
    throw new InspectorApiError(
      response.status,
      "framework.REPORT_UNAVAILABLE",
      "The attachment could not be loaded. Retry, or reopen the run.",
    );
  if (
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > 64 * 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(file.hash)
  ) {
    await response.body?.cancel();
    throw new InspectorApiError(422, "framework.REPORT_INVALID", "The attachment metadata is invalid.");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== file.bytes) {
    await response.body?.cancel();
    throw new InspectorApiError(
      422,
      "framework.REPORT_INVALID",
      "The attachment size no longer matches its verified report.",
    );
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > file.bytes) {
          await reader.cancel();
          throw new InspectorApiError(
            422,
            "framework.REPORT_INVALID",
            "The attachment exceeded its recorded size.",
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hash = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (body.byteLength !== file.bytes || hash !== file.hash)
    throw new InspectorApiError(
      422,
      "framework.REPORT_INVALID",
      "The attachment no longer matches its verified bytes.",
    );
  return body.buffer;
}

export class InspectorApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "InspectorApiError";
    this.status = status;
    this.code = code;
  }
}

function token(): string {
  const value = document.querySelector<HTMLMetaElement>('meta[name="firedrill-token"]')?.content;
  if (value === undefined || value.length === 0 || value === "__FIREDRILL_TOKEN__") {
    throw new Error("The local inspector token is unavailable. Restart firedrill inspect.");
  }
  return value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let failure: ApiFailure = {};
    try {
      failure = (await response.json()) as ApiFailure;
    } catch {
      // The stable fallback below is more useful than a JSON parsing failure.
    }
    throw new InspectorApiError(
      response.status,
      failure.error?.code ?? "framework.REQUEST_FAILED",
      failure.error?.message ?? `Firedrill request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export const inspectorApi = {
  project: () => request<SimulationProject>("/api/v1/project"),
  refreshProject: () => request<SimulationProject>("/api/v1/project/refresh", { method: "POST" }),
  source: (kind: SimulationSourceKind, id: string) =>
    request<SimulationSourceDocument>(`/api/v1/sources/${kind}/${encodeURIComponent(id)}`),
  toolSource: (toolId: string, fileId: string) =>
    request<SimulationToolSourceDocument>(
      `/api/v1/tools/${encodeURIComponent(toolId)}/implementation/${encodeURIComponent(fileId)}`,
    ),
  runs: (options: { readonly cursor?: string; readonly limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return request<SimulationRunList>(`/api/v1/runs${query.size === 0 ? "" : `?${query.toString()}`}`);
  },
  runRequests: () => request<SimulationRunRequestList>("/api/v1/run-requests"),
  run: (runId: string) => request<SimulationRunDetail>(`/api/v1/runs/${encodeURIComponent(runId)}`),
  evidence: (runId: string, from = 1, limit = 500) =>
    request<SimulationEvidencePage>(
      `/api/v1/runs/${encodeURIComponent(runId)}/evidence?from=${from}&limit=${limit}`,
    ),
  state: (runId: string, packageId: string, namespace: string, after?: string) => {
    const query = new URLSearchParams({ packageId, namespace, limit: "100" });
    if (after !== undefined) query.set("after", after);
    return request<SimulationStatePage>(
      `/api/v1/runs/${encodeURIComponent(runId)}/state?${query.toString()}`,
    );
  },
  startRun: (input: StartSimulationRun) =>
    request<SimulationRunRequest>("/api/v1/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  compareRuns: (baselineRunId: string, candidateRunId: string) =>
    request<SimulationRunComparison>("/api/v1/comparisons", {
      method: "POST",
      body: JSON.stringify({ baselineRunId, candidateRunId }),
    }),
  cancelRun: (requestId: string) =>
    request<SimulationRunRequest>(`/api/v1/run-requests/${encodeURIComponent(requestId)}/cancel`, {
      method: "POST",
    }),
  runAttachments: (runId: string, signal?: AbortSignal) =>
    request<ReportAttachments>(
      `/api/v1/runs/${encodeURIComponent(runId)}/report/attachments`,
      signal === undefined ? {} : { signal },
    ),
  async attachmentBytes(runId: string, file: RunFileAttachment, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(
      `/api/v1/runs/${encodeURIComponent(runId)}/report/attachments/${encodeURIComponent(file.id)}`,
      {
        headers: { authorization: `Bearer ${token()}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return readVerifiedAttachment(response, file);
  },
  async report(runId: string): Promise<Blob> {
    const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/report`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!response.ok) {
      let message = `Report request failed with status ${response.status}`;
      try {
        const failure = (await response.json()) as ApiFailure;
        message = failure.error?.message ?? message;
      } catch {
        // Keep the stable fallback.
      }
      throw new InspectorApiError(response.status, "framework.REPORT_UNAVAILABLE", message);
    }
    const html = await response.text();
    const files = await inspectorApi.runAttachments(runId);
    if (
      files.runId !== runId ||
      files.attachments.length > 32 ||
      files.attachments.reduce((total, file) => total + file.bytes, 0) > 128 * 1024 * 1024
    ) {
      throw new InspectorApiError(
        422,
        "framework.REPORT_INVALID",
        "The report attachment list is invalid or exceeds the portable report limit.",
      );
    }
    const embedded: EmbeddedReportAttachment[] = [];
    for (const file of files.attachments) {
      const body = await inspectorApi.attachmentBytes(runId, file);
      const dataUrl = attachmentDataUrl(new Uint8Array(body));
      const previewDataUrl = attachmentPreviewDataUrl(dataUrl, file.mediaType);
      embedded.push({
        path: file.path,
        dataUrl,
        ...(previewDataUrl === undefined ? {} : { previewDataUrl }),
      });
    }
    return new Blob([embedReportAttachments(html, embedded)], { type: "text/html;charset=utf-8" });
  },
};
