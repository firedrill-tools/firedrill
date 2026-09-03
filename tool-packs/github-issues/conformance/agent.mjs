import { Octokit } from "@octokit/rest";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const invocation = JSON.parse(input);

const baseUrl = process.env.FIREDRILL_HTTP_URL;
const token = process.env.FIREDRILL_HTTP_TOKEN;
if (!baseUrl || !token) throw new Error("Firedrill HTTP binding is missing");

const octokit = new Octokit({
  auth: token,
  baseUrl,
  userAgent: "firedrill-github-issues-conformance/0.1.0",
});
const repository = { owner: "octo", repo: "example" };

async function expectFailure(call, status, message) {
  try {
    await call();
  } catch (error) {
    if (error?.status !== status || error?.response?.data?.message !== message) {
      throw new Error(`expected ${status} ${message}, received ${error?.status} ${error?.message}`);
    }
    return error;
  }
  throw new Error(`expected request to fail with ${status}`);
}

if (invocation.instruction.includes("rate-limit")) {
  const before = await octokit.rest.issues.get({ ...repository, issue_number: 42 });
  const failure = await expectFailure(
    () =>
      octokit.rest.issues.createComment({
        ...repository,
        issue_number: 42,
        body: "This write must be rejected.",
      }),
    403,
    "API rate limit exceeded",
  );
  const comments = await octokit.rest.issues.listComments({
    ...repository,
    issue_number: 42,
    per_page: 100,
  });
  if (
    before.data.comments !== 0 ||
    comments.data.length !== 0 ||
    failure.response?.headers?.["x-ratelimit-remaining"] !== "0"
  ) {
    throw new Error("rate-limited write changed the synthetic world or omitted rate-limit metadata");
  }
  process.stdout.write(JSON.stringify({ completed: true, flow: "rate-limited-comment" }));
  process.exit(0);
}

const issue = await octokit.rest.issues.get({ ...repository, issue_number: 42 });
await expectFailure(() => octokit.rest.issues.get({ ...repository, issue_number: 404 }), 404, "Not Found");
await expectFailure(
  () => octokit.rest.issues.update({ ...repository, issue_number: 42, state: "triaged" }),
  422,
  "Validation Failed",
);
await expectFailure(
  () => octokit.rest.issues.update({ ...repository, issue_number: 404, state: "closed" }),
  404,
  "Not Found",
);
await expectFailure(
  () =>
    octokit.rest.issues.createComment({
      ...repository,
      issue_number: 404,
      body: "Missing issue",
    }),
  404,
  "Not Found",
);
await expectFailure(
  () => octokit.rest.issues.createComment({ ...repository, issue_number: 42, body: "   " }),
  422,
  "Validation Failed",
);
await expectFailure(
  () => octokit.rest.issues.listComments({ ...repository, issue_number: 404 }),
  404,
  "Not Found",
);

const created = await octokit.rest.issues.createComment({
  ...repository,
  issue_number: 42,
  body: "Release evidence is attached.",
});
const comments = await octokit.rest.issues.listComments({
  ...repository,
  issue_number: 42,
  page: 1,
  per_page: 100,
});
const closed = await octokit.rest.issues.update({
  ...repository,
  issue_number: 42,
  state: "closed",
  state_reason: "completed",
});

try {
  await octokit.rest.issues.create({ ...repository, title: "Unsupported operation" });
  throw new Error("unsupported official-client operation unexpectedly succeeded");
} catch (error) {
  if (
    error?.status !== 404 ||
    error?.response?.data?.error !== "synthetic API route not found" ||
    !error?.request?.url?.startsWith(baseUrl)
  ) {
    throw error;
  }
}

if (
  issue.data.state !== "open" ||
  created.data.body !== "Release evidence is attached." ||
  created.data.user?.login !== "automation-bot" ||
  comments.data.length !== 1 ||
  comments.data[0]?.id !== created.data.id ||
  closed.data.state !== "closed" ||
  closed.data.state_reason !== "completed" ||
  closed.data.comments !== 1
) {
  throw new Error("official client observed an unexpected stateful flow");
}

process.stdout.write(JSON.stringify({ completed: true, flow: "read-comment-close" }));
