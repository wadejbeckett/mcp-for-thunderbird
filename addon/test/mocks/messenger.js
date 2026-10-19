/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mock `messenger` API for the add-on tests.
// Derived from the vitalio-sh "thunderbird-cli" extension test mocks
// (test/extension.test.mjs, seed commit 465613d), MIT licence, see NOTICE.
// Extended with native ports, storage.local and onChanged, accounts,
// folders, paged messages.query, action and permissions. Task 11 added
// identities, folder info, date windows and the other query filters,
// oldest-first ordering, never-settling queries, raw sources, attachments
// and address books. Task 12 added getFull (plain and HTML parts, extra
// headers), Task 13 getAttachmentFile and messages.tags.list.

export function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    fire: (...args) => listeners.map((fn) => fn(...args)),
  };
}

const date = (s) => new Date(s);

// header builds a MessageHeader like the vitalio-sh mock's, in a folder.
export function header(id, folder, extra = {}) {
  return {
    id,
    subject: `Message ${id}`,
    author: "a@example.org",
    date: date("2026-01-01T00:00:00Z"),
    read: false,
    flagged: false,
    junk: false,
    size: 10,
    tags: [],
    recipients: [],
    ccList: [],
    bccList: [],
    folder,
    headerMessageId: `m${id}@example.org`,
    ...extra,
  };
}

export class MockPort {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.error = null;
    this.disconnected = false;
    this.onMessage = event();
    this.onDisconnect = event();
  }
  postMessage(m) {
    if (this.disconnected) throw new Error("Attempt to postMessage on disconnected port");
    this.sent.push(JSON.parse(JSON.stringify(m)));
  }
  disconnect() {
    this.disconnected = true;
  }
  // test helpers
  receive(m) {
    return this.onMessage.fire(m, this);
  }
  drop(message = "host exited") {
    this.disconnected = true;
    this.error = { message };
    this.onDisconnect.fire(this);
  }
  sentOfType(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

// createMessenger returns a fresh mock. `accounts` is a list of
// {id, name, type, identities?, folders: [path, ...], specialUse?: {path: [use]}}.
// `books` is a list of {id, name, contacts: [vCard string, ...]}.
export function createMessenger({ accounts = [], manifest = { version: "0.0.0", manifest_version: 3 }, granted = [], books = [] } = {}) {
  const local = new Map();
  const onChanged = event();
  const ports = [];
  const tabs = [];
  const actionState = { badgeText: "", title: "", badgeColor: null };
  const perms = new Set(granted);

  const folderList = [];
  for (const a of accounts) {
    for (const path of a.folders || []) {
      folderList.push({
        id: `${a.id}:/${path}`,
        accountId: a.id,
        path,
        name: path.split("/").pop(),
        isRoot: false,
        specialUse: (a.specialUse && a.specialUse[path]) || [],
      });
    }
  }

  // messages: numeric id -> header
  const store = new Map();
  let nextId = 1;
  // side data a real MessageHeader does not carry
  const bodies = new Map();
  const attachments = new Map();
  const refs = new Map();
  const htmlBodies = new Map();
  const extraHeaders = new Map();
  const calls = {
    query: [],
    abortList: [],
    continueList: [],
    get: [],
    getRaw: [],
    getFull: [],
    listAttachments: [],
    getAttachmentFile: [],
    getFolderInfo: [],
    contactsQuery: [],
  };
  // hang: queries matching this predicate never settle (as some
  // Thunderbird searches do, docs/SPIKES.md §3); with returnMessageListId
  // the id comes back but the list's pages never do. delay(q) gives a
  // query's answer time in ms.
  const behaviour = { hang: null, delay: null, inFlight: 0, maxInFlight: 0 };
  // pages read per query (index into calls.query), first page included
  const pagesByQuery = new Map();
  const lists = new Map();
  let nextList = 1;

  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  const messenger = {
    runtime: {
      id: "mcp-for-thunderbird@wadejbeckett.github.io",
      getManifest: () => manifest,
      getURL: (p) => `moz-extension://test-uuid/${p.replace(/^\//, "")}`,
      connectNative: (name) => {
        const p = new MockPort(name);
        ports.push(p);
        return p;
      },
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      onSuspend: event(),
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const want = keys == null ? [...local.keys()] : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          for (const k of want) {
            if (local.has(k)) out[k] = clone(local.get(k));
            else if (keys && typeof keys === "object" && !Array.isArray(keys) && k in keys) out[k] = keys[k];
          }
          return out;
        },
        set: async (items) => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: clone(local.get(k)), newValue: clone(v) };
            local.set(k, clone(v));
          }
          onChanged.fire(changes, "local");
        },
        remove: async (keys) => {
          for (const k of [].concat(keys)) local.delete(k);
        },
        clear: async () => local.clear(),
      },
      onChanged,
    },
    accounts: {
      list: async () => accounts.map(({ id, name, type, identities = [] }) => ({ id, name, type, identities: clone(identities) })),
      get: async (id) => {
        const a = accounts.find((x) => x.id === id);
        return a ? { id: a.id, name: a.name, type: a.type, identities: clone(a.identities || []) } : null;
      },
    },
    folders: {
      query: async (q = {}) =>
        folderList.filter((f) => (q.accountId == null || f.accountId === q.accountId) && (q.path == null || f.path === q.path)).map(clone),
      get: async (id) => {
        const f = folderList.find((x) => x.id === id);
        if (!f) throw new Error(`Folder not found: ${id}`);
        return clone(f);
      },
      getFolderInfo: async (id) => {
        calls.getFolderInfo.push(id);
        const f = folderList.find((x) => x.id === id);
        if (!f) throw new Error(`Folder not found: ${id}`);
        const hs = [...store.values()].filter((h) => h.folder.id === id);
        return { totalMessageCount: hs.length, unreadMessageCount: hs.filter((h) => !h.read).length };
      },
    },
    messages: {
      get: async (id) => {
        calls.get.push(id);
        if (!store.has(id)) throw new Error(`Message not found: ${id}.`);
        return clone(store.get(id));
      },
      // query honours the filters MCP for Thunderbird uses, returns
      // results oldest first (folder storage order) and pages them through
      // continueList. A string fromDate/toDate never settles, as in
      // Thunderbird 153. Text matches are case-sensitive.
      query: async (q = {}) => {
        calls.query.push(q);
        const never = () => new Promise(() => {});
        if (typeof q.fromDate === "string" || typeof q.toDate === "string") return never();
        const hang = Boolean(behaviour.hang && behaviour.hang(q));
        if (hang && !q.returnMessageListId) return never();
        const root = calls.query.length - 1;
        const delay = behaviour.delay ? behaviour.delay(q) : 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        behaviour.inFlight++;
        behaviour.maxInFlight = Math.max(behaviour.maxInFlight, behaviour.inFlight);
        await new Promise((r) => setImmediate(r));
        behaviour.inFlight--;
        const list = (v) => (v == null ? null : [].concat(v));
        const accs = list(q.accountId);
        const fids = list(q.folderId);
        const inFolder = (h) => {
          if (!fids) return true;
          return fids.some((fid) => {
            if (h.folder.id === fid) return true;
            const f = folderList.find((x) => x.id === fid);
            return Boolean(q.includeSubFolders && f && h.folder.accountId === f.accountId && h.folder.path.startsWith(f.path + "/"));
          });
        };
        const has = (s, sub) => String(s ?? "").includes(sub);
        const all = [...store.values()]
          .filter(
            (h) =>
              (!accs || accs.includes(h.folder.accountId)) &&
              inFolder(h) &&
              (q.headerMessageId == null || h.headerMessageId === q.headerMessageId) &&
              (q.fromDate == null || h.date.getTime() >= q.fromDate.getTime()) &&
              (q.toDate == null || h.date.getTime() <= q.toDate.getTime()) &&
              (q.author == null || has(h.author, q.author)) &&
              (q.recipients == null || [...h.recipients, ...h.ccList, ...h.bccList].some((r) => has(r, q.recipients))) &&
              (q.subject == null || has(h.subject, q.subject)) &&
              (q.fullText == null || has(h.subject, q.fullText) || has(h.author, q.fullText) || has(bodies.get(h.id), q.fullText)) &&
              (q.read == null || h.read === q.read) &&
              (q.flagged == null || h.flagged === q.flagged) &&
              (q.tags == null || Object.keys(q.tags.tags || {}).every((t) => h.tags.includes(t))) &&
              (q.attachment == null || (attachments.get(h.id) || []).length > 0 === q.attachment),
          )
          .sort((a, b) => a.date - b.date);
        if (q.returnMessageListId) {
          const listId = `list-${nextList++}`;
          lists.set(listId, { items: all, per: q.messagesPerPage || 100, root, hang });
          return listId;
        }
        pagesByQuery.set(root, 1);
        return page(all, q.messagesPerPage || 100, q.emptyFirstPage, root);
      },
      continueList: async (listId) => {
        calls.continueList.push(listId);
        const rest = lists.get(listId);
        if (!rest) throw new Error(`No message list for id ${listId}`);
        pagesByQuery.set(rest.root, (pagesByQuery.get(rest.root) || 0) + 1);
        if (rest.hang) return new Promise(() => {});
        lists.delete(listId);
        return page(rest.items, rest.per, false, rest.root);
      },
      tags: {
        list: async () => [
          { key: "$label1", tag: "Important", color: "#FF0000", ordinal: "" },
          { key: "$label4", tag: "To Do", color: "#3333FF", ordinal: "" },
        ],
      },
      abortList: async (listId) => {
        calls.abortList.push(listId);
        lists.delete(listId);
      },
      listAttachments: async (id) => {
        calls.listAttachments.push(id);
        if (!store.has(id)) throw new Error(`Message not found: ${id}.`);
        return (attachments.get(id) || []).map(({ content, ...a }) => clone(a));
      },
      // getAttachmentFile returns a File of the attachment's `content`
      // (string or Uint8Array; empty when not given).
      getAttachmentFile: async (id, partName) => {
        calls.getAttachmentFile.push([id, partName]);
        if (!store.has(id)) throw new Error(`Message not found: ${id}.`);
        const a = (attachments.get(id) || []).find((x) => x.partName === partName);
        if (!a) throw new Error(`Part not found: ${partName}`);
        return new File([a.content ?? ""], a.name, { type: a.contentType });
      },
      // getFull builds a MessagePart tree: text/plain from `body`,
      // text/html from `html` (multipart/alternative when both), then the
      // attachments. Headers are lower-case names with lists of values.
      getFull: async (id) => {
        calls.getFull.push(id);
        const h = store.get(id);
        if (!h) throw new Error(`Message not found: ${id}.`);
        const text = bodies.has(id) ? { contentType: "text/plain", partName: "1.1", body: bodies.get(id), size: bodies.get(id).length } : null;
        const html = htmlBodies.has(id) ? { contentType: "text/html", partName: "1.2", body: htmlBodies.get(id), size: htmlBodies.get(id).length } : null;
        const bodyPart = text && html ? { contentType: "multipart/alternative", partName: "1", parts: [text, html] } : text || html;
        const atts = (attachments.get(id) || []).map(({ content, ...a }) => ({ ...clone(a), headers: {} }));
        const headers = {
          "message-id": [`<${h.headerMessageId}>`],
          from: [h.author],
          subject: [h.subject],
          ...clone(extraHeaders.get(id) || {}),
        };
        const parts = [bodyPart, ...atts].filter(Boolean);
        return { contentType: "message/rfc822", partName: "", headers, size: h.size, parts: [{ contentType: "multipart/mixed", partName: "1", parts }] };
      },
      // getRaw builds a small RFC 5322 source from the header and side data;
      // a File (Blob) unless data_format is "BinaryString".
      getRaw: async (id, opts = {}) => {
        calls.getRaw.push(id);
        const h = store.get(id);
        if (!h) throw new Error(`Message not found: ${id}.`);
        const r = refs.get(id) || {};
        const lines = [`Message-ID: <${h.headerMessageId}>`, `From: ${h.author}`, `Subject: ${h.subject}`];
        if (r.inReplyTo) lines.push(`In-Reply-To: <${r.inReplyTo}>`);
        if (r.references && r.references.length) lines.push(`References: ${r.references.map((x) => `<${x}>`).join("\r\n ")}`);
        const raw = lines.join("\r\n") + "\r\n\r\n" + (bodies.get(id) || "");
        return opts.data_format === "BinaryString" ? raw : new Blob([raw]);
      },
    },
    addressBooks: {
      list: async () => books.map(({ id, name, remote = false }) => ({ id, name, type: "addressBook", remote })),
      contacts: {
        list: async (parentId) => {
          const b = books.find((x) => x.id === parentId);
          if (!b) throw new Error(`Address book not found: ${parentId}`);
          return b.contacts.map((vCard, i) => ({ id: `${b.id}-${i}`, parentId: b.id, type: "contact", vCard }));
        },
        // query matches every space-separated term, case-insensitively,
        // against the whole vCard (Thunderbird matches name and email fields).
        query: async (q = {}) => {
          calls.contactsQuery.push(q);
          const terms = String(q.searchString || "").toLowerCase().split(/\s+/).filter(Boolean);
          const out = [];
          for (const b of books) {
            if (q.parentId && b.id !== q.parentId) continue;
            if (q.includeRemote === false && b.remote) continue;
            b.contacts.forEach((vCard, i) => {
              if (terms.every((t) => vCard.toLowerCase().includes(t))) out.push({ id: `${b.id}-${i}`, parentId: b.id, type: "contact", vCard });
            });
          }
          return out;
        },
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        actionState.badgeText = text;
      },
      setTitle: async ({ title }) => {
        actionState.title = title;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        actionState.badgeColor = color;
      },
      onClicked: event(),
    },
    tabs: {
      create: async (props) => {
        tabs.push(props);
        return { id: tabs.length, ...props };
      },
    },
    permissions: {
      contains: async ({ permissions = [] }) => permissions.every((p) => perms.has(p)),
      onAdded: event(),
      onRemoved: event(),
    },
  };

  function page(items, per, emptyFirst = false, root = -1) {
    const take = emptyFirst ? [] : items.slice(0, per);
    const rest = emptyFirst ? items : items.slice(per);
    const out = { id: null, messages: take.map(clone) };
    if (rest.length > 0 || emptyFirst) {
      const listId = `list-${nextList++}`;
      lists.set(listId, { items: rest, per, root });
      out.id = listId;
    }
    return out;
  }

  const mock = {
    messenger,
    ports,
    tabs,
    actionState,
    calls,
    behaviour,
    store,
    local,
    lastPort: () => ports.at(-1),
    folder: (accountId, path) => clone(folderList.find((f) => f.accountId === accountId && f.path === path)),
    addMessage(accountId, path, extra = {}) {
      const f = folderList.find((x) => x.accountId === accountId && x.path === path);
      if (!f) throw new Error(`no folder ${accountId} ${path}`);
      const id = nextId++;
      const { body, html, headers, attachments: atts, references, inReplyTo, ...rest } = extra;
      const h = header(id, { ...f }, rest);
      store.set(id, h);
      if (body !== undefined) bodies.set(id, body);
      if (html !== undefined) htmlBodies.set(id, html);
      if (headers !== undefined) extraHeaders.set(id, headers);
      if (atts !== undefined) attachments.set(id, atts);
      if (references !== undefined || inReplyTo !== undefined) refs.set(id, { references, inReplyTo });
      return clone(h);
    },
    removeMessage(id) {
      store.delete(id);
    },
    // restart simulates a Thunderbird restart: numeric ids are reassigned,
    // so an old numeric id points at a different message or none.
    restart() {
      const ids = [...store.keys()];
      const hs = [...store.values()];
      store.clear();
      hs.forEach((h, i) => {
        const id = ids[(i + 1) % ids.length];
        store.set(id, { ...h, id });
      });
    },
    grant(p) {
      perms.add(p);
      messenger.permissions.onAdded.fire({ permissions: [p], origins: [] });
    },
    revoke(p) {
      perms.delete(p);
      messenger.permissions.onRemoved.fire({ permissions: [p], origins: [] });
    },
    openLists: () => [...lists.keys()],
    pagesPerQuery: () => [...pagesByQuery.values()],
  };
  return mock;
}

// install sets the global `messenger` (and `browser`) to a fresh mock.
export function install(opts) {
  const mock = createMessenger(opts);
  globalThis.messenger = mock.messenger;
  globalThis.browser = mock.messenger;
  return mock;
}

// fetchFrom returns a fetch stub serving the given package files, and
// rejecting (as Thunderbird does) for files not in the package.
export function fetchFrom(files = {}) {
  return async (url) => {
    const name = String(url).replace(/^moz-extension:\/\/[^/]+\//, "");
    if (!(name in files)) throw new TypeError("NetworkError when attempting to fetch resource.");
    return { ok: true, status: 200, json: async () => structuredClone(files[name]) };
  };
}
