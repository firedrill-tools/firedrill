import { defineToolBehavior } from "@firedrill-tools/tool-sdk";

export default defineToolBehavior({
  operations: {
    "samples.process": (input, context) => {
      const sampleId = String(input.sampleId);
      context.state.put("samples", sampleId, { status: "processed" });
      context.events.emit("sample.processed", { sampleId });
      return { status: "processed" };
    },
    "samples.read": (input, context) =>
      context.state.get("samples", String(input.sampleId)) ?? { status: "missing" },
  },
  subscriptions: {
    "record-processing": (payload, context) => {
      context.state.put("audit", String(payload.sampleId), { processed: true });
    },
  },
});
