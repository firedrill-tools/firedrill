import { getContext, invoke } from "/_firedrill/client.js";

export const $ = (selector) => document.querySelector(selector);
export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function notice(message = "", error = false) {
  const element = $("#feedback");
  element.textContent = message;
  element.hidden = !message;
  element.dataset.error = String(error);
}
export async function call(operationId, args, key) {
  const result = await invoke(operationId, args, key ? { idempotencyKey: key } : {});
  if (result.outcome.status !== "ok") {
    const error = new Error(result.outcome.error?.message ?? `The operation was ${result.outcome.status}.`);
    error.code = result.outcome.error?.code;
    throw error;
  }
  return result.outcome.value;
}
export function key() {
  return crypto.randomUUID();
}
let pending = false;
export async function action(task) {
  if (pending) return;
  pending = true;
  notice();
  document.body.setAttribute("aria-busy", "true");
  const enabled = [...document.querySelectorAll("button:not(:disabled)")];
  for (const button of enabled) button.disabled = true;
  try {
    await task();
  } catch (error) {
    notice(error.message ?? "The operation failed. Refresh and try again.", true);
  } finally {
    pending = false;
    document.body.removeAttribute("aria-busy");
    for (const button of enabled) if (button.isConnected) button.disabled = false;
  }
}
export async function confirmAction(title, description, label = "Delete") {
  const dialog = $("#confirmation");
  $("#confirmation-title").textContent = title;
  $("#confirmation-description").textContent = description;
  $("#confirm-action").textContent = label;
  dialog.returnValue = "cancel";
  // A pending action must not disable its own confirmation controls.
  for (const button of dialog.querySelectorAll("button")) button.disabled = false;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}
export function pager({ page, previous, next, onPrevious, onNext, count }) {
  const footer = $("#pagination");
  footer.replaceChildren(node("span", `Page ${page + 1} · ${count} ${count === 1 ? "item" : "items"}`));
  for (const [label, available, handler] of [
    ["Previous", previous, onPrevious],
    ["Next", next, onNext],
  ]) {
    const button = node("button", label);
    button.type = "button";
    button.disabled = !available;
    button.addEventListener("click", () => action(handler));
    footer.append(button);
  }
}
export function empty(title, description) {
  const element = node("div", undefined, "empty");
  element.append(node("h2", title), node("p", description));
  return element;
}
export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  let checking = false;
  const stamp = (context) => JSON.stringify(context.revision);
  const check = async () => {
    if (checking || pending || !mayRefresh() || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      $("#identity").textContent = `Acting as ${context.actorId}`;
      if (revision !== stamp(context)) {
        notice();
        await refresh();
        revision = stamp(await getContext());
      }
    } catch (error) {
      notice(error.message ?? "The local environment is unavailable.", true);
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
}
