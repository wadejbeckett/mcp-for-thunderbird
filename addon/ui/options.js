/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Options page: accounts, tool groups, direct send and its allowlist,
// attachment folder, excluded folders, pause, connection details and the
// activity log. Settings are saved with settings.save; everything about
// the host goes through the background (runtime messages).

import { load, save, enabledTools } from "../src/settings.js";
import { byId, showState, showLog, checkboxRow, messageOf, realDeps, inPage } from "./dom.js";
import { supported } from "../src/features.js";
import { parseAllowlist, isAbsolutePath, RESTART_NOTE, allMailAccounts, GMAIL_NOTE } from "./logic.js";

const GROUPS = ["read", "organise", "compose", "contacts"];
const LOG_SHOWN = 100;
const NOT_CONNECTED = "MCP for Thunderbird is not connected to its host program.";
const PATH_HELP = "Enter the full path of a folder, such as /home/anna/MCP-attachments or C:\\Users\\Anna\\MCP-attachments.";

const BROAD_FOLDER =
  "Choose a folder of its own, not the top of a drive or of the file system, and not a home folder itself: AI apps can attach any file in this folder to mail.";

const keyOf = (accountId, path) => `${accountId}\u0000${path}`;

// broadFolder says whether an absolute path names a folder too broad to
// be the attachment folder: a filesystem root (/), a drive root (C:\), a
// network share's root (\\server\share), a home folder itself
// (/home/anna, /Users/anna, /var/home/anna, /root, C:\Users\Anna) or the
// folder holding the home folders. It works from the text alone: the
// add-on cannot look at the file system, so it cannot tell where a link
// leads or which folder is this user's home.
export function broadFolder(p) {
  const unc = /^\\\\/.test(p);
  const windows = unc || /^[A-Za-z]:[\\/]/.test(p);
  const segs = p.split(windows ? /[\\/]+/ : /\/+/).filter((x) => x !== "");
  // The root is the drive letter, \\server\share or nothing; ".." stops
  // there, as it does on the file system.
  const parts = [];
  for (const seg of segs.slice(unc ? 2 : windows ? 1 : 0)) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(windows ? seg.toLowerCase() : seg);
  }
  if (parts.length === 0) return true;
  const [a, b] = parts;
  if (windows) return (a === "users" || a === "documents and settings") && parts.length <= 2;
  if ((a === "home" || a.toLowerCase() === "users") && parts.length <= 2) return true;
  if (a === "root" && parts.length === 1) return true;
  return a === "var" && b === "home" && parts.length <= 3;
}

export async function initOptions(doc, { send, m, clipboard, confirm }) {
  const $ = (id) => byId(doc, id);
  const settings = await load();
  const accounts = (await m.accounts.list(false)) || [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const accountBoxes = [];
  const folderCache = new Map(); // accountId -> folders
  // Every exclusion, shown or not. Only ticks and unticks change it.
  const excluded = new Map(settings.excludedFolders.map((e) => [keyOf(e.accountId, e.path), e]));
  let paused = settings.paused;

  // ---- state and pause ----

  async function refreshState() {
    try {
      const s = await send({ type: "getState" });
      paused = s.paused;
      showState(doc, $("state"), s.state, s.error);
      $("pause").textContent = paused ? "Resume" : "Pause";
    } catch {
      showState(doc, $("state"), "not_connected");
    }
  }

  $("pause").addEventListener("click", async () => {
    try {
      await send({ type: "setPaused", paused: !paused });
    } catch {
      // refreshState shows what is true
    }
    await refreshState();
  });

  // ---- accounts and excluded folders ----

  async function foldersOf(accountId) {
    if (!folderCache.has(accountId)) {
      let list = [];
      try {
        list = ((await m.folders.query({ accountId })) || []).filter((f) => !f.isRoot);
      } catch {
        list = [];
      }
      folderCache.set(accountId, list.sort((a, b) => a.path.localeCompare(b.path)));
    }
    return folderCache.get(accountId);
  }

  // renderExcluded lists the folders of the ticked accounts. Runs overlap
  // when accounts are ticked quickly; only the latest one changes the page,
  // and it does so at once, so rows are never listed twice.
  let renderRun = 0;
  async function renderExcluded() {
    const run = ++renderRun;
    const rows = [];
    let shown = 0;
    const enabled = [];
    for (const input of accountBoxes.filter((b) => b.checked)) {
      const accountId = input.getAttribute("data-id");
      const folders = await foldersOf(accountId);
      if (run !== renderRun) return;
      enabled.push({ name: accountName.get(accountId), folders });
      for (const f of folders) {
        const { label, input: cb } = checkboxRow(doc, `${accountName.get(accountId)}: ${f.path}`, { "data-account": accountId, "data-path": f.path }, excluded.has(keyOf(accountId, f.path)));
        cb.addEventListener("change", () => {
          const k = keyOf(accountId, f.path);
          if (cb.checked) excluded.set(k, { accountId, path: f.path });
          else excluded.delete(k);
        });
        rows.push(label);
        shown++;
      }
    }
    if (run !== renderRun) return;
    $("excluded").replaceChildren(...rows);
    $("excluded-empty").hidden = shown > 0;
    // Folder exclusions are by path; Gmail shows one message in several
    // folders (R34).
    const gmail = allMailAccounts(enabled);
    $("gmail-note").textContent = gmail.length ? `${GMAIL_NOTE} (${gmail.join(", ")})` : "";
    $("gmail-note").hidden = gmail.length === 0;
  }

  for (const a of accounts) {
    const { label, input } = checkboxRow(doc, a.name, { "data-id": a.id }, settings.accounts[a.id] === true);
    input.addEventListener("change", () => renderExcluded());
    $("accounts").append(label);
    accountBoxes.push(input);
  }
  $("accounts-empty").hidden = accounts.length > 0;

  for (const g of GROUPS) $(`group-${g}`).checked = Boolean(settings.groups[g]);
  $("attachment-dir").value = settings.attachmentDir;
  $("send-enabled").checked = settings.send.enabled;
  $("send-allow").value = settings.send.allow.join("\n");

  // Thunderbird 140 cannot save drafts or send without a window
  // (features.js): say so, and keep direct send off and unchangeable.
  $("draft-unsupported").hidden = supported("mail_draft", m);
  if (!supported("mail_send", m)) {
    $("send-unsupported").hidden = false;
    $("send-enabled").checked = false;
    $("send-enabled").disabled = true;
  }

  // ---- direct send: the permission is asked for by this click ----

  $("send-enabled").addEventListener("change", async () => {
    const box = $("send-enabled");
    if (!box.checked) return;
    // No await before this call: Thunderbird allows the request only
    // while it is handling the click (docs/SPIKES.md section 4).
    const asked = m.permissions.request({ permissions: ["messages.send"] });
    let granted = false;
    try {
      granted = await asked;
    } catch {
      granted = false;
    }
    if (!granted) {
      box.checked = false;
      $("save-status").textContent = "Sending stays off: Thunderbird did not allow it. Tick the box again to be asked once more.";
    }
  });

  // ---- save ----

  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("save-status");
    status.textContent = "";
    const list = parseAllowlist($("send-allow").value);
    $("send-allow-error").textContent = list.errors.map((e) => (e.line ? `Line ${e.line} (${e.text}): ${e.message}` : e.message)).join(" ");
    const dir = $("attachment-dir").value.trim();
    const dirProblem = dir === "" ? "" : !isAbsolutePath(dir) ? PATH_HELP : broadFolder(dir) ? BROAD_FOLDER : "";
    const dirBad = dirProblem !== "";
    $("attachment-dir-error").textContent = dirProblem;
    if (list.errors.length > 0 || dirBad) {
      status.textContent = "Nothing was saved. Fix the problems above and save again.";
      return;
    }
    try {
      const before = await load();
      const accountMap = { ...before.accounts };
      for (const b of accountBoxes) accountMap[b.getAttribute("data-id")] = b.checked;
      const groups = {};
      for (const g of GROUPS) groups[g] = $(`group-${g}`).checked;
      const sendOn = $("send-enabled").checked;
      const after = await save({
        accounts: accountMap,
        groups,
        send: { enabled: sendOn, allow: list.entries },
        attachmentDir: dir,
        excludedFolders: [...excluded.values()],
      });
      const changed = JSON.stringify(enabledTools(before)) !== JSON.stringify(enabledTools(after));
      $("restart-note").textContent = RESTART_NOTE;
      $("restart-note").hidden = !changed;
      status.textContent = sendOn && list.entries.length === 0 ? "Saved. Sending stays off until you list at least one allowed recipient." : "Saved.";
    } catch (e) {
      status.textContent = `Nothing was saved. ${messageOf(e, "Try again.")}`;
    }
  });

  // ---- AI apps: the setup page, opened again ----

  $("open-setup").addEventListener("click", async () => {
    try {
      await m.tabs.create({ url: m.runtime.getURL("ui/setup.html") });
    } catch {
      // the page stays as it is
    }
  });

  // ---- connection details ----

  $("copy-token").addEventListener("click", async () => {
    const status = $("connection-status");
    try {
      const { token, url } = await send({ type: "requestToken" });
      $("endpoint").textContent = url;
      if (!token) {
        status.textContent = "The host program has no access key at the moment. Restart Thunderbird to give it a new one.";
        return;
      }
      await clipboard.writeText(token);
      status.textContent = "Token copied. Paste it where the app asks for it; it is not kept anywhere else.";
    } catch (e) {
      status.textContent = messageOf(e, NOT_CONNECTED);
    }
  });

  $("rotate").addEventListener("click", async () => {
    if (!confirm("Rotate the access key? Apps using the old key will stop working until they are given the new one.")) return;
    try {
      await send({ type: "rotateToken" });
      $("connection-status").textContent = "The access key was rotated.";
    } catch (e) {
      $("connection-status").textContent = messageOf(e, NOT_CONNECTED);
    }
  });

  // ---- activity log ----

  async function refreshLog() {
    showLog(doc, $("log"), $("log-empty"), await send({ type: "listLog", limit: LOG_SHOWN }));
  }

  $("clear-log").addEventListener("click", async () => {
    await send({ type: "clearLog" });
    await refreshLog();
  });

  await renderExcluded();
  await refreshState();
  await refreshLog();
  try {
    $("endpoint").textContent = (await send({ type: "getEndpoint" })).url;
  } catch {
    // stays at "Not available yet"
  }
}

if (inPage()) initOptions(document, realDeps());
