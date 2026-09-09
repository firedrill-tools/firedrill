import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectorApi } from "../api";
import { openToolApp } from "./tool-app";

const app = { packageId: "counter", title: "Counter", url: "http://127.0.0.1:45000/index.html" };
const receipt = {
  worldInstanceId: "world-fixture",
  app: { ...app, url: `${app.url}#token=fixture-scoped-token` },
};
function popup() {
  const target = { opener: "parent", closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn(() => target);
  vi.stubGlobal("window", { open });
  return { target, open };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit Tool app opening", () => {
  it("opens synchronously and detaches the opener before fetching a scoped credential", async () => {
    const { target, open } = popup();
    let resolve: (value: typeof receipt) => void = () => {
      throw new Error("Request not started");
    };
    const fetchLink = vi.spyOn(inspectorApi, "environmentApp").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = openToolApp(app, receipt.worldInstanceId, new AbortController().signal);
    expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(target.opener).toBeNull();
    expect(fetchLink).toHaveBeenCalledExactlyOnceWith("counter", expect.any(AbortSignal));
    expect(target.location.replace).not.toHaveBeenCalled();
    resolve(receipt);
    await pending;
    expect(target.location.replace).toHaveBeenCalledExactlyOnceWith(receipt.app.url);
    expect(target.close).not.toHaveBeenCalled();
  });
  it("does not request a credential when the popup is blocked", async () => {
    vi.stubGlobal("window", { open: () => null });
    const fetchLink = vi.spyOn(inspectorApi, "environmentApp");
    await expect(openToolApp(app, receipt.worldInstanceId, new AbortController().signal)).rejects.toThrow(
      "Allow pop-ups",
    );
    expect(fetchLink).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...receipt, worldInstanceId: "another-world" },
    { ...receipt, app: { ...receipt.app, packageId: "another-tool" } },
    { ...receipt, app: { ...receipt.app, url: "https://untrusted.example/#token=credential" } },
    { ...receipt, app },
  ])("refuses malformed or mismatched app receipts and closes the unused tab: %j", async (value) => {
    const { target } = popup();
    vi.spyOn(inspectorApi, "environmentApp").mockImplementation(async () =>
      JSON.parse(JSON.stringify(value)),
    );
    await expect(openToolApp(app, receipt.worldInstanceId, new AbortController().signal)).rejects.toThrow(
      "Check that the local environment is running",
    );
    expect(target.location.replace).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalled();
  });
  it("closes the pending tab on failure or cancellation without displaying credential-bearing errors", async () => {
    const { target } = popup();
    const controller = new AbortController();
    vi.spyOn(inspectorApi, "environmentApp").mockImplementation(async () => {
      controller.abort();
      expect(target.close).toHaveBeenCalled();
      throw new Error(receipt.app.url);
    });
    await expect(openToolApp(app, receipt.worldInstanceId, controller.signal)).rejects.not.toThrow(
      "fixture-scoped-token",
    );
    expect(target.location.replace).not.toHaveBeenCalled();
  });
});
