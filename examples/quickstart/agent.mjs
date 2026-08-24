let input = "";
for await (const chunk of process.stdin) input += chunk;

const invocation = JSON.parse(input);
const response = await fetch(`${process.env.FIREDRILL_HTTP_URL}/v1/operations/workspace/records.set`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.FIREDRILL_HTTP_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    arguments: { value: invocation.input.value },
    idempotencyKey: `set-${invocation.input.value}`,
  }),
});
const result = await response.json();

if (!response.ok) {
  process.stderr.write(JSON.stringify(result));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ operationStatus: result.outcome.status }));
