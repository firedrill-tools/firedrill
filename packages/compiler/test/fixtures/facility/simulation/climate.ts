import { defineToolBehavior } from "@firedrill-run/tool-sdk";

export default defineToolBehavior({
  operations: {
    "temperature.read": (input, context) =>
      context.state.get("rooms", String(input.roomId)) ?? { celsius: 0 },
    "temperature.set": (input, context) => {
      const value = { celsius: Number(input.celsius) };
      context.state.put("rooms", String(input.roomId), value);
      return value;
    },
  },
});
