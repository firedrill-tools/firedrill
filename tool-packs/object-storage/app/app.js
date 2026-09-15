import { $, action, call, confirmAction, empty, key, node, notice, pager, watchWorld } from "./ui.js";

let bucket = "documents";
let prefix = "";
let cursors = [undefined];
let page = 0;
let editing = false;
let dirty = false;
let object;
let writeIntent;
let navigation = 0;
function lockForm() {
  for (const field of document.querySelectorAll("#object-form input, #object-form textarea"))
    field.readOnly =
      Boolean(writeIntent) || (Boolean(object) && ["object-bucket", "object-key"].includes(field.id));
}
async function leaveEditor() {
  if (
    dirty &&
    !(await confirmAction(
      "Discard unsaved changes?",
      "Only edits in this form will be discarded. The saved object will not change.",
      "Discard changes",
    ))
  )
    return false;
  dirty = false;
  writeIntent = undefined;
  editing = false;
  navigation++;
  return true;
}
async function browse() {
  if (!(await leaveEditor())) return;
  $("#editor").hidden = true;
  $("#listing").hidden = false;
  await refresh();
}
async function refresh() {
  if (editing) return;
  const generation = navigation;
  let result;
  try {
    result = await call("objects.list", {
      bucket,
      prefix,
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
  if (generation !== navigation || editing) return;
  const rows = $("#objects");
  rows.replaceChildren();
  if (!result.items.length)
    rows.append(
      empty(
        "No objects found",
        "Create a text object, change the bucket or prefix, or let your agent write one.",
      ),
    );
  for (const item of result.items) {
    const button = node("button", undefined, "list-item");
    button.type = "button";
    button.append(
      node("span", item.key, "subject"),
      node("span", item.contentType, "muted"),
      node("span", `${item.byteLength} B`, "detail"),
    );
    button.addEventListener("click", () =>
      action(async () => {
        const result = await call("objects.get", { bucket: item.bucket, key: item.key });
        openEditor(result.object);
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
function openEditor(value) {
  object = value;
  editing = true;
  dirty = false;
  writeIntent = undefined;
  navigation++;
  $("#listing").hidden = true;
  $("#editor").hidden = false;
  $("#editor-title").textContent = value?.key ?? "New object";
  $("#object-bucket").value = value?.bucket ?? bucket;
  $("#object-key").value = value?.key ?? "";
  $("#content-type").value = value?.contentType ?? "text/plain; charset=utf-8";
  $("#content").value = value?.content ?? "";
  $("#version").textContent = value
    ? `Version ${value.version} · ${value.byteLength} bytes`
    : "Text objects only. Nothing is uploaded to an external service.";
  $("#delete").hidden = !value;
  lockForm();
  $(value ? "#content" : "#object-key").focus();
}
async function save() {
  if (!writeIntent) {
    if (!$("#object-form").reportValidity()) return;
    writeIntent = {
      key: key(),
      args: {
        bucket: $("#object-bucket").value,
        key: $("#object-key").value,
        content: $("#content").value,
        contentType: $("#content-type").value,
        metadata: object?.metadata ?? {},
        ifVersion: object?.version ?? 0,
      },
    };
  }
  lockForm();
  try {
    const result = await call("objects.put", writeIntent.args, writeIntent.key);
    writeIntent = undefined;
    openEditor(result.object);
    notice("Object saved. Your agent can read it from the same environment.");
  } catch (error) {
    if (error.code) writeIntent = undefined;
    throw error;
  } finally {
    lockForm();
  }
}
$("#filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    bucket = $("#bucket").value;
    prefix = $("#prefix").value;
    page = 0;
    cursors = [undefined];
    navigation++;
    await refresh();
  });
});
$("#object-form").addEventListener("input", () => {
  dirty = true;
  if (!writeIntent) notice();
});
$("#object-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(save);
});
$("#new").addEventListener("click", () =>
  action(async () => {
    openEditor();
  }),
);
$("#refresh").addEventListener("click", () => action(refresh));
$("#back").addEventListener("click", () => action(browse));
$("#delete").addEventListener("click", () =>
  action(async () => {
    if (
      !(await confirmAction(
        "Delete this object?",
        `“${object.key}” will be removed from bucket “${object.bucket}” in this synthetic environment.`,
      ))
    )
      return;
    await call(
      "objects.delete",
      { bucket: object.bucket, key: object.key, ifVersion: object.version },
      key(),
    );
    dirty = false;
    await browse();
    notice("Object deleted.");
  }),
);
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
watchWorld(refresh, () => !editing);
