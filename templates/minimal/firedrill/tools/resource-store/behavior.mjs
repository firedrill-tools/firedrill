export default {
  operations: {
    "records.set": (input, context) => {
      const value = { value: Number(input.value) };
      context.state.put("records", "primary", value);
      return value;
    },
  },
};
