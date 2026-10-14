; GitVolt's NSIS installer: per user, no elevation, into %LOCALAPPDATA%\Programs\GitVolt.
; scripts/package-windows.ps1 builds it from the staged folder and passes every define below.
; Silent: `GitVolt_<version>_x64-setup.exe /S [/D=<folder>]` (/D last, unquoted); uninstall with
; `"<folder>\uninstall.exe" /S`. Settings and repositories' data in %APPDATA% and %LOCALAPPDATA%
; stay on uninstall.

!ifndef VERSION | VERSION_NUMERIC | PUBLISHER | COPYRIGHT | STAGE | UNINSTALL_LIST | ICON | OUTFILE | ESTIMATED_SIZE_KB
  !error "run scripts/package-windows.ps1 (just package-windows), which defines the build's values"
!endif

!define APP "GitVolt"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
; GitBolt, the app's name before 0.7.0: its per-user install is removed.
!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GitBolt"

Unicode true
ManifestDPIAware true
; bzip2, not LZMA: NSIS's LZMA decoder, which would go into the installer, is under the CPL, a
; copyleft license. bzip2's is permissive, and its installer is 8% smaller than zlib's.
SetCompressor /SOLID bzip2
RequestExecutionLevel user
Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
; An earlier install's folder, so an update replaces it.
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION_NUMERIC}"
VIFileVersion "${VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"

; The signing hook (GITVOLT_SIGN_COMMAND): the uninstaller is written while the installer is
; built, so it's signed here; the script signs the installer itself afterwards.
!ifdef SIGN_COMMAND
  !uninstfinalize '${SIGN_COMMAND} "%1"' = 0
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\GitVolt.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; GitBolt's install goes: its own uninstaller, silently and without /KEEPREG, removes its files,
  ; Start menu shortcut, Settings > Apps entry and "Open in GitBolt" verbs. In place (_?=), so it
  ; can't delete itself: that and the then-empty folder go here. Settings and data stay: GitVolt
  ; moves them on its first start. A running GitBolt locks its files (and holds its data folder),
  ; so it must be closed first; a failed uninstaller leaves the old install as it was.
  ReadRegStr $1 HKCU "${LEGACY_UNINSTALL_KEY}" "InstallLocation"
  StrCmp $1 "" 0 +3
    DetailPrint "No GitBolt install to replace."
    Goto legacy_done
  IfFileExists "$1\uninstall.exe" +3 0
    DetailPrint "GitBolt's uninstaller isn't in $1: its install is left as it was."
    Goto legacy_done
  StrCpy $3 0
  legacy_probe:
  IfFileExists "$1\GitBolt.exe" 0 legacy_run
  ClearErrors
  FileOpen $2 "$1\GitBolt.exe" a
  IfErrors legacy_busy
  FileClose $2
  Goto legacy_run
  legacy_busy:
    ; An in-app update starts this installer, then quits the app: give it 10 s to exit first.
    IntOp $3 $3 + 1
    IntCmp $3 20 legacy_ask 0 legacy_ask
    Sleep 500
    Goto legacy_probe
  legacy_ask:
    IfSilent legacy_abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "GitBolt is running. Close it, then click Retry." IDRETRY legacy_probe
  legacy_abort:
    DetailPrint "GitBolt is running: close it and install again."
    SetErrorLevel 2
    Abort
  legacy_run:
  ExecWait '"$1\uninstall.exe" /S _?=$1' $2
  IntCmp $2 0 0 legacy_failed legacy_failed
    Delete "$1\uninstall.exe"
    RMDir "$1"
    Goto legacy_done
  legacy_failed:
    DetailPrint "GitBolt's uninstaller exited with $2: its install is left as it was."
  legacy_done:

  ; An update: the earlier version's uninstaller removes its own files first (in place, and
  ; waiting for it), so no file the new version dropped stays behind. A running GitVolt locks its
  ; files, so it must be closed first.
  IfFileExists "$INSTDIR\uninstall.exe" 0 update_done
  StrCpy $3 0
  update_probe:
  IfFileExists "$INSTDIR\GitVolt.exe" 0 update_run
  ClearErrors
  FileOpen $2 "$INSTDIR\GitVolt.exe" a
  IfErrors update_busy
  FileClose $2
  Goto update_run
  update_busy:
    ; An in-app update starts this installer, then quits the app: give it 10 s to exit first.
    IntOp $3 $3 + 1
    IntCmp $3 20 update_ask 0 update_ask
    Sleep 500
    Goto update_probe
  update_ask:
    IfSilent update_abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP} is running. Close it, then click Retry." IDRETRY update_probe
  update_abort:
    DetailPrint "${APP} is running: close it and install again."
    SetErrorLevel 2
    Abort
  update_run:
  ExecWait '"$INSTDIR\uninstall.exe" /S /KEEPREG _?=$INSTDIR'
  update_done:

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; How GitVolt was installed, beside GitVolt.exe: its update check offers this installer.
  FileOpen $0 "$INSTDIR\install-kind" w
  FileWrite $0 "nsis$\r$\n"
  FileClose $0

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\GitVolt.exe"

  ; Settings > Apps lists it, with its uninstaller.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\GitVolt.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE_KB}

  ; "Open in GitVolt" on a folder, and on a folder's background, in File Explorer (Windows 11
  ; lists it under "Show more options"). The app opens the folder it's given.
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}" "" "Open in ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}" "Icon" '"$INSTDIR\GitVolt.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}\command" "" '"$INSTDIR\GitVolt.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}" "" "Open in ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}" "Icon" '"$INSTDIR\GitVolt.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}\command" "" '"$INSTDIR\GitVolt.exe" "%V"'
SectionEnd

Section "Uninstall"
  ; Exactly the files installed (generated from the staged folder), then the folder if empty:
  ; never a recursive delete of a folder the user chose.
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\install-kind"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; /KEEPREG: the installer of a newer version runs this first, and keeps its entries.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEPREG" $R1
  IfErrors 0 done
    Delete "$SMPROGRAMS\${APP}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\${APP}"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${APP}"
  done:
SectionEnd
