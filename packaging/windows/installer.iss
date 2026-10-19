; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this
; file, You can obtain one at https://mozilla.org/MPL/2.0/.
;
; Inno Setup 6 script for the MCP for Thunderbird host on Windows. It
; installs per user (no administrator rights) to
; %LOCALAPPDATA%\Programs\MCP for Thunderbird, then runs
; `mcp-for-thunderbird.exe setup --native-only`, which writes the
; native-messaging manifest next to the program (a folder the user owns)
; and points HKCU\Software\Mozilla\NativeMessagingHosts\mcp_for_thunderbird
; at it. Uninstalling runs `setup --uninstall` first.
;
; Compiled on the CI Windows runner (Task 21), once per architecture:
;   iscc /DAppVersion=0.1.0 /DArch=amd64 ^
;        /DSourceDir=dist\host_windows_amd64_v1 /DDocDir=. ^
;        /DOutputDir=dist packaging\windows\installer.iss
; Arch is amd64 or arm64. SourceDir holds mcp-for-thunderbird.exe; DocDir
; holds LICENSE, NOTICE and README.md.

#ifndef AppVersion
  #error Define AppVersion, e.g. /DAppVersion=0.1.0
#endif
#ifndef Arch
  #error Define Arch as amd64 or arm64
#endif
#ifndef SourceDir
  #error Define SourceDir, the folder holding mcp-for-thunderbird.exe
#endif
#ifndef DocDir
  #define DocDir "."
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif

#if Arch == "amd64"
  #define Allowed "x64compatible"
#elif Arch == "arm64"
  #define Allowed "arm64"
#else
  #error Arch must be amd64 or arm64
#endif

#define AppName "MCP for Thunderbird"
#define ExeName "mcp-for-thunderbird.exe"

[Setup]
; AppId identifies the installation for upgrades and uninstall; never change it.
AppId={{761ACCC4-4085-4D9D-9A89-7911D531AE76}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Wade J. Beckett
AppPublisherURL=https://github.com/wadejbeckett/mcp-for-thunderbird
AppSupportURL=https://github.com/wadejbeckett/mcp-for-thunderbird/issues
AppUpdatesURL=https://github.com/wadejbeckett/mcp-for-thunderbird/releases
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
ArchitecturesAllowed={#Allowed}
ArchitecturesInstallIn64BitMode={#Allowed}
LicenseFile={#DocDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=mcp-for-thunderbird-{#AppVersion}-windows-{#Arch}-setup
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#ExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Thunderbird may have the host running; let Restart Manager close it.
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#SourceDir}\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DocDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DocDir}\NOTICE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#DocDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
; Removes the manifest, the registry key and this program's entries in AI apps.
Filename: "{app}\{#ExeName}"; Parameters: "setup --uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "Unregister"

[UninstallDelete]
; In case `setup --uninstall` could not run, the manifest still goes.
Type: files; Name: "{app}\mcp_for_thunderbird.json"

[Code]
// Registers the host with Thunderbird after the files are in place, and
// says so if registration fails ([Run] entries ignore exit codes).
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not Exec(ExpandConstant('{app}\{#ExeName}'), 'setup --native-only', '', SW_HIDE,
      ewWaitUntilTerminated, Code) or (Code <> 0) then
      SuppressibleMsgBox('{#AppName} could not register itself with Thunderbird. ' +
        'Open a command prompt in ' + ExpandConstant('{app}') +
        ' and run "{#ExeName} setup --native-only" to see why.',
        mbError, MB_OK, IDOK);
  end;
end;
