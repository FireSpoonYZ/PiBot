!include "${__FILEDIR__}\..\build\icons\shell-icon.nsh"

; Host 登录任务化安装：perMachine 安装（默认 Program Files，可自定义安装目录），普通权限客户端保持不变。
; 绑定数据仍在 %LOCALAPPDATA%\e-launcher\host-service（用户目录，不在安装目录）。

Var /GLOBAL EHostAppData
Var /GLOBAL EHostHome
Var /GLOBAL EHostLock
Var /GLOBAL EHostStopReq
Var /GLOBAL EHostRunning
Var /GLOBAL EHostWait
Var /GLOBAL EHostFailed
Var /GLOBAL EHostFile
Var /GLOBAL EOldInstallDir

; 改名前的旧 Windows productName：installer.nsi 已把 UNINSTKEY/MANUPRODUCTKEY
; 固定为旧名（升级身份不变，新版本共用旧卸载键），此处仅清理旧快捷方式与
; 旧 HKCU 用户目录安装残留；旧快捷方式删除按 current/all 两上下文执行。
!define E_LAUNCHER_LEGACY_PRODUCT "e-助手"
!define E_LAUNCHER_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\e-助手"

; perMachine 安装时 SetShellVarContext 为 all，需临时切回 current 才能拿到
; 交互登录用户自己的 LOCALAPPDATA（同用户提权下 current == 安装用户）。
!macro E_LAUNCHER_HOST_DETECT_HOME
  SetShellVarContext current
  StrCpy $EHostAppData "$LOCALAPPDATA"
  StrCpy $EHostHome "$LOCALAPPDATA\e-launcher\host-service"
  StrCpy $EHostLock "$EHostHome\launcher.lock"
  StrCpy $EHostStopReq "$EHostHome\stop.request"
  !insertmacro SetContext
!macroend

; OUT 参数 := "1" 当 supervisor 仍持有 launcher.lock，否则 "0"。
; 用与 fs2 try_lock_exclusive 相同的 LockFileEx 互斥字节锁探测，不需要启动任何二进制。
!macro E_LAUNCHER_HOST_PROBE_RUNNING OUT
  StrCpy ${OUT} "0"
  ${If} ${FileExists} "$EHostLock"
    System::Call 'kernel32::CreateFileW(w "$EHostLock", i 0x80000000, i 3, p 0, i 3, i 0x80, p 0) p .R7'
    ${If} $R7 == -1
      StrCpy ${OUT} "1"
    ${Else}
      System::Alloc 24
      Pop $R8
      System::Call 'kernel32::RtlZeroMemory(p R8, i 24)'
      System::Call 'kernel32::LockFileEx(p R7, i 3, i 0, i 1, i 0, p R8) i .R9'
      ${If} $R9 == 0
        StrCpy ${OUT} "1"
      ${Else}
        System::Call 'kernel32::UnlockFileEx(p R7, i 0, i 1, i 0, p R8)'
      ${EndIf}
      System::Free $R8
      System::Call 'kernel32::CloseHandle(p R7)'
    ${EndIf}
  ${EndIf}
!macroend

; OUT 参数 := "1" 表示优雅停止失败。写入 stop.request（launcher stop 的同一路径），
; 等待 supervisor 自行清理退出；外层等待 85s 必须大于 launcher 内层停止预算(约45s)
; 与 launcher stop 自身外层(约70s)，避免提前打断正在进行的 Node 清理。
!macro E_LAUNCHER_HOST_STOP OUT
  StrCpy ${OUT} "0"
  !insertmacro E_LAUNCHER_HOST_PROBE_RUNNING $EHostRunning
  ${If} $EHostRunning == "1"
    FileOpen $EHostFile "$EHostStopReq" w
    ${If} $EHostFile != ""
      FileWrite $EHostFile "stop$\n"
      FileClose $EHostFile
    ${EndIf}
    StrCpy $EHostWait 0
    ${Do}
      Sleep 1000
      IntOp $EHostWait $EHostWait + 1
      !insertmacro E_LAUNCHER_HOST_PROBE_RUNNING $EHostRunning
      ${If} $EHostRunning == "0"
        ${ExitDo}
      ${EndIf}
      ${If} $EHostWait >= 85
        ${ExitDo}
      ${EndIf}
    ${Loop}
    ${If} $EHostRunning == "1"
      StrCpy ${OUT} "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\icons\shell-icon-*.ico"
  !insertmacro E_LAUNCHER_HOST_DETECT_HOME
  ; 优雅停止运行中的 Host（含旧用户目录安装的迁移场景），失败阻止覆盖写入。
  !insertmacro E_LAUNCHER_HOST_STOP $EHostFailed
  ${If} $EHostFailed == "1"
    MessageBox MB_ICONSTOP "无法停止正在运行的 Host，请关闭后重试安装。"
    Abort "host still running"
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
  ; 旧品牌快捷方式清理：旧包可能按 perUser 或 perMachine 安装，两个上下文都只
  ; 删除已知旧名，新快捷方式（pibot.lnk）不受影响。
  SetShellVarContext current
  Delete "$SMPROGRAMS\${E_LAUNCHER_LEGACY_PRODUCT}.lnk"
  Delete "$DESKTOP\${E_LAUNCHER_LEGACY_PRODUCT}.lnk"
  Delete "$SMPROGRAMS\e-launcher-desktop.lnk"
  Delete "$DESKTOP\e-launcher-desktop.lnk"
  SetShellVarContext all
  Delete "$SMPROGRAMS\${E_LAUNCHER_LEGACY_PRODUCT}.lnk"
  Delete "$DESKTOP\${E_LAUNCHER_LEGACY_PRODUCT}.lnk"
  Delete "$SMPROGRAMS\e-launcher-desktop.lnk"
  Delete "$DESKTOP\e-launcher-desktop.lnk"
  !insertmacro SetContext
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icons\${E_LAUNCHER_SHELL_ICON}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; 为本交互登录用户注册 Host 登录任务（未配对时 trigger 登记为禁用、不自动运行；
  ; 已配对时由下方安装步骤启用并启动）。提权结果必须上报，不再丢弃退出码。
  ${If} ${FileExists} "$INSTDIR\host-runtime\native\shower-windows.exe"
    nsExec::Exec '"$INSTDIR\host-runtime\native\shower-windows.exe" host-task install'
    Pop $EHostFailed
    ${If} $EHostFailed != 0
      MessageBox MB_ICONSTOP "注册 Host 登录任务失败（退出码 $EHostFailed）。"
      SetErrorLevel 1
      Abort "host task install failed"
    ${Else}
      ; 任务注册成功后才清理 currentUser 旧安装：删除用户目录下的旧程序与残留卸载入口。
      ; 只接受完全等于 <用户LOCALAPPDATA>\<ProductName> 的旧安装路径，不执行其中任何二进制；
      ; helper 已移除旧 HKCU Run，这里兜底同一用户的残留值。
      ReadRegStr $EOldInstallDir HKCU "${E_LAUNCHER_LEGACY_UNINSTKEY}" "InstallLocation"
      ${If} $EOldInstallDir != ""
        StrCpy $R9 $EOldInstallDir 1
        ${If} $R9 == "$\""
          StrCpy $EOldInstallDir $EOldInstallDir -1
          StrCpy $EOldInstallDir $EOldInstallDir "" 1
        ${EndIf}
        ${If} $EOldInstallDir == "$EHostAppData\${E_LAUNCHER_LEGACY_PRODUCT}"
        ${AndIf} $EOldInstallDir != "$INSTDIR"
          RMDir /r "$EOldInstallDir"
          DeleteRegKey HKCU "${E_LAUNCHER_LEGACY_UNINSTKEY}"
        ${EndIf}
      ${EndIf}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "e-launcher-host"
      ; 已配对的 Host 在安装结束时启用自启动并立即运行。
      ${If} ${FileExists} "$EHostHome\config.json"
        nsExec::Exec '"$INSTDIR\host-runtime\native\shower-windows.exe" host-task enable'
        Pop $EHostFailed
        ${If} $EHostFailed != 0
          MessageBox MB_ICONSTOP "启用 Host 自启动失败（退出码 $EHostFailed）。"
          SetErrorLevel 1
          Abort "host task enable failed"
        ${EndIf}
        nsExec::Exec '"$INSTDIR\host-runtime\native\shower-windows.exe" host-task start'
        Pop $EHostFailed
        ${If} $EHostFailed != 0
          MessageBox MB_ICONSTOP "启动 Host 失败（退出码 $EHostFailed）。"
          SetErrorLevel 1
          Abort "host task start failed"
        ${EndIf}
        StrCpy $EHostWait 0
        ${Do}
          Sleep 1000
          IntOp $EHostWait $EHostWait + 1
          !insertmacro E_LAUNCHER_HOST_PROBE_RUNNING $EHostRunning
          ${If} $EHostRunning == "1"
          ${OrIf} $EHostWait >= 30
            ${ExitDo}
          ${EndIf}
        ${Loop}
        ${If} $EHostRunning != "1"
          MessageBox MB_ICONSTOP "Host 未能在安装结束前启动，请检查 Host 日志。"
          SetErrorLevel 1
          Abort "host did not start"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro E_LAUNCHER_HOST_DETECT_HOME
  ; 先优雅停止 Host，失败阻止删除文件并报告；配对数据保留在用户目录。
  !insertmacro E_LAUNCHER_HOST_STOP $EHostFailed
  ${If} $EHostFailed == "1"
    MessageBox MB_ICONSTOP "无法停止正在运行的 Host，请关闭后重试卸载。"
    Abort "host still running"
  ${EndIf}
  ${If} $UpdateMode <> 1
    ; 真正卸载（非升级路径）：删除本产品此用户的登录任务与兜底自启动项。
    ; 删任务失败必须阻止卸载——否则其 exe 被删而特权任务残留。
    ${If} ${FileExists} "$INSTDIR\host-runtime\native\shower-windows.exe"
      nsExec::Exec '"$INSTDIR\host-runtime\native\shower-windows.exe" host-task remove'
      Pop $EHostFailed
      ${If} $EHostFailed != 0
        MessageBox MB_ICONSTOP "删除 Host 登录任务失败（退出码 $EHostFailed），请重试卸载。"
        Abort "host task remove failed"
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "e-launcher-host"
  ${EndIf}
!macroend
