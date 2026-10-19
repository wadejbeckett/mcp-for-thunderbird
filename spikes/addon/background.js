// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// THROWAWAY spike background (Task 2). Never shipped.
// Connects to the spike native host, answers pings, and runs spike commands
// that the host forwards from its control socket.

const BG_START = Date.now();
let port = null;

function send(m) {
  try {
    if (port) port.postMessage(m);
  } catch (e) {
    console.error("spike send failed", e);
  }
}

function connect() {
  port = messenger.runtime.connectNative("mft_spike");
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {
    console.warn("spike port disconnected", p.error);
    port = null;
  });
  send({
    type: "hello",
    bgStart: BG_START,
    mv: messenger.runtime.getManifest().manifest_version,
    ua: navigator.userAgent,
  });
}

// Persistent listeners so the event page is started at Thunderbird startup.
messenger.runtime.onStartup.addListener(() => send({ type: "report", what: "onStartup", bgStart: BG_START }));
messenger.runtime.onInstalled.addListener(d => send({ type: "report", what: "onInstalled", reason: d.reason, bgStart: BG_START }));
if (messenger.runtime.onSuspend) {
  messenger.runtime.onSuspend.addListener(() =>
    send({ type: "suspend", bgStart: BG_START, uptimeMs: Date.now() - BG_START })
  );
}
messenger.runtime.onMessage.addListener(m => {
  send({ type: "report", what: "runtime.onMessage", msg: m, bgStart: BG_START });
});
messenger.permissions.onAdded.addListener(p => send({ type: "report", what: "permissions.onAdded", p }));

function onMessage(m) {
  if (m.type === "ping") {
    send({ type: "pong", seq: m.seq, bgStart: BG_START, uptimeMs: Date.now() - BG_START });
    return;
  }
  if (m.type === "call") {
    handle(m).then(
      content => send({ type: "result", id: m.id, ok: true, content }),
      e => send({ type: "result", id: m.id, ok: false, error: { message: String(e), stack: e && e.stack } })
    );
  }
}

async function plain(v) {
  if (v instanceof Blob) return { blobText: await v.text(), size: v.size, type: v.type };
  return v;
}

async function handle(m) {
  if (m.api) {
    const parts = m.api.split(".");
    const fnName = parts.pop();
    let obj = messenger;
    for (const p of parts) obj = obj[p];
    return plain(await obj[fnName](...(m.args || [])));
  }
  const a = m.args || {};
  switch (m.cmd) {
    case "status":
      return { bgStart: BG_START, uptimeMs: Date.now() - BG_START, perms: await messenger.permissions.getAll() };

    case "timeQuery": {
      // Time messages.query; optionally drain all pages. JSON cannot carry a
      // Date, and a string fromDate/toDate makes the query never settle on
      // 153 (getTime is not a function inside the search), so convert here.
      for (const k of ["fromDate", "toDate"]) {
        if (a.queryInfo && typeof a.queryInfo[k] === "string") a.queryInfo[k] = new Date(a.queryInfo[k]);
      }
      const runs = [];
      for (let i = 0; i < (a.runs || 1); i++) {
        const t0 = performance.now();
        let page = await messenger.messages.query(a.queryInfo);
        const tFirst = performance.now() - t0;
        let total = page.messages.length;
        const firstCount = total;
        if (a.drain) {
          while (page.id) {
            page = await messenger.messages.continueList(page.id);
            total += page.messages.length;
          }
        } else if (page.id) {
          await messenger.messages.abortList(page.id);
        }
        runs.push({ firstPageMs: tFirst, firstCount, totalMs: performance.now() - t0, total });
      }
      return runs;
    }

    case "raw": {
      // Raw source of a message by internal id.
      const raw = await messenger.messages.getRaw(a.id, { data_format: "BinaryString" });
      return { raw: typeof raw === "string" ? raw : await raw.text() };
    }

    case "beginReplyAndSave": {
      // Fallback recipe: open a reply composer, save it as a draft, close it.
      const t0 = performance.now();
      const tab = await messenger.compose.beginReply(a.messageId, a.replyType || "replyToSender", a.details || {});
      const details = await messenger.compose.getComposeDetails(tab.id);
      if (a.body !== undefined) {
        // Prepend our text above Thunderbird's own quote.
        const field = details.isPlainText ? "plainTextBody" : "body";
        const cur = details[field] || "";
        const upd = {};
        upd[field] = details.isPlainText
          ? a.body + "\n\n" + cur
          : cur.replace(/<body([^>]*)>/i, `<body$1><p>${a.body}</p>`);
        await messenger.compose.setComposeDetails(tab.id, upd);
      }
      const saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      const afterSave = await messenger.compose.getComposeDetails(tab.id);
      await messenger.windows.remove(tab.windowId);
      return { tab, detailsType: details.type, relatedMessageId: details.relatedMessageId, isModifiedAfterSave: afterSave.isModified, saved, ms: performance.now() - t0 };
    }

    case "importDraft": {
      // Recipe candidate: import a hand-built RFC 5322 reply into Drafts.
      const file = new File([a.raw], "draft.eml", { type: "message/rfc822" });
      return messenger.messages.import(file, a.folderId, a.properties || { read: true });
    }

    case "saveMessage":
      return messenger.messages.saveMessage(a.details, a.options);

    case "sendMessage":
      return messenger.messages.sendMessage(a.details, a.options);

    case "requestSendFromBackground":
      return messenger.permissions.request({ permissions: ["messages.send"] });

    case "openOptions":
      return messenger.runtime.openOptionsPage();

    default:
      throw new Error("unknown cmd " + m.cmd);
  }
}

connect();
