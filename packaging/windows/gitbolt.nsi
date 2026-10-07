; GitBolt's NSIS installer: per user, no elevation, into %LOCALAPPDATA%\Programs\GitBolt.
; scripts/package-windows.ps1 builds it from the staged folder and passes every define below.
; Silent: `GitBolt_<version>_x64-setup.exe /S [/D=<folder>]` (/D last, unquoted); uninstall with
; `"<folder>\uninstall.exe" /S`. Settings and repositories' data in %APPDATA% and %LOCALAPPDATA%
; stay on uninstall.

!ifndef VERSION | VERSION_NUMERIC | PUBLISHER | COPYRIGHT | STAGE | UNINSTALL_LIST | ICON | OUTFILE | ESTIMATED_SIZE_KB
  !error "run scripts/package-windows.ps1 (just package-windows), which defines the build's values"
!endif

!define APP "GitBolt"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

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

; The signing hook (GITBOLT_SIGN_COMMAND): the uninstaller is written while the installer is
; built, so it's signed here; the script signs the installer itself afterwards.
!ifdef SIGN_COMMAND
  !uninstfinalize '${SIGN_COMMAND} "%1"' = 0
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\GitBolt.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; An update: the earlier version's uninstaller removes its own files first (in place, and
  ; waiting for it), so no file the new version dropped stays behind.
  IfFileExists "$INSTDIR\uninstall.exe" 0 +2
    ExecWait '"$INSTDIR\uninstall.exe" /S /KEEPREG _?=$INSTDIR'

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\GitBolt.exe"

  ; Settings > Apps lists it, with its uninstaller.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\GitBolt.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE_KB}

  ; "Open in GitBolt" on a folder, and on a folder's background, in File Explorer (Windows 11
  ; lists it under "Show more options"). The app opens the folder it's given.
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}" "" "Open in ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}" "Icon" '"$INSTDIR\GitBolt.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP}\command" "" '"$INSTDIR\GitBolt.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}" "" "Open in ${APP}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}" "Icon" '"$INSTDIR\GitBolt.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP}\command" "" '"$INSTDIR\GitBolt.exe" "%V"'
SectionEnd

Section "Uninstall"
  ; Exactly the files installed (generated from the staged folder), then the folder if empty:
  ; never a recursive delete of a folder the user chose.
  !include "${UNINSTALL_LIST}"
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
