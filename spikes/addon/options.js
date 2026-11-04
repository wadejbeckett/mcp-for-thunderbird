// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

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
