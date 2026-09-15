import { createHash, webcrypto } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectorApi, type RunFileAttachment, readVerifiedAttachment } from "../api";
import type { SimulationRunDetail } from "../types";
import {
  AttachmentBrowser,
  AttachmentMedia,
  AttachmentText,
  captureLogMessages,
  createAttachmentPreviewRequest,
  hasRunAttachments,
  RunAttachments,
  runLogAttachments,
} from "./run-attachments";

type RunResult = NonNullable<SimulationRunDetail["result"]>;
const hash = `sha256:${"a".repeat(64)}`;
function file(id = "screen-1", mediaType = "image/png"): RunFileAttachment {
  return {
    schemaVersion: 1,
    kind: "file",
    id,
    name: `${id}.png`,
    mediaType,
    bytes: 3,
    hash,
    redaction: { status: "not_applied", note: null },
    path: `attachments/${id}/${id}.png`,
  };
}
function result(overrides: Partial<Extract<RunResult, { status: "sealed" }>> = {}): RunResult {
  return {
    schemaVersion: 1,
    status: "sealed",
    verdict: "passed",
    identity: {
      runId: "run_attachments",
      worldInstanceId: "world_attachments",
      drillId: "inspect-record",
      targetId: "agent",
      seed: "41",
      buildHash: hash,
      packageLockHash: hash,
      trial: 1,
      trialCount: 1,
      attempt: 1,
      attemptLimit: 1,
    },
    startedAtVirtualUs: 0,
    finishedAtVirtualUs: 0,
    bindingEvidence: "issued",
    worldConsistency: "atomic",
    interactions: [],
    checkpoints: [],
    assertionResults: [],
    budgetUsage: {
      toolCalls: { limit: 100, attempted: 0, rejected: 0 },
      scheduledEvents: { limit: 100, processed: 0, exhausted: false },
    },
    evidenceRange: { fromSequence: 1, toSequence: 1 },
    stateHash: hash,
    evidenceHash: hash,
    trajectoryHash: hash,
    ...overrides,
  };
}
function capture(): NonNullable<RunResult["capture"]> {
  return {
    schemaVersion: 1,
    policies: { logs: "off", screenshots: "off", video: "off", files: "off" },
    attachments: [],
    errors: [],
    discarded: { logs: 0, screenshots: 0, video: 0, files: 0 },
  };
}
function stderrRun(): RunResult {
  return result({
    interactions: [
      {
        schemaVersion: 1,
        interactionId: "inspect-record",
        actorId: "operator",
        task: { instruction: "Inspect the record." },
        scheduledAtVirtualUs: 0,
        startedAtVirtualUs: 0,
        finishedAtVirtualUs: 0,
        bindingEvidence: "issued",
        targetResult: {
          schemaVersion: 1,
          status: "completed",
          attachments: [
            {
              schemaVersion: 1,
              kind: "process.stderr",
              text: "Traceback: helper failed\n<script>unsafe()</script>",
              truncated: true,
            },
          ],
        },
      },
    ],
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("attachment report states", () => {
  it("omits empty legacy and all-off capture sections", () => {
    expect(hasRunAttachments(result())).toBe(false);
    expect(hasRunAttachments(result({ capture: capture() }))).toBe(false);
    expect(
      renderToStaticMarkup(<RunAttachments runId="run_attachments" result={result()} reportAvailable />),
    ).toBe("");
  });
  it("shows discarded passed-run capture, capture failures, and enabled-with-no-output states", () => {
    const data = capture();
    data.policies.screenshots = "retain-on-failure";
    data.discarded.screenshots = 1;
    let html = renderToStaticMarkup(
      <RunAttachments runId="run_attachments" result={result({ capture: data })} reportAvailable />,
    );
    expect(html).toContain("Not retained after this passed run");
    expect(html).toContain("1 screenshot");
    data.discarded.screenshots = 0;
    data.errors = [
      {
        code: "capture.DRIVER_FAILED",
        message: "The screenshot driver was unavailable.",
        kind: "screenshot",
      },
    ];
    html = renderToStaticMarkup(
      <RunAttachments runId="run_attachments" result={result({ capture: data })} reportAvailable />,
    );
    expect(html).toContain("Screenshot could not complete");
    expect(html).toContain("The screenshot driver was unavailable.");
    expect(html).toContain("No attachments were retained");
  });
  it("renders process stderr as readable escaped logs with capture truncation and a download", () => {
    const data = stderrRun();
    const html = renderToStaticMarkup(
      <RunAttachments runId="run_attachments" result={data} reportAvailable />,
    );
    expect(runLogAttachments(data)).toHaveLength(1);
    expect(html).toContain("Process stderr");
    expect(html).toContain("Traceback: helper failed");
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>unsafe()");
    expect(html).toContain("truncated during capture");
    expect(html).toContain(">Download</button>");
    expect(html).not.toContain("&quot;kind&quot;");
  });
  it("uses a compact paginated filename/type list and an inline full-width selected preview", () => {
    const files = Array.from({ length: 8 }, (_, index) => file(`capture-${index}`));
    const html = renderToStaticMarkup(<AttachmentBrowser runId="run_attachments" files={files} logs={[]} />);
    expect(html).toContain("capture-4.png");
    expect(html).not.toContain("capture-5.png");
    expect(html).toContain("1–5 of 8");
    expect(html).toContain("image/png");
    expect(html).toContain('aria-label="Preview: capture-0.png"');
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("fd-details-panel");
    expect(html.indexOf('aria-label="Attachments pages"')).toBeLessThan(html.indexOf('aria-label="Preview:'));
  });
  it("leaves active types download-only and never puts remote URLs into media previews", () => {
    const html = renderToStaticMarkup(
      <AttachmentBrowser runId="run_attachments" files={[file("unsafe", "image/svg+xml")]} logs={[]} />,
    );
    expect(html).toContain("Preview is unavailable for this file type");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(
      renderToStaticMarkup(
        <AttachmentMedia
          kind="image"
          source="https://remote.test/image.png"
          name="remote.png"
          onError={() => undefined}
        />,
      ),
    ).not.toContain("<img");
  });
  it("uses manual video controls with no autoplay and paginates long logs", () => {
    const video = renderToStaticMarkup(
      <AttachmentMedia
        kind="video"
        source="blob:local-capture"
        name="replay.webm"
        onError={() => undefined}
      />,
    );
    expect(video).toContain('controls=""');
    expect(video).toContain('preload="metadata"');
    expect(video).not.toContain("autoplay");
    const text = renderToStaticMarkup(
      <AttachmentText
        text={Array.from({ length: 130 }, (_, index) => `line-${index}`).join("\n")}
        truncated
      />,
    );
    expect(text).toContain("line-99");
    expect(text).not.toContain("line-100");
    expect(text).toContain("1–100 of 130");
    expect(text).toContain("first 64 KiB");
  });
  it("unwraps only capture's exact JSONL message envelope", () => {
    expect(
      captureLogMessages(
        '{"interactionId":"inspect-record","message":"Read started"}\n{"message":"Read finished"}\n',
      ),
    ).toBe("[Inspect record] Read started\nRead finished\n");
    for (const text of [
      '{"message":"business data","extra":true}',
      '{"message":12}',
      "plain text",
      '{"message":',
    ])
      expect(captureLogMessages(text)).toBe(text);
  });
});

describe("selected preview lifecycle", () => {
  it("revokes its object URL and aborts on cleanup, without leaking late responses", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const request = createAttachmentPreviewRequest();
    expect(request.createSource(new ArrayBuffer(3), "image/png")).toBe("blob:verified");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ type: "image/png" });
    request.dispose();
    request.dispose();
    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(request.createSource(new ArrayBuffer(3), "image/png")).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not create executable or remote preview sources", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const request = createAttachmentPreviewRequest();
    for (const type of [
      "image/svg+xml",
      "text/html",
      "text/plain",
      "application/json",
      "https://remote.test",
    ])
      expect(request.createSource(new ArrayBuffer(0), type)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    request.dispose();
  });
});

describe("verified selected attachment reads", () => {
  const body = new Uint8Array([1, 2, 3]);
  const descriptor = {
    bytes: body.byteLength,
    hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
  it("verifies bytes and hash before returning them", async () => {
    vi.stubGlobal("crypto", webcrypto);
    expect(new Uint8Array(await readVerifiedAttachment(new Response(body), descriptor))).toEqual(body);
    await expect(readVerifiedAttachment(new Response(body), { ...descriptor, hash })).rejects.toThrow(
      "verified bytes",
    );
    await expect(readVerifiedAttachment(new Response(body), { ...descriptor, bytes: 4 })).rejects.toThrow(
      "verified bytes",
    );
  });
  it("rejects oversized metadata and stops a stream when it exceeds the recorded bound", async () => {
    await expect(
      readVerifiedAttachment(new Response(body), { ...descriptor, bytes: 64 * 1024 * 1024 + 1 }),
    ).rejects.toThrow("metadata is invalid");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    await expect(readVerifiedAttachment(new Response(stream), descriptor)).rejects.toThrow(
      "exceeded its recorded size",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(
      readVerifiedAttachment(new Response(body, { headers: { "content-length": "10" } }), descriptor),
    ).rejects.toThrow("size no longer matches");
  });
  it("fetches only the selected ID using the existing authenticated endpoint and abort signal", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("document", { querySelector: () => ({ content: "test-local-token" }) });
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await inspectorApi.attachmentBytes("run_attachments", { ...file(), ...descriptor }, signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/runs/run_attachments/report/attachments/screen-1");
    expect(fetcher.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: "Bearer test-local-token" },
      signal,
    });
  });
});
