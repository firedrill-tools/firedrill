import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createToolUiClientSource } from "../src/index.js";

function browser(source: string, token: string, stored = false) {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const transports: string[] = [];
  const history: string[] = [];
  const values = new Map<string, string>(stored ? [["firedrill.tool-ui.token.v1", token]] : []);
  const context = {
    URLSearchParams,
    location: { hash: stored ? "" : `#token=${encodeURIComponent(token)}`, pathname: "/", search: "" },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, path: string) => history.push(path),
    },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    fetch: async (path: string, options: { headers: { authorization?: string }; credentials: string }) => {
      transports.push(options.credentials);
      requests.push({ path, authorization: options.headers.authorization });
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          worldInstanceId: "world",
          actorId: "actor",
          packageId: "meter",
          title: "Meter",
        }),
      };
    },
  };
  const api = runInNewContext(
    `${source.replaceAll("export async function", "async function")}\n({ getContext });`,
    context,
  ) as { getContext(): Promise<unknown> };
  return { api, requests, history, values, transports };
}

describe("portable Tool app browser client", () => {
  const opaque = "a".repeat(43);
  const signed = `${"a".repeat(64)}.${"b".repeat(86)}`;

  it("retains opaque local credentials by default and clears fragments before requests", async () => {
    const local = browser(createToolUiClientSource(), opaque);
    expect(local.history).toEqual(["/"]);
    expect(local.requests).toEqual([]);
    await local.api.getContext();
    expect(local.requests).toEqual([{ path: "/_firedrill/context", authorization: `Bearer ${opaque}` }]);
    expect(local.transports).toEqual(["omit"]);
    await expect(browser(createToolUiClientSource(), signed).api.getContext()).rejects.toThrow();
  });

  it("allows explicitly selected bounded signed credentials without changing the app protocol", async () => {
    const source = createToolUiClientSource({ credentialFormat: "signed", maxCredentialBytes: 512 });
    for (const token of [signed, `${signed}.cccc`]) {
      const app = browser(source, token);
      await app.api.getContext();
      expect(app.requests[0]?.authorization).toBe(`Bearer ${token}`);
      expect(app.history).toEqual(["/"]);
    }
    for (const token of [opaque, `${signed}/`, `${signed}\n`, `a.${"b".repeat(512)}`, `${signed}.c.d`]) {
      const app = browser(source, token);
      await expect(app.api.getContext()).rejects.toThrow();
      expect(app.requests).toEqual([]);
      expect(app.values.size).toBe(0);
    }
    const cached = browser(source, `a.${"b".repeat(512)}`, true);
    await expect(cached.api.getContext()).rejects.toThrow();
    expect(cached.requests).toEqual([]);
  });

  it("rejects invalid byte limits before generating a browser module", () => {
    for (const maxCredentialBytes of [0, 42, 43.5, 16385, Number.NaN]) {
      expect(() => createToolUiClientSource({ maxCredentialBytes })).toThrow(TypeError);
    }
  });

  it("uses explicit same-origin cookies without consuming or retaining a bearer", async () => {
    const source = createToolUiClientSource({ credentialTransport: "cookie" });
    for (const stored of [false, true]) {
      const app = browser(source, signed, stored);
      await app.api.getContext();
      expect(app.requests).toEqual([{ path: "/_firedrill/context", authorization: undefined }]);
      expect(app.transports).toEqual(["same-origin"]);
      expect(app.values.size).toBe(0);
      expect(app.history).toEqual(stored ? [] : ["/"]);
    }
    await expect(browser(source, "").api.getContext()).resolves.toMatchObject({ packageId: "meter" });
    expect(() => createToolUiClientSource({ credentialTransport: "external" as "cookie" })).toThrow(
      TypeError,
    );
  });
});
