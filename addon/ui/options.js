/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Options page: accounts, tool groups, direct send and its allowlist,
// attachment folder, excluded folders, pause, connection details and the
// activity log. Settings are saved with settings.update; everything about
// the host goes through the background (runtime messages). The account
// and folder lists follow Thunderbird's account and folder events while
// the page is open. Saving also records the folders shown as seen by the
// user (exclusions.js), for each account with excluded folders.

import { load, update, enabledTools, STORAGE_KEY } from "../src/settings.js";
import { isRealFolder, followFolder, missingExclusions, reviewed } from "../src/exclusions.js";
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

const NEW_ACCOUNT = "New account: not enabled yet.";
const NEW_FOLDER = "(new: hidden from AI apps until you save)";
const NOT_FOUND = "(not found in Thunderbird)";
const MISSING_NOTE =
  "Some excluded folders were not found. A folder renamed or moved outside Thunderbird, such as in webmail, appears here as a new folder: tick it to keep it excluded. Until you save, new folders in those accounts stay hidden from AI apps. Untick a folder that was not found to stop excluding it.";

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
  let accounts = (await m.accounts.list(false)) || [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  let accountBoxes = [];
  const folderCache = new Map(); // accountId -> folders
  // Every exclusion, shown or not. Ticks and unticks change it, and so do
  // the folder events that move it with its folder.
  const excluded = new Map(settings.excludedFolders.map((e) => [keyOf(e.accountId, e.path), e]));
  // The folders seen in each account with exclusions, as the background
  // keeps them; only for the labels.
  let known = settings.knownFolders || {};
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
        list = ((await m.folders.query({ accountId })) || []).filter((f) => isRealFolder(f) && f.accountId === accountId);
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
    let missingCount = 0;
    const enabled = [];
    for (const input of accountBoxes.filter((b) => b.checked)) {
      const accountId = input.getAttribute("data-id");
      const folders = await foldersOf(accountId);
      if (run !== renderRun) return;
      enabled.push({ name: accountName.get(accountId), folders });
      const seen = known[accountId] && typeof known[accountId] === "object" ? known[accountId] : null;
      const row = (path, suffix) => {
        const text = `${accountName.get(accountId)}: ${path}${suffix ? ` ${suffix}` : ""}`;
        const { label, input: cb } = checkboxRow(doc, text, { "data-account": accountId, "data-path": path }, excluded.has(keyOf(accountId, path)));
        cb.addEventListener("change", () => {
          const k = keyOf(accountId, path);
          if (cb.checked) excluded.set(k, { accountId, path });
          else excluded.delete(k);
        });
        rows.push(label);
        shown++;
      };
      for (const f of folders) row(f.path, seen && !Object.hasOwn(seen, f.path.replace(/\/+$/, "")) ? NEW_FOLDER : "");
      // Exclusions whose folder is gone stay listed, ticked, until the
      // user unticks them.
      const lost = missingExclusions({ excludedFolders: [...excluded.values()] }, accountId, folders);
      for (const path of lost) row(path, NOT_FOUND);
      if (lost.length > 0) missingCount++;
    }
    if (run !== renderRun) return;
    $("excluded").replaceChildren(...rows);
    $("excluded-empty").hidden = shown > 0;
    $("missing-note").textContent = missingCount > 0 ? MISSING_NOTE : "";
    $("missing-note").hidden = missingCount === 0;
    // Folder exclusions are by path; Gmail shows one message in several
    // folders (R34).
    const gmail = allMailAccounts(enabled);
    $("gmail-note").textContent = gmail.length ? `${GMAIL_NOTE} (${gmail.join(", ")})` : "";
    $("gmail-note").hidden = gmail.length === 0;
  }

  // renderAccounts lists the accounts. A box keeps its tick across a
  // re-list; an account the settings have never seen is new, and not
  // enabled until the user ticks it and saves.
  function renderAccounts(stored) {
    const ticked = new Map(accountBoxes.map((b) => [b.getAttribute("data-id"), b.checked]));
    const rows = [];
    accountBoxes = [];
    for (const a of accounts) {
      const id = a.id;
      const isNew = settings.setupDone && !Object.hasOwn(stored, id);
      const { label, input } = checkboxRow(doc, a.name, { "data-id": id }, ticked.has(id) ? ticked.get(id) : stored[id] === true, isNew ? NEW_ACCOUNT : "");
      input.addEventListener("change", () => renderExcluded());
      rows.push(label);
      accountBoxes.push(input);
    }
    $("accounts").replaceChildren(...rows);
    $("accounts-empty").hidden = accounts.length > 0;
  }
  renderAccounts(settings.accounts);

  async function accountsChanged() {
    try {
      accounts = (await m.accounts.list(false)) || [];
    } catch {
      return;
    }
    for (const a of accounts) accountName.set(a.id, a.name);
    const ids = new Set(accounts.map((a) => a.id));
    // A deleted account's settings go (the background removes them).
    for (const [k, e] of excluded) if (!ids.has(e.accountId)) excluded.delete(k);
    renderAccounts((await load()).accounts);
    await renderExcluded();
  }

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
    if (!box.checked) {
      // Unticking gives the permission back, so Thunderbird no longer
      // lists the add-on as able to send.
      try {
        await m.permissions.remove({ permissions: ["messages.send"] });
      } catch {
        // the settings gate still keeps mail_send off
      }
      return;
    }
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
      const groups = {};
      for (const g of GROUPS) groups[g] = $(`group-${g}`).checked;
      const sendOn = $("send-enabled").checked;
      const exclusions = [...excluded.values()];
      let before;
      const after = await update((cur) => {
        before = cur;
        const accountMap = { ...cur.accounts };
        for (const b of accountBoxes) accountMap[b.getAttribute("data-id")] = b.checked;
        // The folders listed for a ticked account are now seen by the
        // user; an account without exclusions needs no list.
        const knownFolders = { ...(cur.knownFolders || {}) };
        for (const b of accountBoxes) {
          const id = b.getAttribute("data-id");
          const folders = folderCache.get(id);
          if (!exclusions.some((e) => e.accountId === id)) delete knownFolders[id];
          else if (b.checked && folders && folders.length > 0) knownFolders[id] = reviewed(folders, id);
        }
        return {
          accounts: accountMap,
          groups,
          send: { enabled: sendOn, allow: list.entries },
          attachmentDir: dir,
          excludedFolders: exclusions,
          knownFolders,
        };
      });
      known = after.knownFolders || {};
      renderAccounts(after.accounts);
      await renderExcluded();
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

  // ---- Thunderbird's folder and account events ----

  // A rename, move or copy moves the page's exclusions with the folder, as
  // the background does with the saved ones, so a save made now keeps
  // them on the folder.
  function folderMoved(from, to, keep) {
    if (!from || !to) return;
    const patch = followFolder({ excludedFolders: [...excluded.values()], knownFolders: known }, from, to, { keep });
    if (patch) {
      excluded.clear();
      for (const e of patch.excludedFolders) excluded.set(keyOf(e.accountId, e.path), e);
      known = patch.knownFolders;
    }
    folderCache.delete(from.accountId);
    folderCache.delete(to.accountId);
    renderExcluded();
  }
  function folderChanged(f) {
    if (!f) return;
    folderCache.delete(f.accountId);
    renderExcluded();
  }
  const listen = (ev, fn) => {
    if (ev && ev.addListener) ev.addListener(fn);
  };
  if (m.folders) {
    listen(m.folders.onRenamed, (a, b) => folderMoved(a, b, false));
    listen(m.folders.onMoved, (a, b) => folderMoved(a, b, false));
    listen(m.folders.onCopied, (a, b) => folderMoved(a, b, true));
    listen(m.folders.onCreated, folderChanged);
    listen(m.folders.onDeleted, folderChanged);
  }
  listen(m.accounts.onCreated, () => accountsChanged());
  listen(m.accounts.onDeleted, () => accountsChanged());
  // The background adopts new folders after a while: the labels follow.
  if (m.storage && m.storage.onChanged) {
    listen(m.storage.onChanged, (changes, area) => {
      const next = area === "local" && changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue;
      if (!next || JSON.stringify(next.knownFolders || {}) === JSON.stringify(known)) return;
      known = next.knownFolders || {};
      renderExcluded();
    });
  }

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
