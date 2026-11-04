@echo off
rem Copyright (C) 2026 Wade J. Beckett
rem This file is part of MCP for Thunderbird, free software: you can redistribute
rem it and/or modify it under the terms of the GNU General Public License as
rem published by the Free Software Foundation, either version 3 of the License, or
rem (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
rem SPDX-License-Identifier: GPL-3.0-or-later
rem
rem tb.sh for Windows: what the e2e tests run as MFT_E2E_TB.
if "%MFT_E2E_PYTHON%"=="" set MFT_E2E_PYTHON=python
"%MFT_E2E_PYTHON%" "%~dp0e2e.py" tb %*
