/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mock `messenger` API for the add-on tests.
// Derived from the vitalio-sh "thunderbird-cli" extension test mocks
// (test/extension.test.mjs, seed commit 465613d), MIT licence, see NOTICE.
// Extended with native ports, storage.local and onChanged, accounts,
// folders, paged messages.query, action and permissions.

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
// {id, name, type, folders: [path, ...]}.
export function createMessenger({ accounts = [], manifest = { version: "0.0.0", manifest_version: 3 }, granted = [] } = {}) {
  const local = new Map();
  const onChanged = event();
  const ports = [];
  const tabs = [];
  const actionState = { badgeText: "", title: "", badgeColor: null };
  const perms = new Set(granted);

  const folderList = [];
  for (const a of accounts) {
    for (const path of a.folders || []) {
      folderList.push({ id: `${a.id}:/${path}`, accountId: a.id, path, name: path.split("/").pop() });
    }
  }

  // messages: numeric id -> header
  const store = new Map();
  let nextId = 1;
  const calls = { query: [], abortList: [], continueList: [], get: [] };
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
      list: async () => accounts.map(({ id, name, type }) => ({ id, name, type })),
      get: async (id) => {
        const a = accounts.find((x) => x.id === id);
        return a ? { id: a.id, name: a.name, type: a.type } : null;
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
    },
    messages: {
      get: async (id) => {
        calls.get.push(id);
        if (!store.has(id)) throw new Error(`Message not found: ${id}.`);
        return clone(store.get(id));
      },
      // query honours accountId, folderId and headerMessageId. With
      // messagesPerPage it pages the results through continueList.
      query: async (q = {}) => {
        calls.query.push(q);
        const all = [...store.values()].filter(
          (h) =>
            (q.accountId == null || h.folder.accountId === q.accountId) &&
            (q.folderId == null || h.folder.id === q.folderId) &&
            (q.headerMessageId == null || h.headerMessageId === q.headerMessageId),
        );
        return page(all, q.messagesPerPage || 100, q.emptyFirstPage);
      },
      continueList: async (listId) => {
        calls.continueList.push(listId);
        const rest = lists.get(listId);
        if (!rest) throw new Error(`No message list for id ${listId}`);
        lists.delete(listId);
        return page(rest.items, rest.per);
      },
      abortList: async (listId) => {
        calls.abortList.push(listId);
        lists.delete(listId);
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

  function page(items, per, emptyFirst = false) {
    const take = emptyFirst ? [] : items.slice(0, per);
    const rest = emptyFirst ? items : items.slice(per);
    const out = { id: null, messages: take.map(clone) };
    if (rest.length > 0 || emptyFirst) {
      const listId = `list-${nextList++}`;
      lists.set(listId, { items: rest, per });
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
    store,
    local,
    lastPort: () => ports.at(-1),
    folder: (accountId, path) => clone(folderList.find((f) => f.accountId === accountId && f.path === path)),
    addMessage(accountId, path, extra = {}) {
      const f = folderList.find((x) => x.accountId === accountId && x.path === path);
      if (!f) throw new Error(`no folder ${accountId} ${path}`);
      const id = nextId++;
      const h = header(id, { ...f }, extra);
      store.set(id, h);
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
