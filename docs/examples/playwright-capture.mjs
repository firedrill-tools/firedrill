import { mkdir, mkdtemp } from "node:fs/promises";
import { join, relative } from "node:path";

/** Test-only helper. The caller owns the browser and closes it in a finally block. */
export async function createCapturedPage(browser, invocation, root) {
  const { capture } = invocation;
  const mediaEnabled = capture.policies.screenshots !== "off" || capture.policies.video !== "off";
  const parent = join(root, ".firedrill", "capture");
  if (mediaEnabled) await mkdir(parent, { recursive: true });
  const directory = mediaEnabled ? await mkdtemp(join(parent, "attempt-")) : undefined;
  const context = await browser.newContext({
    ...(capture.policies.video !== "off" ? { recordVideo: { dir: directory } } : {}),
  });
  const page = await context.newPage();
  let closed = false;
  const close = async () => {
    if (!closed) {
      await context.close();
      closed = true;
    }
  };
  await capture.registerDriver({
    screenshot: async ({ signal }) => {
      signal.throwIfAborted();
      const path = join(directory, "screen.png");
      await page.screenshot({ path, fullPage: true, timeout: 4000 });
      return { path: relative(root, path), mediaType: "image/png" };
    },
    stopVideo: async ({ signal }) => {
      signal.throwIfAborted();
      const video = page.video();
      await close();
      if (video === null) return undefined;
      return { path: relative(root, await video.path()), name: "session.webm", mediaType: "video/webm" };
    },
    dispose: close,
  });
  return page;
}
