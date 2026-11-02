!include "${__FILEDIR__}\..\build\icons\shell-icon.nsh"

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\icons\shell-icon-*.ico"
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
!macroend
