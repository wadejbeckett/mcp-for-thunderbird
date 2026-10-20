/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Toolbar popup: the state line, a Pause or Resume button, the last 10
// requests and a link to the options page.

import { byId, showState, showLog, realDeps, inPage } from "./dom.js";

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
