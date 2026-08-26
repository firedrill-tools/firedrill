let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input);

const baseUrl = process.env.FIREDRILL_HTTP_URL;
const token = process.env.FIREDRILL_HTTP_TOKEN;
if (!baseUrl || !token) throw new Error("Firedrill HTTP binding is missing");

const listedResponse = await fetch(`${baseUrl}/api/work-items?status=available&limit=10`, {
  headers: { authorization: `Bearer ${token}` },
});
const listed = await listedResponse.json();

async function claim(id, idempotencyKey) {
  const basic = Buffer.from(`firedrill:${token}`, "utf8").toString("base64");
  return fetch(`${baseUrl}/api/work-items/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "idempotency-key": idempotencyKey },
  });
}

async function complete(id, idempotencyKey, result) {
  return fetch(
    `${baseUrl}/api/work-items/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`,
    {
      method: "PATCH",
      headers: { "content-type": "text/plain; charset=utf-8", "idempotency-key": idempotencyKey },
      body: result,
    },
  );
}

const claimed = await claim("task-1", "claim-task-1");
const missingClaim = await claim("missing", "claim-missing");
const completed = await complete("task-1", "complete-task-1", "reviewed");
const missingCompletion = await complete("missing", "complete-missing", "not-used");

if (
  !listedResponse.ok ||
  listed.data?.items?.length !== 2 ||
  listed.meta?.count !== 2 ||
  claimed.status !== 204 ||
  missingClaim.status !== 404 ||
  !completed.ok ||
  completed.headers.get("x-item-status") !== "completed" ||
  (await completed.text()) !== "completed\n" ||
  missingCompletion.status !== 404
) {
  throw new Error("conformance agent observed unexpected Tool outcomes");
}

process.stdout.write(JSON.stringify({ completed: true }));
