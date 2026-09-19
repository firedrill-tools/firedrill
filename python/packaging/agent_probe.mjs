// Exercise the real official Agent SDK executable without submitting a prompt.
import { pathToFileURL } from "node:url";

const [sdkFile, executable] = process.argv.slice(2);
const { query } = await import(pathToFileURL(sdkFile).href);
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 30_000);
let conversation;
try {
  conversation = query({
    prompt: (async function* () {
      // A parked input stream makes initialize available without a model call.
      await new Promise((resolve) => {
        abortController.signal.addEventListener("abort", resolve, { once: true });
      });
    })(),
    options: {
      abortController,
      pathToClaudeCodeExecutable: executable,
      cwd: process.cwd(),
      env: process.env,
      settingSources: [],
      tools: [],
      mcpServers: {},
      persistSession: false,
    },
  });
  const result = await conversation.initializationResult();
  if (!result || typeof result !== "object") {
    throw new Error("Agent SDK initialization did not return its protocol response.");
  }
  process.stdout.write("Agent SDK executable and IPC initialization verified without a prompt\n");
} finally {
  clearTimeout(timer);
  conversation?.close();
  abortController.abort();
}
