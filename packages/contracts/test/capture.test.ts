import { describe, expect, it } from "vitest";
import { RunCaptureSchema, RunResultSchema } from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const result = {
  schemaVersion: 1,
  identity: {
    runId: "run_capture123",
    worldInstanceId: "world_capture123",
    drillId: "inspect",
    targetId: "agent",
    buildHash: hash,
    packageLockHash: hash,
    seed: "1",
    trial: 1,
    trialCount: 1,
    attempt: 1,
    attemptLimit: 1,
  },
  startedAtVirtualUs: 0,
  finishedAtVirtualUs: 0,
  bindingEvidence: "observed",
  worldConsistency: "atomic",
  interactions: [],
  checkpoints: [],
  budgetUsage: {
    toolCalls: { limit: 10, attempted: 0, rejected: 0 },
    scheduledEvents: { limit: 10, processed: 0, exhausted: false },
  },
  status: "sealed",
  verdict: "passed",
  assertionResults: [],
  evidenceRange: { fromSequence: 1, toSequence: 1 },
  stateHash: hash,
  evidenceHash: hash,
  trajectoryHash: hash,
};
const capture = {
  schemaVersion: 1,
  policies: { logs: "always", screenshots: "off", video: "off", files: "off" },
  attachments: [
    {
      kind: "log",
      policy: "always",
      attachment: {
        schemaVersion: 1,
        kind: "file",
        id: "capture-log",
        name: "log.txt",
        mediaType: "text/plain",
        bytes: 4,
        hash,
        redaction: { status: "not_applied", note: null },
      },
    },
  ],
  errors: [],
  discarded: { logs: 0, screenshots: 0, video: 0, files: 0 },
};

describe("run supporting capture contract", () => {
  it("omits capture for old results without changing existing fields or hashes", () => {
    expect(RunResultSchema.parse(result)).toEqual(result);
    expect(RunResultSchema.parse({ ...result, capture })).toEqual({ ...result, capture });
  });
  it("rejects duplicated IDs, mismatched policies and executable or path-bearing metadata", () => {
    expect(
      RunCaptureSchema.safeParse({
        ...capture,
        attachments: [...capture.attachments, ...capture.attachments],
      }).success,
    ).toBe(false);
    expect(
      RunCaptureSchema.safeParse({ ...capture, policies: { ...capture.policies, logs: "off" } }).success,
    ).toBe(false);
    expect(RunCaptureSchema.safeParse({ ...capture, driver: () => undefined }).success).toBe(false);
    expect(
      RunCaptureSchema.safeParse({
        ...capture,
        attachments: [{ ...capture.attachments[0], path: "/private/file" }],
      }).success,
    ).toBe(false);
  });
  it("rejects mismatched preview MIME kinds and unbounded diagnostics", () => {
    expect(
      RunCaptureSchema.safeParse({
        ...capture,
        attachments: [{ ...capture.attachments[0], kind: "screenshot" }],
      }).success,
    ).toBe(false);
    expect(
      RunCaptureSchema.safeParse({
        ...capture,
        errors: Array.from({ length: 257 }, () => ({ code: "capture.UNAVAILABLE", message: "Unavailable" })),
      }).success,
    ).toBe(false);
  });
});
