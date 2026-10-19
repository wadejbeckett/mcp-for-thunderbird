/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Background: keeps the native port to the host open, says hello, answers
// tool calls, keeps the host's tool list current and shows the state in
// the toolbar button.
//
// MV3 event page (ruling R6): an open native port keeps the page alive.
// Without one the page suspends after about 30 s and loses its timers, so
// the first reconnect is immediate (docs/SPIKES.md §1) and the backoff is
// capped at 25 s (ruling R17).

import { load, save, enabledTools, STORAGE_KEY } from "./settings.js";
import { list as logList, clear as logClear } from "./log.js";
import { dispatch } from "./rpc.js";
// Handler modules register themselves in rpc.HANDLERS.
import "./handlers/read.js";
import "./handlers/contacts.js";
import "./handlers/organise.js";
import "./handlers/compose.js";

export const HOST_NAME = "mcp_for_thunderbird";
export const PROTOCOL = 1;
export const BACKOFF_SECONDS = Object.freeze([0, 1, 2, 4, 8, 16, 25]);
const REPLY_TIMEOUT_MS = 30_000;

const TOOLBAR = {
  connected: { title: "MCP for Thunderbird: connected", badge: "", color: "#2e7d32" },
  paused: { title: "MCP for Thunderbird: paused", badge: "II", color: "#8a6d00" },
  not_connected: { title: "MCP for Thunderbird: not connected", badge: "!", color: "#b00020" },
  mismatch: { title: "Update needed", badge: "!", color: "#b00020" },
};

const UPDATE_NEEDED = "MCP for Thunderbird and its host program need updating to matching versions.";
const NOT_CONNECTED = "MCP for Thunderbird is not connected to its host program.";
const GENERIC = "Thunderbird could not complete the request.";

function b64ToBytes(s) {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function createBackground({ setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout } = {}) {
  const m = () => globalThis.messenger;
  let port = null;
  let welcomed = false;
  let endpointPort = null; // the host's HTTP port from the last welcome
  let mismatch = false;
  let paused = false;
  let attempt = 0;
  let timer = null;
  let stopped = false;
  let helloSent = false;
  let lastTools = null;
  let lastDir = null;
  let reqSeq = 0;
  const blobs = new Map(); // blob id -> {chunks: [], done}
  const tokenWaiters = [];
  const clientWaiters = new Map(); // req -> {resolve, reject}
  const listeners = [];

  function on(ev, fn) {
    ev.addListener(fn);
    listeners.push([ev, fn]);
  }

  function state() {
    if (mismatch) return "mismatch";
    if (!port || !welcomed) return "not_connected";
    return paused ? "paused" : "connected";
  }

  async function showState() {
    const t = TOOLBAR[state()];
    const action = m().action;
    if (!action) return;
    try {
      await action.setTitle({ title: t.title });
      await action.setBadgeText({ text: t.badge });
      if (t.badge) await action.setBadgeBackgroundColor({ color: t.color });
    } catch {
      // the toolbar button is cosmetic
    }
  }

  function send(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  async function currentTools(s) {
    let tools = enabledTools(s);
    if (tools.includes("mail_send")) {
      let granted = false;
      try {
        granted = await m().permissions.contains({ permissions: ["messages.send"] });
      } catch {
        granted = false;
      }
      if (!granted) tools = tools.filter((t) => t !== "mail_send");
    }
    return tools;
  }

  async function connect() {
    timer = null;
    if (stopped) return;
    welcomed = false;
    endpointPort = null;
    mismatch = false;
    helloSent = false;
    let p;
    try {
      p = m().runtime.connectNative(HOST_NAME);
    } catch {
      scheduleReconnect();
      return;
    }
    port = p;
    p.onMessage.addListener((msg) => onMessage(p, msg));
    p.onDisconnect.addListener(() => onDisconnect(p));
    const s = await load();
    paused = s.paused;
    const tools = await currentTools(s);
    if (port !== p) return;
    lastTools = JSON.stringify(tools);
    lastDir = s.attachmentDir;
    send({
      type: "hello",
      protocol: PROTOCOL,
      version: m().runtime.getManifest().version,
      instance: s.instance,
      tools,
      attachmentDir: s.attachmentDir,
    });
    helloSent = true;
    await showState();
    // Settings may have changed while the hello was being built.
    await refreshTools();
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    const secs = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
    attempt++;
    timer = setT(connect, secs * 1000);
  }

  function failPending(message) {
    for (const w of tokenWaiters.splice(0)) w.reject(new Error(message));
    for (const [req, w] of clientWaiters) {
      clientWaiters.delete(req);
      w.reject(new Error(message));
    }
  }

  function onDisconnect(p) {
    if (port !== p) return;
    port = null;
    welcomed = false;
    endpointPort = null;
    mismatch = false;
    blobs.clear();
    failPending(NOT_CONNECTED);
    showState();
    scheduleReconnect();
  }

  function onMessage(p, msg) {
    if (port !== p || !msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "welcome":
        welcomed = true;
        attempt = 0;
        mismatch = msg.ok === false || msg.protocol !== PROTOCOL;
        endpointPort = Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536 ? msg.port : null;
        showState();
        return;
      case "blob":
        return onBlob(msg);
      case "call":
        // Answer on the port the call came in on; a reply for a closed
        // port is dropped.
        onCall(msg).then((r) => {
          if (port === p) send(r);
        });
        return;
      case "token": {
        const w = tokenWaiters.splice(0);
        for (const x of w) x.resolve({ token: msg.token, url: msg.url });
        return;
      }
      case "clients_result": {
        const w = clientWaiters.get(msg.req);
        if (w) {
          clientWaiters.delete(msg.req);
          w.resolve(Array.isArray(msg.clients) ? msg.clients : []);
        }
        return;
      }
      default:
    }
  }

  function onBlob(msg) {
    if (typeof msg.blob !== "string" || typeof msg.data !== "string") return;
    let b = blobs.get(msg.blob);
    if (!b) {
      b = { chunks: [], done: false, bad: false };
      blobs.set(msg.blob, b);
    }
    try {
      if (msg.seq !== b.chunks.length) throw new Error("out of order");
      b.chunks.push(b64ToBytes(msg.data));
    } catch {
      b.bad = true;
    }
    if (msg.last) b.done = true;
  }

  // withAttachments resolves call.args.attachments[i].blob (an index into
  // call.blobs, ruling R15) to {name, data: Uint8Array}.
  function withAttachments(call) {
    const ids = Array.isArray(call.blobs) ? call.blobs : [];
    const args = call.args;
    if (!args || !Array.isArray(args.attachments)) {
      if (ids.length) throw { code: "invalid_argument", message: "Attachment data was sent without attachments." };
      return call;
    }
    const attachments = args.attachments.map((a) => {
      if (!a || typeof a !== "object" || !Number.isInteger(a.blob)) return a;
      const b = blobs.get(ids[a.blob]);
      if (a.blob < 0 || a.blob >= ids.length || !b || !b.done || b.bad) {
        throw { code: "invalid_argument", message: "Attachment data did not arrive complete." };
      }
      return { name: a.name, data: concat(b.chunks) };
    });
    return { ...call, args: { ...args, attachments } };
  }

  // onCall answers one call. The call's blobs are freed once its
  // attachments are built, whatever the outcome.
  async function onCall(call) {
    const refuse = (error) => ({ type: "result", id: call.id, ok: false, error });
    let ready;
    try {
      if (mismatch) return refuse({ code: "refused", message: UPDATE_NEEDED });
      if (!welcomed) return refuse({ code: "refused", message: "Not connected yet" });
      ready = withAttachments(call);
    } catch (e) {
      return refuse(e && e.code === "invalid_argument" ? { code: e.code, message: e.message } : { code: "thunderbird_error", message: GENERIC });
    } finally {
      for (const id of Array.isArray(call.blobs) ? call.blobs : []) blobs.delete(id);
    }
    try {
      return await dispatch(ready);
    } catch {
      return refuse({ code: "thunderbird_error", message: GENERIC });
    }
  }

  async function onSettingsChanged(changes, area) {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const s = changes[STORAGE_KEY].newValue;
    if (!s) return;
    paused = Boolean(s.paused);
    showState();
    await refreshTools(s);
    if (port && helloSent && s.attachmentDir !== lastDir) {
      lastDir = s.attachmentDir;
      send({ type: "config", attachmentDir: s.attachmentDir });
    }
  }

  async function refreshTools(s) {
    s = s || (await load());
    const tools = await currentTools(s);
    const key = JSON.stringify(tools);
    if (port && helloSent && key !== lastTools) {
      lastTools = key;
      send({ type: "tools", tools });
    }
  }

  function waitReply(register, unregister) {
    return new Promise((resolve, reject) => {
      const t = setT(() => {
        unregister();
        reject(new Error("The host program did not answer."));
      }, REPLY_TIMEOUT_MS);
      register({
        resolve: (v) => {
          clearT(t);
          resolve(v);
        },
        reject: (e) => {
          clearT(t);
          reject(e);
        },
      });
    });
  }

  function requestToken() {
    if (!port || !welcomed) return Promise.reject(new Error(NOT_CONNECTED));
    let w;
    const p = waitReply(
      (x) => {
        w = x;
        tokenWaiters.push(x);
      },
      () => {
        const i = tokenWaiters.indexOf(w);
        if (i >= 0) tokenWaiters.splice(i, 1);
      },
    );
    send({ type: "token_request" });
    return p;
  }

  function clientsRequest(type, extra) {
    if (!port || !welcomed) return Promise.reject(new Error(NOT_CONNECTED));
    const req = `r${++reqSeq}`;
    const p = waitReply(
      (x) => clientWaiters.set(req, x),
      () => clientWaiters.delete(req),
    );
    send({ type, req, ...extra });
    return p;
  }

  const detectClients = () => clientsRequest("clients_detect", {});
  const configureClients = (names) => clientsRequest("clients_configure", { clients: [...names] });

  function rotateToken() {
    if (!port || !welcomed) return Promise.reject(new Error(NOT_CONNECTED));
    send({ type: "rotate_token" });
    return Promise.resolve(true);
  }

  // UI pages (setup, options, popup) reach the background through
  // runtime messaging and never touch the native port. The reply is a
  // promise, or undefined for a message that is not ours.
  async function getState() {
    return { state: state(), paused: (await load()).paused };
  }

  async function setPaused(value) {
    if (typeof value !== "boolean") throw new Error("Paused must be true or false.");
    await save({ paused: value });
    return { paused: value };
  }

  // getEndpoint derives the URL from the port in the host's welcome; it
  // never asks the host for the token.
  async function getEndpoint() {
    if (!port || !welcomed || mismatch || endpointPort === null) throw new Error(NOT_CONNECTED);
    return { url: `http://127.0.0.1:${endpointPort}/mcp` };
  }

  async function listLog(limit) {
    const all = await logList();
    const n = Number.isInteger(limit) && limit > 0 ? limit : all.length;
    return all.slice(-n).reverse();
  }

  const ROUTES = {
    getState: () => getState(),
    setPaused: (msg) => setPaused(msg.paused),
    requestToken: () => requestToken(),
    getEndpoint: () => getEndpoint(),
    detectClients: () => detectClients(),
    configureClients: (msg) => configureClients(Array.isArray(msg.clients) ? msg.clients : []),
    rotateToken: () => rotateToken(),
    listLog: (msg) => listLog(msg.limit),
    clearLog: async () => {
      await logClear();
      return true;
    },
  };

  // ourPage fails closed: only a sender that is this add-on and one of its
  // own pages (moz-extension://<our uuid>/...) is answered.
  function ourPage(sender) {
    const rt = m().runtime;
    if (!sender || typeof sender !== "object" || sender.id !== rt.id) return false;
    return typeof sender.url === "string" && sender.url.startsWith(rt.getURL(""));
  }

  function onRuntimeMessage(msg, sender) {
    if (!msg || typeof msg !== "object" || !ourPage(sender)) return undefined;
    const route = Object.hasOwn(ROUTES, msg.type) ? ROUTES[msg.type] : null;
    return route ? route(msg) : undefined;
  }

  async function onInstalled(details) {
    if (!details || details.reason !== "install") return;
    const s = await load();
    if (s.setupDone) return;
    await m().tabs.create({ url: m().runtime.getURL("ui/setup.html") });
  }

  async function start() {
    stopped = false;
    const rt = m().runtime;
    on(rt.onInstalled, onInstalled);
    on(rt.onStartup, () => {});
    on(rt.onMessage, onRuntimeMessage);
    on(m().storage.onChanged, onSettingsChanged);
    if (m().permissions) {
      on(m().permissions.onAdded, () => refreshTools().catch(() => {}));
      on(m().permissions.onRemoved, () => refreshTools().catch(() => {}));
    }
    await connect();
  }

  function stop() {
    stopped = true;
    if (timer) clearT(timer);
    timer = null;
    for (const [ev, fn] of listeners.splice(0)) ev.removeListener(fn);
    if (port) {
      const p = port;
      port = null;
      try {
        p.disconnect();
      } catch {
        // already closed
      }
    }
    blobs.clear();
    failPending(NOT_CONNECTED);
  }

  return {
    start,
    stop,
    state,
    requestToken,
    detectClients,
    configureClients,
    rotateToken,
    blobCount: () => blobs.size,
  };
}

if (!globalThis.MFT_NO_AUTOSTART && globalThis.messenger && globalThis.messenger.runtime) {
  createBackground().start();
}
