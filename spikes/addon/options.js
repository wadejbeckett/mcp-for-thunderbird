// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// THROWAWAY spike (Task 2): ask for the optional-only messages.send
// permission from a real click, and report the outcome to the background.
document.getElementById("req").addEventListener("click", async () => {
  const report = r => messenger.runtime.sendMessage({ kind: "permResult", ...r });
  report({ phase: "clicked" });
  try {
    const granted = await messenger.permissions.request({ permissions: ["messages.send"] });
    const all = await messenger.permissions.getAll();
    report({ phase: "done", granted, all });
  } catch (e) {
    report({ phase: "error", error: String(e) });
  }
});
messenger.runtime.sendMessage({ kind: "permResult", phase: "options-loaded" });
