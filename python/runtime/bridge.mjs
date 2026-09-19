/** Private, versioned Python transport. All world semantics remain in the public SDK. */
import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

// Trusted repository behavior may log; stdout is reserved for protocol messages.
const wire = process.stdout.write.bind(process.stdout);
globalThis.console = new Console(process.stderr, process.stderr);
process.stdout.write = process.stderr.write.bind(process.stderr);

const sdk = await import("@firedrill-run/sdk");
const { startLocalInspector } = await import("@firedrill-run/inspector");
const MAX_FRAME = 256 * 1024 * 1024;
const worlds = new Map();
const bindings = new Map();
const inspectors = new Map();
const callbacks = new Map();
const scopes = new Map();
const runs = new Map();
const tasks = new Set();
let closing;

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}
function errorData(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "framework.PYTHON_RUNTIME_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: error?.details ?? {},
    diagnostics: error?.diagnostics ?? [],
  };
}
function send(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_FRAME)
    throw fault("framework.PYTHON_MESSAGE_LIMIT", "Runtime message exceeds 256 MiB; use paginated reads.");
  wire(`${text}\n`);
}
function find(collection, id, kind) {
  const value = collection.get(id);
  if (!value) throw fault("framework.PYTHON_HANDLE_CLOSED", `${kind} is closed or unknown.`);
  return value;
}
function args(value) {
  if (!Array.isArray(value ?? [])) throw fault("framework.INVALID_ARGUMENT", "args must be an array.");
  return value ?? [];
}

// Python callers do not have TypeScript's excess-property checks. Reject typos
// before creating state or running an agent; silently dropping them is unsafe.
const optionKeys = {
  createLocalWorld: "root drill scenario seed buildHash directory maxToolCalls",
  listen: "actorId protocols httpPort mcpPort cliPort",
  inspector:
    "root runDirectory reportDirectory callbackReceivers hostEnvironment allowRemoteHttp maxConcurrency hostname port",
  runDrills:
    "root drill suite tags filter shard trials retries concurrency seed buildHash setup runDirectory reportDirectory allowRemoteHttp callbackReceivers hostEnvironment capture",
  testTool: "root toolId suite seed testDirectory allowRemoteHttp callbackReceivers hostEnvironment",
  prepareToolContribution:
    "root toolId suite seed testDirectory allowRemoteHttp callbackReceivers hostEnvironment acceptApache2 outputDirectory",
  runBrowserTest:
    "root definition parameters headless allowedOrigins allowRemote timeoutMs stepTimeoutMs maxActions reportDirectory capture mask",
  browserAgent: "environment model maxTurns maxBudgetUsd",
  runFiredrillAgent:
    "root workflow prompt model effort maxTurns maxBudgetUsd timeoutMs environment allowRepositoryExecution",
  compareRuns: "baselineReport candidateReport",
  compareRunDetails: "baselineReport candidateReport kind offset limit",
  verifyReport: "report",
  inspectTool: "root toolId",
  validateTool: "root toolId",
  previewDataImport: "root plan consent allowedOrigin environment",
  saveDataImport: "root preview expectedPreviewHash confirm",
  listBrowserTests: "root directory offset limit",
  listBrowserTestReports: "root directory offset limit",
  loadBrowserTest: "root path",
  saveBrowserTest: "root path definition",
  browserTestDefinitionFromResult: "result id title",
  call: "actorId packageId operationId arguments idempotencyKey",
  state: "packageId namespace afterRowId limit",
  evidence: "fromSequence limit",
  setFault: "packageId faultId active",
  advanceTime: "maxEvents",
  reset: "packages",
  exportScenario: "id title packages",
  saveScenario: "id title packages expectedSourceHash expectedGeneration",
};
function checkedOptions(name, value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fault("framework.INVALID_ARGUMENT", `${name} options must be an object.`);
  const allowed = optionKeys[name]?.split(" ");
  if (allowed) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length)
      throw fault("framework.INVALID_ARGUMENT", `Unknown ${name} option(s): ${unknown.join(", ")}.`);
  }
  return value;
}

const worldMethods = new Set([
  "describe",
  "metadata",
  "call",
  "state",
  "evidence",
  "scheduledEvents",
  "callbacks",
  "faults",
  "setFault",
  "advanceTime",
  "reset",
  "exportScenario",
  "saveScenario",
]);
const sdkMethods = new Set([
  "compareRuns",
  "compareRunDetails",
  "verifyReport",
  "inspectTool",
  "validateTool",
  "previewDataImport",
  "saveDataImport",
  "storeDataImportPreview",
  "loadDataImportPreview",
  "loadDataImportPlan",
  "validateCaptureOptions",
]);
const browserMethods = new Set([
  "listBrowserTests",
  "listBrowserTestReports",
  "loadBrowserTest",
  "saveBrowserTest",
  "browserTestDefinitionFromResult",
  "verifyBrowserTestReport",
  "bundleBrowserTestReport",
]);
const hookNames = new Set([
  "beforeAll",
  "afterAll",
  "beforeDrill",
  "afterDrill",
  "beforeTrial",
  "afterTrial",
  "attemptStarted",
  "attemptFinished",
]);

function portableContext(context) {
  const { signal, attach, capture, binding, observe, step, ...plain } = context;
  return {
    ...plain,
    ...(signal ? { signal: { aborted: signal.aborted } } : {}),
    ...(attach ? { attach: true } : {}),
    ...(capture ? { capture: { policies: capture.policies } } : {}),
    ...(observe ? { observe: true, step: true } : {}),
    ...(binding
      ? {
          binding: {
            environment: binding.environment,
            apps: binding.apps ?? [],
            ...(binding.world
              ? { world: { proxy: true, actorBindingId: binding.world.actorBindingId } }
              : {}),
          },
        }
      : {}),
  };
}

function callPython(runId, callback, context) {
  const id = randomUUID();
  const scope = randomUUID();
  return new Promise((resolve, reject) => {
    const entry = { runId, context };
    scopes.set(scope, entry);
    const finish = (error, result) => {
      callbacks.delete(id);
      scopes.delete(scope);
      context.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      send({ type: "cancelled", runId, scope, reason: "Execution was cancelled or timed out." });
      finish(fault("target.CANCELLED", "Python callback is no longer active."));
    };
    callbacks.set(id, { finish, runId });
    if (context.signal?.aborted) return abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      send({ type: "callback", id, runId, callback, scope, context: portableContext(context) });
    } catch (error) {
      finish(error);
    }
  });
}

async function callbackInvoke(params) {
  const { context, runId } = find(scopes, params.scope, "Callback");
  context.signal?.throwIfAborted();
  const input = args(params.args);
  switch (params.method) {
    case "world.invoke":
      if (!context.binding?.world)
        throw fault("framework.BINDING_REQUIRED", "This target does not declare a direct binding.");
      return context.binding.world.invoke(...input);
    case "attach":
      if (!context.attach) throw fault("framework.ATTACHMENT_UNAVAILABLE", "No active attachment sink.");
      return context.attach(...input);
    case "observe":
    case "step":
      if (typeof context[params.method] !== "function")
        throw fault("framework.BROWSER_DRIVER_REQUIRED", "No active browser driver.");
      return context[params.method](...input);
    case "capture.registerDriver": {
      if (!context.capture) throw fault("framework.CAPTURE_UNAVAILABLE", "No active capture sink.");
      const descriptor = input[0];
      const allowed = new Set(["screenshot", "startVideo", "stopVideo", "dispose"]);
      if (
        !descriptor ||
        typeof descriptor.driverId !== "string" ||
        !Array.isArray(descriptor.methods) ||
        descriptor.methods.some((name) => !allowed.has(name))
      )
        throw fault("framework.INVALID_ARGUMENT", "Invalid capture driver.");
      const driver = Object.fromEntries(
        descriptor.methods.map((method) => [
          method,
          async (driverContext) =>
            (await callPython(runId, `capture.${descriptor.driverId}.${method}`, driverContext)) ?? undefined,
        ]),
      );
      return context.capture.registerDriver(driver);
    }
    default: {
      const method = params.method?.replace(/^capture\./, "");
      if (!["log", "file", "screenshot", "video"].includes(method) || !context.capture)
        throw fault("framework.INVALID_ARGUMENT", "Unknown callback operation.");
      return context.capture[method](...input);
    }
  }
}

async function executeRun(params, browser = false) {
  const runId = params.runId ?? randomUUID();
  if (runs.has(runId)) throw fault("framework.INVALID_ARGUMENT", "Run request id is already active.");
  const controller = new AbortController();
  runs.set(runId, controller);
  try {
    const options = {
      ...checkedOptions(browser ? "runBrowserTest" : (params.name ?? "runDrills"), params.options),
      signal: controller.signal,
    };
    if (browser) {
      if ((params.messages || params.onTurnCompleted) && !params.agentOptions)
        throw fault("framework.INVALID_ARGUMENT", "Interactive messages require run_browser_agent_test.");
      const api = await import("@firedrill-run/browser-tests");
      if (params.agentOptions) {
        if (params.driver)
          throw fault("framework.INVALID_ARGUMENT", "Choose a Python browser driver or Firedrill Agent.");
        const { createBrowserAgentDriver } = await import("@firedrill-run/agent/browser");
        const agentOptions = { ...checkedOptions("browserAgent", params.agentOptions) };
        if (params.messages) {
          agentOptions.messages = {
            async *[Symbol.asyncIterator]() {
              while (!controller.signal.aborted) {
                const next = await callPython(runId, "browser.nextMessage", { signal: controller.signal });
                if (next?.done === true) return;
                if (typeof next?.value !== "string")
                  throw fault("framework.INVALID_ARGUMENT", "Browser messages must yield strings.");
                yield next.value;
              }
            },
          };
        }
        if (params.onTurnCompleted)
          agentOptions.onTurnCompleted = () =>
            send({ type: "event", runId, event: "onTurnCompleted", value: null });
        options.driver = createBrowserAgentDriver(agentOptions);
      }
      if (params.driver) options.driver = (context) => callPython(runId, "browser.driver", context);
      for (const field of ["onEvent", "onFrame"])
        if (params[field]) options[field] = (value) => send({ type: "event", runId, event: field, value });
      if (params.resolveAddress)
        options.resolveAddress = (hostname) =>
          callPython(runId, "browser.resolveAddress", { hostname, signal: controller.signal });
      return await api.runBrowserTest(options);
    }
    if (params.agent) options.agent = (context) => callPython(runId, "agent", context);
    const hooks = {};
    for (const name of params.hooks ?? []) {
      if (!hookNames.has(name)) throw fault("framework.INVALID_ARGUMENT", `Unknown lifecycle hook ${name}.`);
      hooks[name] = (context) => callPython(runId, name, { ...context, signal: controller.signal });
    }
    if (Object.keys(hooks).length) options.hooks = hooks;
    const name = params.name ?? "runDrills";
    if (!["runDrills", "testTool", "prepareToolContribution"].includes(name))
      throw fault("framework.INVALID_ARGUMENT", "Unknown executable SDK function.");
    return await sdk[name](options);
  } finally {
    controller.abort();
    runs.delete(runId);
    for (const callback of callbacks.values())
      if (callback.runId === runId) callback.finish(fault("target.CANCELLED", "Run finished."));
  }
}

async function closeWorld(handle) {
  const world = worlds.get(handle);
  if (!world) return;
  // Close borrowed inspector and sockets before the store they refer to.
  for (const [id, entry] of inspectors) {
    if (entry.worldHandle !== handle) continue;
    await closeInspector(id);
  }
  for (const [id, entry] of bindings) {
    if (entry.worldHandle !== handle) continue;
    await entry.binding.close();
    bindings.delete(id);
  }
  world.close();
  worlds.delete(handle);
}

async function closeInspector(handle) {
  const entry = inspectors.get(handle);
  if (!entry) return;
  inspectors.delete(handle);
  await entry.server.close();
  if (entry.ownedBinding) {
    await bindings.get(entry.ownedBinding)?.binding.close();
    bindings.delete(entry.ownedBinding);
  }
}

async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    for (const controller of runs.values()) controller.abort();
    for (const pending of callbacks.values()) pending.finish(fault("target.CANCELLED", "Runtime closed."));
    // The SDK must finish writing cancelled reports before transports disappear.
    await Promise.allSettled([...tasks]);
    for (const handle of [...inspectors.keys()]) await closeInspector(handle);
    for (const handle of [...worlds.keys()]) await closeWorld(handle);
  })();
  return closing;
}

async function dispatch(method, params = {}) {
  if (closing && method !== "session.close")
    throw fault("framework.PYTHON_RUNTIME_CLOSED", "Runtime is closing.");
  switch (method) {
    case "ping":
      return { protocolVersion: 1, runtime: "firedrill", capabilities: [...sdkMethods] };
    case "world.create": {
      const world = await sdk.createLocalWorld(checkedOptions("createLocalWorld", params.options));
      const handle = randomUUID();
      worlds.set(handle, world);
      return {
        handle,
        repositoryRoot: world.repositoryRoot,
        directoryPath: world.directoryPath,
        worldFilePath: world.worldFilePath,
        baselineFilePath: world.baselineFilePath,
        diagnostics: world.diagnostics,
      };
    }
    case "world.invoke": {
      const world = find(worlds, params.handle, "World");
      if (!worldMethods.has(params.method))
        throw fault("framework.INVALID_ARGUMENT", "Unknown world method.");
      const input = args(params.args);
      if (optionKeys[params.method])
        checkedOptions(params.method, input[params.method === "advanceTime" ? 1 : 0]);
      return world[params.method](...input);
    }
    case "world.listen": {
      const world = find(worlds, params.handle, "World");
      const binding = await world.listen(checkedOptions("listen", params.options));
      const handle = randomUUID();
      bindings.set(handle, { binding, worldHandle: params.handle });
      const { close, ...data } = binding;
      return { ...data, handle };
    }
    case "binding.close": {
      const entry = bindings.get(params.handle);
      await entry?.binding.close();
      bindings.delete(params.handle);
      return null;
    }
    case "world.close":
      await closeWorld(params.handle);
      return null;
    case "inspector.start": {
      const options = { ...checkedOptions("inspector", params.options) };
      let ownedBinding;
      if (params.agent) {
        if (typeof params.runId !== "string")
          throw fault("framework.INVALID_ARGUMENT", "Inspector agent requires a callback run id.");
        options.agent = (context) => callPython(params.runId, "agent", context);
      }
      if (params.worldHandle) {
        const world = find(worlds, params.worldHandle, "World");
        let entry;
        if (params.bindingHandle) entry = find(bindings, params.bindingHandle, "Binding");
        else {
          const binding = await world.listen();
          entry = { binding, worldHandle: params.worldHandle };
          ownedBinding = randomUUID();
          bindings.set(ownedBinding, entry);
        }
        if (entry.worldHandle !== params.worldHandle)
          throw fault("framework.INVALID_ARGUMENT", "Inspector world and binding must belong together.");
        options.root = world.repositoryRoot;
        options.environment = { world, binding: entry.binding };
      }
      try {
        const server = await startLocalInspector(options);
        const handle = randomUUID();
        inspectors.set(handle, { server, worldHandle: params.worldHandle, ownedBinding });
        return { handle, url: server.url };
      } catch (error) {
        if (ownedBinding) {
          await bindings.get(ownedBinding)?.binding.close();
          bindings.delete(ownedBinding);
        }
        throw error;
      }
    }
    case "inspector.close": {
      await closeInspector(params.handle);
      return null;
    }
    case "sdk.invoke": {
      if (!sdkMethods.has(params.name)) throw fault("framework.INVALID_ARGUMENT", "Unknown SDK function.");
      if (optionKeys[params.name]) checkedOptions(params.name, params.options ?? params.args?.[0]);
      return sdk[params.name](...(params.args === undefined ? [params.options ?? {}] : args(params.args)));
    }
    case "browser.invoke": {
      if (!browserMethods.has(params.name))
        throw fault("framework.INVALID_ARGUMENT", "Unknown browser function.");
      if (optionKeys[params.name]) checkedOptions(params.name, params.options ?? params.args?.[0]);
      const api = await import("@firedrill-run/browser-tests");
      const result = await api[params.name](
        ...(params.args === undefined ? [params.options ?? {}] : args(params.args)),
      );
      if (params.name === "bundleBrowserTestReport")
        return {
          filename: result.filename,
          mediaType: result.mediaType,
          encoding: "base64",
          data: result.bytes.toString("base64"),
        };
      return result;
    }
    case "browser.run":
      return executeRun(params, true);
    case "agent.run": {
      const runId = params.runId ?? randomUUID();
      if (runs.has(runId)) throw fault("framework.INVALID_ARGUMENT", "Run request id is already active.");
      const controller = new AbortController();
      runs.set(runId, controller);
      try {
        const { runFiredrillAgent } = await import("@firedrill-run/agent");
        return await runFiredrillAgent({
          ...checkedOptions("runFiredrillAgent", params.options),
          signal: controller.signal,
          ...(params.onEvent
            ? { onEvent: (value) => send({ type: "event", runId, event: "onEvent", value }) }
            : {}),
        });
      } finally {
        controller.abort();
        runs.delete(runId);
      }
    }
    case "run.start":
      return executeRun(params);
    case "run.cancel":
      runs.get(params.runId)?.abort();
      return null;
    case "callback.invoke":
      return callbackInvoke(params);
    default:
      throw fault("framework.INVALID_ARGUMENT", `Unknown runtime method: ${method}`);
  }
}

function receive(line) {
  let message;
  try {
    message = JSON.parse(line);
    if (!message || typeof message !== "object" || typeof message.id !== "string") throw new Error();
  } catch {
    send({
      id: null,
      error: errorData(fault("framework.PYTHON_PROTOCOL_ERROR", "Expected a JSON request with an id.")),
    });
    return;
  }
  if (message.type === "callback_result") {
    const callback = callbacks.get(message.id);
    if (callback)
      callback.finish(
        message.error
          ? Object.assign(new Error(message.error.message ?? "Python callback failed."), message.error)
          : undefined,
        message.result,
      );
    return;
  }
  if (message.method === "session.close") {
    void shutdown()
      .then(() => {
        send({ id: message.id, result: null });
        process.stdin.pause();
        process.exit(0);
      })
      .catch((error) => {
        send({ id: message.id, error: errorData(error) });
        process.exit(1);
      });
    return;
  }
  const task = dispatch(message.method, message.params)
    .then(
      (result) => send({ id: message.id, result: result ?? null }),
      (error) => send({ id: message.id, error: errorData(error) }),
    )
    .catch((error) => send({ id: message.id, error: errorData(error) }));
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_FRAME) {
      process.stdin.destroy();
      process.exitCode = 1;
      break;
    }
    if (line.trim()) receive(line);
    newline = buffer.indexOf("\n");
  }
  if (Buffer.byteLength(buffer) > MAX_FRAME) {
    process.stdin.destroy();
    process.exitCode = 1;
  }
});
process.stdin.on("end", () => void shutdown().finally(() => process.exit(process.exitCode ?? 0)));
process.stdin.on("error", () => void shutdown().finally(() => process.exit(1)));
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => void shutdown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)));
process.stdin.resume();
