import { ToolFailure, defineToolBehavior } from "@firedrill-run/tool-sdk";

export default defineToolBehavior({
  operations: {
    "slots.reserve": (input, context) => {
      const slotId = String(input.slotId);
      const customerId = String(input.customerId);
      const current = context.state.get("slots", slotId);
      if (current?.available !== true) {
        throw new ToolFailure({ code: "OCCUPIED", message: "the slot is already occupied" });
      }
      context.state.put("slots", slotId, { available: false, reservedBy: customerId });
      context.events.emit("slot.reserved", { slotId, customerId });
      return { slotId, reserved: true };
    },
  },
});
