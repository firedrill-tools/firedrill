import { $, action, call, confirmAction, empty, key, node, notice, pager, watchWorld } from "./ui.js";

const names = { inbox: "Inbox", draft: "Drafts", sent: "Sent", archive: "Archive" };
let folder = "inbox";
let cursors = [undefined];
let page = 0;
let selected;
let composing = false;
let dirty = false;
let draft;
let writeIntent;
let sendIntent;
let navigation = 0;
function lockForm() {
  for (const field of document.querySelectorAll("#compose-form input, #compose-form textarea"))
    field.readOnly = Boolean(writeIntent || sendIntent);
}

function view(name) {
  for (const id of ["listing", "reading", "composing"]) $(`#${id}`).hidden = id !== name;
}
async function leaveCompose() {
  if (
    (dirty || writeIntent || sendIntent) &&
    !(await confirmAction(
      "Discard unsaved changes?",
      "Unsaved edits and pending retry information will be discarded. A save or send with an uncertain result may already have completed; check the mailbox before repeating it.",
      "Discard changes",
    ))
  )
    return false;
  composing = false;
  dirty = false;
  writeIntent = undefined;
  sendIntent = undefined;
  lockForm();
  return true;
}
async function showFolder(next = folder) {
  if (!(await leaveCompose())) return;
  navigation++;
  folder = next;
  selected = undefined;
  cursors = [undefined];
  page = 0;
  for (const button of document.querySelectorAll("[data-folder]")) {
    if (button.dataset.folder === folder) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("#folder-title").textContent = names[folder];
  view("listing");
  await refresh();
}
async function refresh() {
  const generation = navigation;
  if (composing) return;
  if (selected) {
    let result;
    try {
      result = await call("messages.get", { id: selected.id });
    } catch (error) {
      if (generation === navigation && error.code === "tool.NOT_FOUND") {
        await showFolder();
        notice("This message is no longer in the mailbox. The environment may have been reset.");
        return;
      }
      throw error;
    }
    if (generation !== navigation || composing) return;
    selected = result.message;
    renderMessage();
    return;
  }
  const requestedPage = page;
  let result;
  try {
    result = await call("messages.list", {
      folder,
      limit: 20,
      ...(cursors[page] ? { cursor: cursors[page] } : {}),
    });
  } catch (error) {
    if (error.code === "tool.INVALID_CURSOR" && page > 0) {
      cursors = [undefined];
      page = 0;
      return refresh();
    }
    throw error;
  }
  if (generation !== navigation || selected || composing || requestedPage !== page) return;
  const rows = $("#messages");
  rows.replaceChildren();
  if (result.items.length === 0)
    rows.append(
      empty(
        `No ${names[folder].toLowerCase()} messages`,
        "Compose a message, or let your agent use the mailbox.",
      ),
    );
  for (const message of result.items) {
    const button = node("button", undefined, "list-item");
    button.type = "button";
    button.append(
      node("span", folder === "sent" ? message.to.join(", ") : message.from, "sender"),
      node("span", message.subject || "(No subject)", "subject"),
      node("span", message.folder === "draft" ? "Draft" : "Open", "detail"),
    );
    button.addEventListener("click", () =>
      action(async () => {
        const detail = await call("messages.get", { id: message.id });
        selected = detail.message;
        navigation++;
        renderMessage();
        view("reading");
      }),
    );
    rows.append(button);
  }
  pager({
    page,
    previous: page > 0,
    next: Boolean(result.nextCursor),
    count: result.items.length,
    onPrevious: async () => {
      page--;
      await refresh();
    },
    onNext: async () => {
      cursors[++page] = result.nextCursor;
      await refresh();
    },
  });
}
function renderMessage() {
  $("#subject").textContent = selected.subject || "(No subject)";
  $("#headers").replaceChildren(
    node("span", `From: ${selected.from}`),
    node("span", `To: ${selected.to.join(", ")}`),
  );
  $("#message-body").textContent = selected.body;
  $("#edit-draft").hidden = selected.folder !== "draft";
  $("#reply").hidden = selected.folder === "draft";
}
async function compose(message) {
  if (!(await leaveCompose())) return;
  navigation++;
  draft = message?.folder === "draft" ? message : undefined;
  composing = true;
  dirty = false;
  $("#compose-title").textContent = draft ? "Edit draft" : message ? "Reply" : "New message";
  $("#from").value = draft?.from ?? message?.to[0] ?? "";
  $("#to").value = draft?.to.join(", ") ?? message?.from ?? "";
  $("#subject-input").value = draft?.subject ?? (message ? `Re: ${message.subject}` : "");
  $("#body-input").value = draft?.body ?? "";
  view("composing");
  $("#to").focus();
}
function argumentsFromForm() {
  if (!$("#compose-form").reportValidity()) return;
  const to = $("#to")
    .value.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (to.length < 1 || to.length > 20 || to.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))
    throw new Error("Enter up to 20 valid recipient addresses, separated by commas.");
  return {
    id: draft?.id ?? `message-${key()}`,
    from: $("#from").value.trim(),
    to,
    subject: $("#subject-input").value,
    body: $("#body-input").value,
    ifVersion: draft?.version ?? 0,
  };
}
async function saveDraft() {
  if (!writeIntent) {
    const args = argumentsFromForm();
    if (!args) return false;
    writeIntent = { args, key: key() };
  }
  lockForm();
  try {
    const result = await call("messages.write", writeIntent.args, writeIntent.key);
    draft = result.message;
    writeIntent = undefined;
    dirty = false;
    return true;
  } catch (error) {
    if (error.code) writeIntent = undefined;
    throw error;
  } finally {
    lockForm();
  }
}
async function send() {
  if (!sendIntent) {
    if (!(await saveDraft())) return;
    sendIntent = { args: { id: draft.id, ifVersion: draft.version }, key: key() };
  }
  lockForm();
  let result;
  try {
    result = await call("messages.send", sendIntent.args, sendIntent.key);
    sendIntent = undefined;
  } catch (error) {
    if (error.code) sendIntent = undefined;
    throw error;
  } finally {
    lockForm();
  }
  dirty = false;
  await showFolder("sent");
  notice(`“${result.message.subject || "(No subject)"}” is in Sent. No external email was delivered.`);
}
$("#compose-form").addEventListener("input", () => {
  dirty = true;
  if (!writeIntent && !sendIntent) notice();
  if (writeIntent || sendIntent)
    notice(
      "An earlier save or send has an uncertain result. Retry that action before changing the draft.",
      true,
    );
});
$("#compose-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(send);
});
$("#save").addEventListener("click", () =>
  action(async () => {
    if (sendIntent) throw new Error("Retry Send message to resolve the pending send first.");
    if (await saveDraft()) notice("Draft saved in the local mailbox.");
  }),
);
$("#compose").addEventListener("click", () => action(() => compose()));
$("#reply").addEventListener("click", () => action(() => compose(selected)));
$("#edit-draft").addEventListener("click", () => action(() => compose(selected)));
$("#close-compose").addEventListener("click", () => action(() => showFolder()));
$("#back").addEventListener("click", () => action(() => showFolder()));
$("#refresh").addEventListener("click", () => action(refresh));
for (const button of document.querySelectorAll("[data-folder]"))
  button.addEventListener("click", () => action(() => showFolder(button.dataset.folder)));
$("#delete").addEventListener("click", () =>
  action(async () => {
    const message = selected;
    if (
      !(await confirmAction(
        "Delete this message?",
        `“${message.subject || "(No subject)"}” will be removed from this synthetic mailbox.`,
      ))
    )
      return;
    await call("messages.delete", { id: message.id, ifVersion: message.version }, key());
    await showFolder();
    notice("Message deleted.");
  }),
);
window.addEventListener("beforeunload", (event) => {
  if (dirty || writeIntent || sendIntent) {
    event.preventDefault();
    event.returnValue = "";
  }
});
watchWorld(refresh, () => !composing);
