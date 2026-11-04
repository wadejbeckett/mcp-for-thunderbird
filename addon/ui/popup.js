/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Toolbar popup: the state line, notes on what to check in the options
// (excluded folders not found, accounts not enabled yet), a Pause or
// Resume button, the last 10 requests and a link to the options page.

import { byId, showState, showLog, realDeps, inPage } from "./dom.js";
import { stateNotes } from "./logic.js";

const RECENT = 10;

export async function initPopup(doc, { send, m }) {
  const stateEl = byId(doc, "state");
  const pauseBtn = byId(doc, "pause");
  let paused = false;

  async function refresh() {
    try {
      const s = await send({ type: "getState" });
      paused = s.paused;
      showState(doc, stateEl, s.state, s.error);
      const notes = stateNotes(s);
      byId(doc, "notes").replaceChildren(
        ...notes.map((n) => {
          const li = doc.createElement("li");
          li.textContent = n;
          return li;
        }),
      );
      byId(doc, "notes").hidden = notes.length === 0;
      pauseBtn.textContent = paused ? "Resume" : "Pause";
      pauseBtn.disabled = false;
      showLog(doc, byId(doc, "log"), byId(doc, "log-empty"), await send({ type: "listLog", limit: RECENT }));
    } catch {
      stateEl.textContent = "Not connected";
      stateEl.className = "state not-connected";
      pauseBtn.disabled = true;
    }
  }

  pauseBtn.addEventListener("click", async () => {
    try {
      await send({ type: "setPaused", paused: !paused });
    } catch {
      // refresh shows what is true
    }
    await refresh();
  });

  byId(doc, "open-options").addEventListener("click", async (ev) => {
    ev.preventDefault();
    await m.runtime.openOptionsPage();
    if (globalThis.window && globalThis.window.close) globalThis.window.close();
  });

  await refresh();
}

if (inPage()) initPopup(document, realDeps());
