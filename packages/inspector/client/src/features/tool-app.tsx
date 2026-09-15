import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { inspectorApi } from "../api";
import { Button, InlineMessage } from "../components/primitives";
import type { EnvironmentApp } from "../environment-types";

export interface LiveToolApps {
  readonly worldInstanceId: string;
  readonly apps: readonly EnvironmentApp[];
}

/** Create the tab in the click stack; the credential is fetched only after the operator asks. */
export async function openToolApp(
  app: EnvironmentApp,
  worldInstanceId: string,
  signal: AbortSignal,
): Promise<void> {
  const popup = window.open("about:blank", "_blank");
  if (popup === null)
    throw new Error("The browser blocked the new tab. Allow pop-ups for this inspector, then try again.");
  // Detach before any navigation. Passing noopener to open() would hide the handle in some browsers.
  popup.opener = null;
  const close = () => popup.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    const receipt = await inspectorApi.environmentApp(app.packageId, signal);
    const destination = new URL(receipt.app.url);
    const publicLocation = new URL(destination);
    publicLocation.hash = "";
    if (
      signal.aborted ||
      popup.closed ||
      receipt.worldInstanceId !== worldInstanceId ||
      receipt.app.packageId !== app.packageId ||
      publicLocation.href !== app.url ||
      destination.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname) ||
      destination.username !== "" ||
      destination.password !== "" ||
      destination.search !== "" ||
      !new URLSearchParams(destination.hash.slice(1)).get("token")
    )
      throw new Error("The running app changed before its link could be opened.");
    popup.location.replace(destination.href);
  } catch {
    close();
    throw new Error(
      "The app could not be opened. Check that the local environment is running, then try again.",
    );
  } finally {
    signal.removeEventListener("abort", close);
  }
}

export function OpenToolApp({
  app,
  worldInstanceId,
}: {
  readonly app: EnvironmentApp;
  readonly worldInstanceId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const open = async () => {
    if (pending.current !== undefined) return;
    const controller = new AbortController();
    pending.current = controller;
    const deadline = setTimeout(() => controller.abort(), 10_000);
    setBusy(true);
    setError(undefined);
    try {
      await openToolApp(app, worldInstanceId, controller.signal);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The app could not be opened. Try again.");
    } finally {
      clearTimeout(deadline);
      pending.current = undefined;
      setBusy(false);
    }
  };
  return (
    <div className="fd-tool-app">
      <Button aria-label={`Open app for ${app.title}`} disabled={busy} onClick={() => void open()}>
        <ExternalLink size={15} aria-hidden="true" />
        {busy ? "Opening…" : "Open app"}
      </Button>
      {error === undefined ? null : <InlineMessage tone="danger">{error}</InlineMessage>}
    </div>
  );
}
