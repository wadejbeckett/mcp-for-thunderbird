/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// First-run setup: accounts, level, AI apps, finish.

import { save } from "../src/settings.js";
import { byId, checkboxRow, messageOf, realDeps, inPage } from "./dom.js";
import { levelToGroups } from "./logic.js";

export async function initSetup(doc, { send, m }) {
  const accountsEl = byId(doc, "accounts");
  const clientsEl = byId(doc, "clients");
  const clientsStatus = byId(doc, "clients-status");
  const detectBtn = byId(doc, "detect");
  const configureBtn = byId(doc, "configure");

  // 1. Accounts, all unticked.
  const accounts = (await m.accounts.list(false)) || [];
  const accountBoxes = [];
  for (const a of accounts) {
    const { label, input } = checkboxRow(doc, a.name, { "data-id": a.id }, false);
    accountsEl.append(label);
    accountBoxes.push(input);
  }
  byId(doc, "accounts-empty").hidden = accounts.length > 0;

  // The page preselects "Read and organise" in its markup; read it into
  // the property so the choice below always sees the same state.
  for (const r of doc.querySelectorAll("#levels input")) r.checked = r.hasAttribute("checked");

  const level = () => {
    const chosen = [...doc.querySelectorAll("#levels input")].find((r) => r.checked);
    return chosen ? chosen.value : "read_organise";
  };

  // 3. AI apps.
  detectBtn.addEventListener("click", async () => {
    clientsStatus.textContent = "Looking for AI apps...";
    try {
      const found = (await send({ type: "detectClients" })).filter((c) => c.found);
      clientsEl.replaceChildren();
      for (const c of found) {
        const { label, input } = checkboxRow(doc, c.name, { "data-name": c.name }, !c.configured, c.configured ? "Already set up." : "");
        clientsEl.append(label);
        void input;
      }
      clientsEl.hidden = found.length === 0;
      configureBtn.hidden = found.length === 0;
      clientsStatus.textContent = found.length === 0 ? "No AI apps were found on this computer." : "Tick the apps to set up.";
    } catch (e) {
      clientsStatus.textContent = messageOf(e, "MCP for Thunderbird is not connected to its host program.");
    }
  });

  configureBtn.addEventListener("click", async () => {
    const names = [...doc.querySelectorAll("#clients input")].filter((i) => i.checked).map((i) => i.getAttribute("data-name"));
    if (names.length === 0) {
      clientsStatus.textContent = "Tick at least one app.";
      return;
    }
    clientsStatus.textContent = "Setting up...";
    try {
      const result = await send({ type: "configureClients", clients: names });
      const bad = result.filter((c) => c.error);
      const good = result.filter((c) => !c.error && c.configured);
      clientsStatus.textContent = [
        good.length ? `Set up: ${good.map((c) => c.name).join(", ")}.` : "",
        ...bad.map((c) => `${c.name} could not be set up: ${c.error}`),
      ]
        .filter(Boolean)
        .join(" ");
    } catch (e) {
      clientsStatus.textContent = messageOf(e, "MCP for Thunderbird is not connected to its host program.");
    }
  });

  // 4. Finish.
  byId(doc, "finish").addEventListener("click", async () => {
    const status = byId(doc, "finish-status");
    try {
      const map = {};
      for (const b of accountBoxes) map[b.getAttribute("data-id")] = b.checked;
      await save({ accounts: map, groups: levelToGroups(level()), setupDone: true });
      const none = !accountBoxes.some((b) => b.checked);
      status.textContent = none
        ? "Setup finished. No account is switched on yet, so AI apps cannot see any mail. Switch one on in the add-on options."
        : "Setup finished. You can change these choices any time in the add-on options.";
    } catch {
      status.textContent = "Your choices could not be saved. Try again.";
    }
  });
}

if (inPage()) initSetup(document, realDeps());
