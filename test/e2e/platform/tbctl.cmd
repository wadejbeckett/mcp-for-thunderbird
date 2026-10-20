@echo off
rem This Source Code Form is subject to the terms of the Mozilla Public
rem License, v. 2.0. If a copy of the MPL was not distributed with this
rem file, You can obtain one at https://mozilla.org/MPL/2.0/.
rem
rem tb.sh for Windows: what the e2e tests run as MFT_E2E_TB.
if "%MFT_E2E_PYTHON%"=="" set MFT_E2E_PYTHON=python
"%MFT_E2E_PYTHON%" "%~dp0e2e.py" tb %*
