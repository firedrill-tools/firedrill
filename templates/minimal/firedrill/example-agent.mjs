let input = "";
for await (const chunk of process.stdin) input += chunk;
const invocation = JSON.parse(input);
const requested = Number(invocation.input?.value);
const response = await fetch(`${process.env.FIREDRILL_HTTP_URL}/v1/operations/resource-store/records.set`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.FIREDRILL_HTTP_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ arguments: { value: requested }, idempotencyKey: `starter-${requested}` }),
});
const result = await response.json();
if (!response.ok || result.outcome?.status !== "ok") {
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ changed: result.outcome.value }));
