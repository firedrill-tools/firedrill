let input = "";
for await (const chunk of process.stdin) input += chunk;

const invocation = JSON.parse(input);
const response = await fetch(`${process.env.FIREDRILL_HTTP_URL}/api/records/primary`, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    "idempotency-key": `${invocation.runId}-${invocation.interactionId}`,
    "x-api-key": process.env.FIREDRILL_HTTP_TOKEN,
  },
  body: JSON.stringify({ value: invocation.input.value }),
});
const result = await response.json();

if (!response.ok) {
  process.stderr.write(JSON.stringify(result));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ storedValue: result.value }));
