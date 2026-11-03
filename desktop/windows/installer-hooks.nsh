!include "${__FILEDIR__}\..\build\icons\shell-icon.nsh"

; Bundled Host launcher (externalBin e-launcher-host.exe next to the main binary).
; Runs hidden via nsExec in the installing user's context (installMode currentUser);
; the exit code is discarded and $0 is preserved for the surrounding Tauri template.
!macro E_LAUNCHER_HOST_EXEC ARGS
  Push $0
  nsExec::Exec '"$INSTDIR\e-launcher-host.exe" ${ARGS}'
  Pop $0
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\icons\shell-icon-*.ico"
  ; Stop a running bundled Host so its launcher, Node sidecar and host-runtime files
  ; are not locked while being replaced (failure is ignored).
  ${If} ${FileExists} "$INSTDIR\e-launcher-host.exe"
    !insertmacro E_LAUNCHER_HOST_EXEC "stop"
  ${EndIf}
  ; Drop the previous host-runtime tree so stale node_modules files from an older
  ; version cannot shadow the freshly installed dependencies.
  ${If} "$INSTDIR" != ""
  ${AndIf} ${FileExists} "$INSTDIR\host-runtime\*.*"
    RMDir /r "$INSTDIR\host-runtime"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  ${If} $NoShortcutMode <> 1
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\${E_LAUNCHER_SHELL_ICON}" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\${E_LAUNCHER_SHELL_ICON}" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icons\${E_LAUNCHER_SHELL_ICON}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; Already paired (HOST_HOME config exists): re-register HKCU Run autostart for the
  ; new launcher path and start the bundled Host again.
  ${If} ${FileExists} "$LOCALAPPDATA\e-launcher\host-service\config.json"
  ${AndIf} ${FileExists} "$INSTDIR\e-launcher-host.exe"
    !insertmacro E_LAUNCHER_HOST_EXEC "enable"
    !insertmacro E_LAUNCHER_HOST_EXEC "start"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop the bundled Host and remove its HKCU Run autostart; pairing data under
  ; %LOCALAPPDATA%\e-launcher\host-service is kept.
  ${If} ${FileExists} "$INSTDIR\e-launcher-host.exe"
    !insertmacro E_LAUNCHER_HOST_EXEC "stop"
    !insertmacro E_LAUNCHER_HOST_EXEC "disable"
  ${EndIf}
!macroend
