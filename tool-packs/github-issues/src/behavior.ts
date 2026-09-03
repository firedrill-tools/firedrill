import { defineToolBehavior } from "@firedrill/tool-sdk";

const API_VERSION = "2026-03-10";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function one(values: readonly string[] | undefined, name: string): string | undefined {
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new TypeError(`${name} must be supplied at most once`);
  return values[0];
}

function optionalPage(value: string | undefined, name: string, maximum?: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw new TypeError(`${name} is outside its supported range`);
  }
  return parsed;
}

function identity(input: Readonly<Record<string, unknown>>) {
  return {
    owner: requiredString(input.owner, "owner"),
    repo: requiredString(input.repo, "repo"),
    issueNumber: requiredInteger(input.issueNumber, "issueNumber"),
  };
}

function issueKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${String(issueNumber)}`;
}

function issueFromState(value: Readonly<Record<string, unknown>>) {
  return {
    owner: requiredString(value.owner, "issue.owner"),
    repo: requiredString(value.repo, "issue.repo"),
    number: requiredInteger(value.number, "issue.number"),
    id: requiredInteger(value.id, "issue.id"),
    nodeId: requiredString(value.nodeId, "issue.nodeId"),
    title: requiredString(value.title, "issue.title"),
    body: typeof value.body === "string" ? value.body : "",
    state: value.state === "closed" ? "closed" : "open",
    ...(typeof value.stateReason === "string" ? { stateReason: value.stateReason } : {}),
    locked: value.locked === true,
    comments: typeof value.comments === "number" ? value.comments : 0,
    author: requiredString(value.author, "issue.author"),
    createdAt: requiredString(value.createdAt, "issue.createdAt"),
    updatedAt: requiredString(value.updatedAt, "issue.updatedAt"),
    ...(typeof value.closedAt === "string" ? { closedAt: value.closedAt } : {}),
  };
}

function commentFromState(value: Readonly<Record<string, unknown>>) {
  return {
    owner: requiredString(value.owner, "comment.owner"),
    repo: requiredString(value.repo, "comment.repo"),
    issueNumber: requiredInteger(value.issueNumber, "comment.issueNumber"),
    id: requiredInteger(value.id, "comment.id"),
    nodeId: requiredString(value.nodeId, "comment.nodeId"),
    body: requiredString(value.body, "comment.body"),
    author: requiredString(value.author, "comment.author"),
    createdAt: requiredString(value.createdAt, "comment.createdAt"),
    updatedAt: requiredString(value.updatedAt, "comment.updatedAt"),
  };
}

function actorLogin(attributes: Readonly<Record<string, unknown>>, fallback: string): string {
  return typeof attributes.login === "string" && attributes.login.length > 0 ? attributes.login : fallback;
}

function timestamp(nowUs: number): string {
  return new Date(Math.floor(nowUs / 1_000)).toISOString();
}

function providerUser(login: string) {
  let id = 17;
  for (const character of login) id = (id * 31 + (character.codePointAt(0) ?? 0)) % 2_000_000_000;
  return {
    login,
    id,
    node_id: `U_synthetic_${String(id)}`,
    type: "User",
    site_admin: false,
  };
}

function providerIssue(issue: ReturnType<typeof issueFromState>) {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    locked: issue.locked,
    comments: issue.comments,
    user: providerUser(issue.author),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt ?? null,
    author_association: "CONTRIBUTOR",
  };
}

function providerComment(comment: ReturnType<typeof commentFromState>) {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: providerUser(comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: "CONTRIBUTOR",
  };
}

function outcomeObject(outcome: { readonly status: string; readonly value?: unknown }) {
  return outcome.status === "ok" &&
    typeof outcome.value === "object" &&
    outcome.value !== null &&
    !Array.isArray(outcome.value)
    ? (outcome.value as Readonly<Record<string, unknown>>)
    : undefined;
}

function providerError(outcome: {
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}) {
  return {
    message: outcome.error?.message ?? "Request failed",
    documentation_url: "https://docs.github.com/rest/issues",
    status: outcome.error?.code === "tool.RATE_LIMITED" ? "403" : "error",
  };
}

function responseHeaders(rateLimited = false): Readonly<Record<string, string>> {
  return {
    "x-github-api-version-selected": API_VERSION,
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": rateLimited ? "0" : "4999",
    ...(rateLimited ? { "retry-after": "1" } : {}),
  };
}

function issueArguments(request: { readonly path: Readonly<Record<string, string>> }): {
  owner: string;
  repo: string;
  issueNumber: number;
} {
  return {
    owner: requiredString(request.path.owner, "owner"),
    repo: requiredString(request.path.repo, "repo"),
    issueNumber: requiredInteger(Number(request.path.issueNumber), "issueNumber"),
  };
}

export default defineToolBehavior({
  operations: {
    "issues.get": (input, context) => {
      const key = identity(input);
      const issue = context.state.get("issues", issueKey(key.owner, key.repo, key.issueNumber));
      if (issue === null) {
        return context.fail({ code: "NOT_FOUND", message: "Not Found" });
      }
      return { issue: issueFromState(issue) };
    },
    "issues.update": (input, context) => {
      const key = identity(input);
      const rowId = issueKey(key.owner, key.repo, key.issueNumber);
      const current = context.state.get("issues", rowId);
      if (current === null) return context.fail({ code: "NOT_FOUND", message: "Not Found" });
      const state =
        input.state === "open"
          ? "open"
          : input.state === "closed"
            ? "closed"
            : context.fail({ code: "VALIDATION_FAILED", message: "Validation Failed" });
      const reason = input.stateReason;
      const validReason =
        reason === undefined ||
        (state === "closed" && (reason === "completed" || reason === "not_planned")) ||
        (state === "open" && reason === "reopened");
      if (!validReason) {
        return context.fail({ code: "VALIDATION_FAILED", message: "Validation Failed" });
      }
      const now = timestamp(context.clock.nowUs());
      const issue = issueFromState(current);
      const updated = {
        ...issue,
        state,
        stateReason: reason ?? (state === "closed" ? "completed" : "reopened"),
        updatedAt: now,
        ...(state === "closed" ? { closedAt: now } : {}),
      };
      const { closedAt: _closedAt, ...openIssue } = updated;
      const stored = state === "open" ? openIssue : updated;
      context.state.put("issues", rowId, stored);
      context.events.emit("issue.updated", { ...key, state });
      return { issue: stored };
    },
    "comments.create": (input, context) => {
      const key = identity(input);
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (body.length === 0) {
        return context.fail({ code: "VALIDATION_FAILED", message: "Validation Failed" });
      }
      const rowId = issueKey(key.owner, key.repo, key.issueNumber);
      const current = context.state.get("issues", rowId);
      if (current === null) return context.fail({ code: "NOT_FOUND", message: "Not Found" });
      const id =
        context.state
          .scan("comments", { limit: 10_000 })
          .reduce((highest, record) => Math.max(highest, Number(record.value.id) || 0), 9_000) + 1;
      const now = timestamp(context.clock.nowUs());
      const comment = {
        ...key,
        id,
        nodeId: `IC_synthetic_${String(id)}`,
        body,
        author: actorLogin(context.actor.attributes, context.actor.id),
        createdAt: now,
        updatedAt: now,
      };
      context.state.put("comments", String(id), comment);
      const issue = issueFromState(current);
      context.state.put("issues", rowId, { ...issue, comments: issue.comments + 1, updatedAt: now });
      context.events.emit("issue-comment.created", { ...key, commentId: id });
      return { comment };
    },
    "comments.list": (input, context) => {
      const key = identity(input);
      if (context.state.get("issues", issueKey(key.owner, key.repo, key.issueNumber)) === null) {
        return context.fail({ code: "NOT_FOUND", message: "Not Found" });
      }
      const page = typeof input.page === "number" ? input.page : 1;
      const perPage = typeof input.perPage === "number" ? input.perPage : 30;
      const offset = (page - 1) * perPage;
      const comments = context.state
        .scan("comments", { limit: 10_000 })
        .map((record) => commentFromState(record.value))
        .filter(
          (comment) =>
            comment.owner.toLowerCase() === key.owner.toLowerCase() &&
            comment.repo.toLowerCase() === key.repo.toLowerCase() &&
            comment.issueNumber === key.issueNumber,
        )
        .sort((left, right) => left.id - right.id)
        .slice(offset, offset + perPage);
      return { comments };
    },
  },
  http: {
    "get-issue": {
      decode: (request) => ({ arguments: issueArguments(request) }),
      encode: ({ outcome }) => {
        const issue = outcomeObject(outcome)?.issue;
        return {
          headers: responseHeaders(),
          body:
            typeof issue === "object" && issue !== null && !Array.isArray(issue)
              ? {
                  kind: "json",
                  value: providerIssue(issueFromState(issue as Readonly<Record<string, unknown>>)),
                }
              : { kind: "json", value: providerError(outcome) },
        };
      },
    },
    "update-issue": {
      decode: (request) => {
        const body =
          request.body.kind === "json" &&
          typeof request.body.value === "object" &&
          request.body.value !== null &&
          !Array.isArray(request.body.value)
            ? request.body.value
            : {};
        return {
          arguments: {
            ...issueArguments(request),
            state: typeof body.state === "string" ? body.state : "",
            ...(typeof body.state_reason === "string" ? { stateReason: body.state_reason } : {}),
          },
        };
      },
      encode: ({ outcome }) => {
        const issue = outcomeObject(outcome)?.issue;
        return {
          headers: responseHeaders(),
          body:
            typeof issue === "object" && issue !== null && !Array.isArray(issue)
              ? {
                  kind: "json",
                  value: providerIssue(issueFromState(issue as Readonly<Record<string, unknown>>)),
                }
              : { kind: "json", value: providerError(outcome) },
        };
      },
    },
    "create-comment": {
      decode: (request) => {
        const body =
          request.body.kind === "json" &&
          typeof request.body.value === "object" &&
          request.body.value !== null &&
          !Array.isArray(request.body.value)
            ? request.body.value
            : {};
        return {
          arguments: {
            ...issueArguments(request),
            body: typeof body.body === "string" ? body.body : "",
          },
        };
      },
      encode: ({ outcome }) => {
        const comment = outcomeObject(outcome)?.comment;
        const rateLimited = outcome.error?.code === "tool.RATE_LIMITED";
        return {
          headers: responseHeaders(rateLimited),
          body:
            typeof comment === "object" && comment !== null && !Array.isArray(comment)
              ? {
                  kind: "json",
                  value: providerComment(commentFromState(comment as Readonly<Record<string, unknown>>)),
                }
              : { kind: "json", value: providerError(outcome) },
        };
      },
    },
    "list-comments": {
      decode: (request) => {
        const page = optionalPage(one(request.query.page, "page"), "page");
        const perPage = optionalPage(one(request.query.per_page, "per_page"), "per_page", 100);
        return {
          arguments: {
            ...issueArguments(request),
            ...(page === undefined ? {} : { page }),
            ...(perPage === undefined ? {} : { perPage }),
          },
        };
      },
      encode: ({ outcome }) => {
        const comments = outcomeObject(outcome)?.comments;
        return {
          headers: responseHeaders(),
          body: Array.isArray(comments)
            ? {
                kind: "json",
                value: comments.map((comment) =>
                  typeof comment === "object" && comment !== null && !Array.isArray(comment)
                    ? providerComment(commentFromState(comment as Readonly<Record<string, unknown>>))
                    : comment,
                ),
              }
            : { kind: "json", value: providerError(outcome) },
        };
      },
    },
  },
});
