let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);

const baseUrl = process.env.FIREDRILL_HTTP_URL;
const token = process.env.FIREDRILL_HTTP_TOKEN;
if (!baseUrl || !token) throw new Error("Firedrill HTTP binding is missing");

async function call(operation, arguments_, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v1/operations/work-queue/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      arguments: arguments_,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  });
  const body = await response.json();
  if (!body.outcome) throw new Error(JSON.stringify(body));
  return body.outcome;
}

const listed = await call("items.list", {});
const claimed = await call("items.claim", { id: "task-1" }, "claim-task-1");
const missingClaim = await call("items.claim", { id: "missing" }, "claim-missing");
const completed = await call("items.complete", { id: "task-1", result: "reviewed" }, "complete-task-1");
const missingCompletion = await call("items.complete", { id: "missing" }, "complete-missing");

if (
  listed.status !== "ok" ||
  claimed.status !== "ok" ||
  missingClaim.status !== "tool_error" ||
  completed.status !== "ok" ||
  missingCompletion.status !== "tool_error"
) {
  throw new Error("conformance agent observed unexpected Tool outcomes");
}

process.stdout.write(JSON.stringify({ completed: true }));
