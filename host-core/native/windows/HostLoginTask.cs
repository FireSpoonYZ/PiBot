using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32;

namespace ELauncher.Shower
{
    /// <summary>
    /// 每用户 Host 登录计划任务 "ELauncherHost-<userSid>" 的安装与日常控制。
    /// 任务的 action 固定为同安装目录的 pibot-host.exe run（绝不接受外部传入的
    /// exe/参数），只允许管理员保护目录内的二进制；安装/启停/删除只作用于本交互会话
    /// 用户自己的任务，管理员代装给别的用户一律拒绝。
    ///
    /// 自启动开关落在登录 trigger 的 Enabled 上，任务本体 Enabled 恒为 true：
    /// 用户关闭登录自启动后仍可用 start 手动 Run。任务 ACL 只给所属用户读/运行；
    /// 写任务的子命令经受控 runas（重启自身 exe、固定参数、固定退出码映射回错误码，
    /// 无结果文件、无任意路径写入）；start/status 一律不提权。
    /// stdout 输出单行 JSON：{installed,autostart}/{status:'started'} 或
    /// {error:{code,message}} 并以非零退出码失败。
    /// </summary>
    internal static class HostLoginTask
    {
        private const string TaskNamePrefix = "ELauncherHost-";
        private const string LauncherExeName = "pibot-host.exe";
        private const string NodeExeName = "pibot-node.exe";
        private const string RuntimeDirName = "host-runtime";
        private const string HostHomeRelative = @"e-launcher\host-service";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "e-launcher-host";
        private const int ElevationWaitMilliseconds = 180000;

        private const string ErrCancelled = "AUTHORIZATION_CANCELLED";
        private const string ErrUserMismatch = "INSTALL_USER_MISMATCH";
        private const string ErrAdminRequired = "ADMIN_ACCOUNT_REQUIRED";
        private const string ErrNotProtected = "INSTALLATION_NOT_PROTECTED";
        private const string ErrTaskMissing = "TASK_NOT_INSTALLED";
        private const string ErrLauncherMissing = "LAUNCHER_NOT_FOUND";
        private const string ErrSessionUnknown = "SESSION_USER_UNKNOWN";
        private const string ErrTaskForeign = "TASK_FOREIGN";

        // TASK_TRIGGER_LOGON=9（7 是 REGISTRATION）：本任务唯一的 trigger 类型，其 Enabled 即 autostart。
        private const int TriggerTypeLogon = 9;

        private sealed class TaskFault : Exception
        {
            internal readonly string Code;

            internal TaskFault(string code, string message)
                : base(message)
            {
                Code = code;
            }
        }

        /// <summary>提权子进程的错误以固定退出码回传，父进程按同一张表还原 code；stdout 始终只出固定 JSON。</summary>
        private static int FaultExitCode(string code)
        {
            switch (code)
            {
                case ErrUserMismatch: return 10;
                case ErrAdminRequired: return 11;
                case ErrNotProtected: return 12;
                case ErrTaskMissing: return 13;
                case ErrLauncherMissing: return 14;
                case ErrSessionUnknown: return 15;
                case ErrTaskForeign: return 16;
                case "INVALID_ARGUMENT": return 2;
                default: return 1;
            }
        }

        private static string FaultCodeForExit(int exitCode)
        {
            switch (exitCode)
            {
                case 10: return ErrUserMismatch;
                case 11: return ErrAdminRequired;
                case 12: return ErrNotProtected;
                case 13: return ErrTaskMissing;
                case 14: return ErrLauncherMissing;
                case 15: return ErrSessionUnknown;
                case 16: return ErrTaskForeign;
                case 2: return "INVALID_ARGUMENT";
                default: return "INTERNAL";
            }
        }

        private static string FaultMessageForExit(int exitCode)
        {
            switch (exitCode)
            {
                case 10: return "提权账号与当前交互登录用户不一致，拒绝操作";
                case 11: return "需要本机管理员账号完成该操作";
                case 12: return "安装目录/二进制允许普通用户写入，拒绝登记高权限任务";
                case 13: return "Host 登录任务尚未安装";
                case 14: return "找不到固定 launcher 二进制";
                case 15: return "无法确定当前交互登录用户";
                case 16: return "任务定义不是本产品固定内容，请重新安装修复";
                case 2: return "参数无效";
                default: return "提权操作失败(退出码 " + exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")";
            }
        }

        internal static int Run(string[] args)
        {
            string op = args != null && args.Length > 0 ? args[0] : null;
            bool relaunched = false;
            if (op != null)
            {
                for (int i = 1; i < args.Length; i++)
                {
                    if (string.Equals(args[i], "--elevated", StringComparison.Ordinal))
                    {
                        relaunched = true;
                    }
                    else
                    {
                        op = null;
                        break;
                    }
                }
            }
            if (!IsKnown(op))
            {
                HostLog.Warn("usage: shower-windows host-task <install|enable|disable|start|status|remove>");
                return 2;
            }

            bool needsAdmin = !string.Equals(op, "status", StringComparison.Ordinal)
                && !string.Equals(op, "start", StringComparison.Ordinal);
            if (needsAdmin && !relaunched && !BootstrapNative.IsElevated())
            {
                // 受控提权：仅重启自身 exe、固定参数；错误走固定退出码，成功回读 Status。
                return RelayElevated(op);
            }

            try
            {
                Emit(Execute(op, relaunched));
                return 0;
            }
            catch (TaskFault fault)
            {
                Emit(ErrorResult(fault.Code, fault.Message));
                return FaultExitCode(fault.Code);
            }
            catch (Exception ex)
            {
                Emit(ErrorResult("INTERNAL", ex.GetType().Name + ": " + ex.Message));
                return 1;
            }
        }

        private static bool IsKnown(string op)
        {
            return string.Equals(op, "install", StringComparison.Ordinal)
                || string.Equals(op, "enable", StringComparison.Ordinal)
                || string.Equals(op, "disable", StringComparison.Ordinal)
                || string.Equals(op, "start", StringComparison.Ordinal)
                || string.Equals(op, "status", StringComparison.Ordinal)
                || string.Equals(op, "remove", StringComparison.Ordinal);
        }

        private static Dictionary<string, object> Execute(string op, bool relaunched)
        {
            string sessionSid = ResolveSessionUserSid();
            switch (op)
            {
                case "status":
                    return Status(sessionSid);
                case "start":
                    return Start(sessionSid);
            }
            // install/enable/disable/remove：必须是本交互会话用户自己以管理员身份操作，
            // 拒绝标准用户借其它管理员凭据安装/改写自己的任务。
            RequireElevatedSameUser(sessionSid, relaunched);
            switch (op)
            {
                case "install":
                    return Install(sessionSid);
                case "enable":
                    return SetTrigger(sessionSid, true);
                case "disable":
                    return SetTrigger(sessionSid, false);
                default:
                    return Remove(sessionSid);
            }
        }

        // ------------------------------------------------------------------ identity

        /// <summary>目标 SID 一律取本进程所在交互会话的登录用户；非提权进程退化为自身用户。</summary>
        private static string ResolveSessionUserSid()
        {
            uint sessionId = (uint)Process.GetCurrentProcess().SessionId;
            string sid;
            if (BootstrapNative.TrySessionUserSid(sessionId, out sid))
            {
                return sid;
            }
            if (!BootstrapNative.IsElevated())
            {
                return BootstrapNative.CurrentUserSid();
            }
            throw new TaskFault(ErrSessionUnknown, "无法确定当前交互登录用户");
        }

        private static void RequireElevatedSameUser(string sessionSid, bool relaunched)
        {
            if (!BootstrapNative.IsElevated())
            {
                // relaunched 后仍未提权 = UAC 静默被拒或非管理员令牌。
                throw new TaskFault(ErrAdminRequired, relaunched
                    ? "需要本机管理员账号完成该操作"
                    : "需要管理员授权");
            }
            if (!string.Equals(BootstrapNative.CurrentUserSid(), sessionSid, StringComparison.OrdinalIgnoreCase))
            {
                throw new TaskFault(ErrUserMismatch, "提权账号与当前交互登录用户不一致，拒绝操作");
            }
        }

        // ------------------------------------------------------------------ operations

        /// <summary>
        /// install：登记/刷新规范定义。已存在任务保留其 trigger 启停状态（升级不重置），
        /// 新建时按“已配对且曾有 HKCU Run 自启动”推断，未绑定一律登记 trigger 禁用、不自动运行。
        /// </summary>
        private static Dictionary<string, object> Install(string sessionSid)
        {
            string installDir;
            string launcher = ResolveProtectedLauncher(out installDir);
            string taskName = TaskName(sessionSid);
            bool desired = false;
            RunStaThread(delegate
            {
                object service = null;
                object folder = null;
                object existing = null;
                try
                {
                    service = Connect();
                    folder = Invoke(service, "GetFolder", new object[] { "\\" });
                    existing = TryGetTask(folder, taskName);
                    desired = existing != null
                        ? ReadTriggerEnabled(existing)
                        : HostConfigured() && LegacyRunPresent(sessionSid);
                    RegisterDefinition(service, folder, taskName, launcher, installDir, sessionSid, desired);
                }
                finally
                {
                    Release(existing);
                    Release(folder);
                    Release(service);
                }
            });
            // legacy HKCU Run 只认本会话用户的 hive；任务接管后必须移除以免双份启动。
            DeleteLegacyRun(sessionSid);
            return StateResult(true, desired);
        }

        /// <summary>
        /// enable/disable：回写“已校验固定 launcher+本 SID”的规范定义，仅携带目标 trigger
        /// 启停值——绝不信任同名已有任务的 action/principal。任务本体始终 enabled、可随时 Run。
        /// </summary>
        private static Dictionary<string, object> SetTrigger(string sessionSid, bool enabled)
        {
            string taskName = TaskName(sessionSid);
            bool installed = false;
            RunStaThread(delegate
            {
                object service = null;
                object folder = null;
                object existing = null;
                try
                {
                    service = Connect();
                    folder = Invoke(service, "GetFolder", new object[] { "\\" });
                    existing = TryGetTask(folder, taskName);
                    if (existing == null && !enabled)
                    {
                        return;
                    }
                    string installDir;
                    string launcher = ResolveProtectedLauncher(out installDir);
                    RegisterDefinition(service, folder, taskName, launcher, installDir, sessionSid, enabled);
                    installed = true;
                }
                finally
                {
                    Release(existing);
                    Release(folder);
                    Release(service);
                }
            });
            DeleteLegacyRun(sessionSid);
            return StateResult(installed, installed && enabled);
        }

        private static Dictionary<string, object> Remove(string sessionSid)
        {
            string taskName = TaskName(sessionSid);
            RunStaThread(delegate
            {
                object service = null;
                object folder = null;
                object existing = null;
                try
                {
                    service = Connect();
                    folder = Invoke(service, "GetFolder", new object[] { "\\" });
                    existing = TryGetTask(folder, taskName);
                    if (existing != null)
                    {
                        Invoke(folder, "DeleteTask", new object[] { taskName, 0 });
                    }
                }
                finally
                {
                    Release(existing);
                    Release(folder);
                    Release(service);
                }
            });
            DeleteLegacyRun(sessionSid);
            return StateResult(false, false);
        }

        private static Dictionary<string, object> Status(string sessionSid)
        {
            string taskName = TaskName(sessionSid);
            bool installed = false;
            bool autostart = false;
            RunStaThread(delegate
            {
                object service = null;
                object folder = null;
                object existing = null;
                try
                {
                    service = Connect();
                    folder = Invoke(service, "GetFolder", new object[] { "\\" });
                    existing = TryGetTask(folder, taskName);
                    installed = existing != null;
                    // 任务缺失但旧 HKCU Run 仍在时如实反映仍有自启动；任务存在则以 trigger 为准。
                    autostart = installed ? ReadTriggerEnabled(existing) : LegacyRunPresent(sessionSid);
                }
                finally
                {
                    Release(existing);
                    Release(folder);
                    Release(service);
                }
            });
            return StateResult(installed, autostart);
        }

        private static Dictionary<string, object> Start(string sessionSid)
        {
            string installDir;
            string expected = ResolveLauncherPath(out installDir);
            if (!File.Exists(expected))
            {
                throw new TaskFault(ErrLauncherMissing, "找不到固定 launcher: " + expected);
            }
            string taskName = TaskName(sessionSid);
            RunStaThread(delegate
            {
                object service = null;
                object folder = null;
                object task = null;
                object running = null;
                try
                {
                    service = Connect();
                    folder = Invoke(service, "GetFolder", new object[] { "\\" });
                    task = TryGetTask(folder, taskName);
                    if (task == null)
                    {
                        throw new TaskFault(ErrTaskMissing, "Host 登录任务尚未安装");
                    }
                    VerifyOwnedTask(task, sessionSid, expected);
                    running = Invoke(task, "Run", new object[] { null });
                }
                finally
                {
                    Release(running);
                    Release(task);
                    Release(folder);
                    Release(service);
                }
            });
            var result = new Dictionary<string, object>();
            result["status"] = "started";
            return result;
        }

        // ------------------------------------------------------------------ task internals (STA thread only)

        private static object TryGetTask(object folder, string taskName)
        {
            try
            {
                return Invoke(folder, "GetTask", new object[] { taskName });
            }
            catch (Exception ex)
            {
                // 反射走 COM 时任务不存在的 0x80070002 可能映射为 FileNotFoundException，
                // 只按 HResult 判定 not-installed，其它异常原样抛出。
                if (ex.HResult == unchecked((int)0x80070002))
                {
                    return null;
                }
                throw;
            }
        }

        /// <summary>读取已登记任务登录 trigger 的 Enabled；找不到登录 trigger 按 false 处理。</summary>
        private static bool ReadTriggerEnabled(object registeredTask)
        {
            object definition = null;
            object triggers = null;
            try
            {
                definition = Get(registeredTask, "Definition");
                triggers = Get(definition, "Triggers");
                int count = Convert.ToInt32(Get(triggers, "Count"), System.Globalization.CultureInfo.InvariantCulture);
                for (int i = 1; i <= count; i++)
                {
                    object item = null;
                    try
                    {
                        item = GetIndexed(triggers, "Item", i);
                        int type = Convert.ToInt32(Get(item, "Type"), System.Globalization.CultureInfo.InvariantCulture);
                        if (type == TriggerTypeLogon)
                        {
                            return (bool)Get(item, "Enabled");
                        }
                    }
                    finally
                    {
                        Release(item);
                    }
                }
                return false;
            }
            finally
            {
                Release(triggers);
                Release(definition);
            }
        }

        /// <summary>
        /// Run 前静态核对任务确实是本产品固定内容：principal 为本会话用户 InteractiveToken，
        /// 唯一 action 为固定 launcher 路径 + run 参数；任何一项不符视为外来任务，拒绝代跑。
        /// </summary>
        private static void VerifyOwnedTask(object registeredTask, string sessionSid, string expectedLauncher)
        {
            object definition = null;
            object principal = null;
            object actions = null;
            object item = null;
            bool ownerOk = false;
            bool actionOk = false;
            try
            {
                definition = Get(registeredTask, "Definition");
                principal = Get(definition, "Principal");
                string userId = Get(principal, "UserId") as string;
                int logonType = Convert.ToInt32(Get(principal, "LogonType"), System.Globalization.CultureInfo.InvariantCulture);
                // Task Scheduler 的 COM 接口可能返回用户名，XML 中则保存 SID。
                if (!string.IsNullOrEmpty(userId)
                    && !string.Equals(userId, sessionSid, StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        userId = ((SecurityIdentifier)new NTAccount(userId).Translate(typeof(SecurityIdentifier))).Value;
                    }
                    catch (IdentityNotMappedException)
                    {
                        userId = null;
                    }
                }
                ownerOk = string.Equals(userId, sessionSid, StringComparison.OrdinalIgnoreCase) && logonType == 3;

                actions = Get(definition, "Actions");
                int count = Convert.ToInt32(Get(actions, "Count"), System.Globalization.CultureInfo.InvariantCulture);
                if (count == 1)
                {
                    item = GetIndexed(actions, "Item", 1);
                    string path = Get(item, "Path") as string;
                    string argline = (Get(item, "Arguments") as string) ?? "";
                    string workDir = (Get(item, "WorkingDirectory") as string) ?? "";
                    string expectDir = Path.GetDirectoryName(expectedLauncher);
                    string normPath = null;
                    try
                    {
                        normPath = string.IsNullOrEmpty(path) ? null : Path.GetFullPath(path);
                    }
                    catch (Exception)
                    {
                    }
                    actionOk = normPath != null
                        && string.Equals(normPath, Path.GetFullPath(expectedLauncher), StringComparison.OrdinalIgnoreCase)
                        && string.Equals(argline.Trim(), "run", StringComparison.Ordinal)
                        && string.Equals(NormalizeDir(workDir), NormalizeDir(expectDir), StringComparison.OrdinalIgnoreCase);
                }
            }
            finally
            {
                Release(item);
                Release(actions);
                Release(principal);
                Release(definition);
            }
            if (!ownerOk || !actionOk)
            {
                throw new TaskFault(ErrTaskForeign, "任务 " + TaskName(sessionSid) + " 定义不是本产品固定内容，拒绝运行");
            }
        }

        private static string NormalizeDir(string dir)
        {
            if (string.IsNullOrEmpty(dir))
            {
                return "";
            }
            try
            {
                return Path.GetFullPath(dir).TrimEnd('\\', '/');
            }
            catch (Exception)
            {
                return dir;
            }
        }

        /// <summary>
        /// 规范定义：InteractiveToken(3)+Highest(1)、本 SID logon trigger、
        /// action 固定 launcher run、任务本体 Enabled 恒 true（手动 Run 不受自启开关影响）、
        /// 无时限/电池限制、IgnoreNew 单实例、有限重试、ACL 仅管理员/SYSTEM 可写、所属用户可读可运行。
        /// </summary>
        private static void RegisterDefinition(object service, object folder, string taskName, string launcher, string installDir, string sessionSid, bool triggerEnabled)
        {
            object definition = null;
            object registered = null;
            try
            {
                definition = Invoke(service, "NewTask", new object[] { 0 });

                object registrationInfo = Get(definition, "RegistrationInfo");
                Set(registrationInfo, "Author", "pibot");
                Set(registrationInfo, "Description", "当前用户登录后运行的 Host 守护(pibot-host run)");

                object principal = Get(definition, "Principal");
                Set(principal, "UserId", sessionSid);
                Set(principal, "LogonType", 3);   // TASK_LOGON_INTERACTIVE_TOKEN
                Set(principal, "RunLevel", 1);    // TASK_RUNLEVEL_HIGHEST

                object triggers = Get(definition, "Triggers");
                object trigger = Invoke(triggers, "Create", new object[] { TriggerTypeLogon });
                Set(trigger, "UserId", sessionSid);
                Set(trigger, "Enabled", triggerEnabled);

                object settings = Get(definition, "Settings");
                Set(settings, "Enabled", true);                 // 自启开关只走 trigger，本体常开保证可手动 Run
                Set(settings, "AllowDemandStart", true);
                Set(settings, "MultipleInstances", 2);          // IgnoreNew：单实例
                Set(settings, "ExecutionTimeLimit", "PT0S");    // 无时限
                Set(settings, "DisallowStartIfOnBatteries", false);
                Set(settings, "StopIfGoingOnBatteries", false);
                Set(settings, "StartWhenAvailable", false);
                Set(settings, "RunOnlyIfIdle", false);
                Set(settings, "RestartCount", 3);               // 有限重试
                Set(settings, "RestartInterval", "PT1M");

                object actions = Get(definition, "Actions");
                object action = Invoke(actions, "Create", new object[] { 0 });
                Set(action, "Path", launcher);
                Set(action, "Arguments", "run");
                Set(action, "WorkingDirectory", installDir);

                registered = Invoke(folder, "RegisterTaskDefinition",
                    new object[] { taskName, definition, 6, null, null, 3, TaskSddl(sessionSid) });
            }
            finally
            {
                Release(registered);
                Release(definition);
            }
        }

        /// <summary>写/删仅管理员与 SYSTEM；所属用户可读（status/读定义）与运行（start）。</summary>
        private static string TaskSddl(string sessionSid)
        {
            return "O:BAG:SYD:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;" + sessionSid + ")";
        }

        private static object Connect()
        {
            Type type = Type.GetTypeFromProgID("Schedule.Service");
            if (type == null)
            {
                throw new InvalidOperationException("找不到 Task Scheduler COM(Schedule.Service)");
            }
            object service = Activator.CreateInstance(type);
            Invoke(service, "Connect", new object[] { Type.Missing, Type.Missing, Type.Missing, Type.Missing });
            return service;
        }

        // ------------------------------------------------------------------ results / emit

        private static Dictionary<string, object> StateResult(bool installed, bool autostart)
        {
            var result = new Dictionary<string, object>();
            result["installed"] = installed;
            result["autostart"] = autostart;
            return result;
        }

        private static Dictionary<string, object> ErrorResult(string code, string message)
        {
            var error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message ?? "";
            var result = new Dictionary<string, object>();
            result["error"] = error;
            return result;
        }

        private static void Emit(Dictionary<string, object> value)
        {
            string line = WireJson.Serialize(value);
            try
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                HostLog.Warn("host-task stdout write failed: " + ex.Message);
            }
        }

        // ------------------------------------------------------------------ elevation relay

        /// <summary>
        /// 仅重启自身 exe（host-task &lt;op&gt; --elevated），绝不把外部 exe/script/路径
        /// 放进提权通道：子进程用固定退出码回传错误，父进程按退出码还原标准错误；
        /// 成功时父进程以普通权限回读 Status 形成最终 JSON。
        /// </summary>
        private static int RelayElevated(string op)
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            ProcessStartInfo info = new ProcessStartInfo(self, "host-task " + op + " --elevated");
            info.UseShellExecute = true;
            info.Verb = "runas";
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process child;
            try
            {
                child = Process.Start(info);
            }
            catch (Win32Exception ex)
            {
                if (ex.NativeErrorCode == 1223)
                {
                    Emit(ErrorResult(ErrCancelled, "用户取消了管理员授权"));
                }
                else
                {
                    Emit(ErrorResult("ELEVATION_FAILED", ex.Message));
                }
                return 1;
            }
            int code;
            using (child)
            {
                if (!child.WaitForExit(ElevationWaitMilliseconds))
                {
                    try
                    {
                        child.Kill();
                    }
                    catch (Exception)
                    {
                    }
                    Emit(ErrorResult("ELEVATION_TIMEOUT", "提权助手等待超时"));
                    return 1;
                }
                code = child.ExitCode;
            }
            if (code != 0)
            {
                Emit(ErrorResult(FaultCodeForExit(code), FaultMessageForExit(code)));
                return 1;
            }
            try
            {
                Emit(Status(ResolveSessionUserSid()));
            }
            catch (TaskFault fault)
            {
                Emit(ErrorResult(fault.Code, fault.Message));
                return 1;
            }
            catch (Exception ex)
            {
                Emit(ErrorResult("INTERNAL", ex.GetType().Name + ": " + ex.Message));
                return 1;
            }
            return 0;
        }

        // ------------------------------------------------------------------ install layout

        /// <summary>
        /// 固定布局推导：native/shower-windows.exe → host-runtime → 安装目录；
        /// launcher 一律为 &lt;installDir&gt;/pibot-host.exe（仅推导路径，不做保护校验）。
        /// </summary>
        private static string ResolveLauncherPath(out string installDir)
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            string nativeDir = Path.GetDirectoryName(self);
            string runtimeDir = string.IsNullOrEmpty(nativeDir) ? null : Path.GetDirectoryName(nativeDir);
            installDir = string.IsNullOrEmpty(runtimeDir) ? null : Path.GetDirectoryName(runtimeDir);
            if (string.IsNullOrEmpty(installDir)
                || !string.Equals(Path.GetFileName(runtimeDir), RuntimeDirName, StringComparison.OrdinalIgnoreCase))
            {
                throw new TaskFault(ErrNotProtected, "helper 不在受保护的安装布局内: " + self);
            }
            return Path.Combine(installDir, LauncherExeName);
        }

        /// <summary>登记任务用的完整保护校验：目录属主/ACL 与全部相关二进制均须防普通用户写。</summary>
        private static string ResolveProtectedLauncher(out string installDir)
        {
            string launcher = ResolveLauncherPath(out installDir);
            string self = Process.GetCurrentProcess().MainModule.FileName;
            if (!File.Exists(launcher))
            {
                throw new TaskFault(ErrLauncherMissing, "找不到固定 launcher: " + launcher);
            }
            string node = Path.Combine(installDir, NodeExeName);
            if (!File.Exists(node))
            {
                throw new TaskFault(ErrNotProtected, "安装文件缺失: " + node);
            }
            RequireProtectedDir(installDir);
            string parent = Path.GetDirectoryName(installDir);
            if (!string.IsNullOrEmpty(parent) && Directory.Exists(parent))
            {
                RequireProtectedDir(parent);
            }
            RequireProtectedDir(Path.Combine(installDir, RuntimeDirName));
            RequireProtectedDir(Path.GetDirectoryName(self));
            RequireProtectedFile(launcher);
            RequireProtectedFile(node);
            RequireProtectedFile(self);
            return launcher;
        }

        /// <summary>
        /// 目录属主必须是管理员/SYSTEM/安装服务，且 DACL 不得把写权限交给普通身份
        /// （Everyone/Users/INTERACTIVE/认证用户或任意普通用户/组）；null DACL 视为不保护。
        /// mask 只含原子写/删/权限位，读/执行/同步位不计——Users 组的只读执行是合法配置。
        /// </summary>
        private static void RequireProtectedDir(string dir)
        {
            DirectorySecurity security;
            try
            {
                security = Directory.GetAccessControl(dir);
            }
            catch (Exception ex)
            {
                throw new TaskFault(ErrNotProtected, "无法读取安装目录权限: " + ex.Message);
            }
            if (!IsProtectedAcl(security))
            {
                throw new TaskFault(ErrNotProtected, "安装目录允许普通用户写入: " + dir);
            }
        }

        private static void RequireProtectedFile(string file)
        {
            FileSecurity security;
            try
            {
                security = File.GetAccessControl(file);
            }
            catch (Exception ex)
            {
                throw new TaskFault(ErrNotProtected, "无法读取二进制权限: " + ex.Message);
            }
            if (!IsProtectedAcl(security))
            {
                throw new TaskFault(ErrNotProtected, "二进制允许普通用户写入: " + file);
            }
        }

        private static bool IsProtectedAcl(FileSystemSecurity security)
        {
            SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner == null || !IsAdministrativeSid(owner))
            {
                return false;
            }
            // 只取原子写/删/权限位；FullControl/Modify/Write 复合位含读权限会误伤正常只读授权。
            const FileSystemRights writeMask =
                FileSystemRights.WriteData | FileSystemRights.AppendData |
                FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes |
                FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Delete |
                FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            int allowRules = 0;
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (AuthorizationRule rule in rules)
            {
                FileSystemAccessRule access = rule as FileSystemAccessRule;
                if (access == null || access.AccessControlType != AccessControlType.Allow)
                {
                    continue;
                }
                allowRules++;
                SecurityIdentifier identity = access.IdentityReference as SecurityIdentifier;
                if (identity == null || IsAdministrativeSid(identity) || IsScopedSid(identity))
                {
                    continue;
                }
                if ((access.FileSystemRights & writeMask) != 0)
                {
                    return false;
                }
            }
            return allowRules > 0;
        }

        /// <summary>SID 属于系统/管理员/服务身份：写权限交给它们不构成普通用户篡改面。</summary>
        private static bool IsAdministrativeSid(SecurityIdentifier sid)
        {
            if (sid.IsWellKnown(WellKnownSidType.LocalSystemSid)
                || sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)
                || sid.IsWellKnown(WellKnownSidType.LocalServiceSid)
                || sid.IsWellKnown(WellKnownSidType.NetworkServiceSid))
            {
                return true;
            }
            string value = sid.Value;
            // NT SERVICE\*（含 TrustedInstaller）服务 SID 不是交互用户主体。
            return value != null && value.StartsWith("S-1-5-80-", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>CREATOR OWNER/OWNER RIGHTS/SELF 这类作用域伪 SID 不代表宽泛授权。</summary>
        private static bool IsScopedSid(SecurityIdentifier sid)
        {
            return sid.IsWellKnown(WellKnownSidType.CreatorOwnerSid)
                || sid.IsWellKnown(WellKnownSidType.CreatorGroupSid)
                || sid.IsWellKnown(WellKnownSidType.SelfSid)
                || string.Equals(sid.Value, "S-1-3-4", StringComparison.Ordinal);
        }

        // ------------------------------------------------------------------ legacy / pairing state

        private static bool HostConfigured()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return File.Exists(Path.Combine(Path.Combine(home, HostHomeRelative), "config.json"));
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool LegacyRunPresent(string sessionSid)
        {
            try
            {
                using (RegistryKey key = Registry.Users.OpenSubKey(sessionSid + "\\" + RunKeyPath, false))
                {
                    return key != null && key.GetValue(RunValueName) != null;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void DeleteLegacyRun(string sessionSid)
        {
            try
            {
                using (RegistryKey key = Registry.Users.OpenSubKey(sessionSid + "\\" + RunKeyPath, true))
                {
                    if (key != null)
                    {
                        key.DeleteValue(RunValueName, false);
                    }
                }
            }
            catch (Exception ex)
            {
                HostLog.Warn("legacy Run 清理失败: " + ex.Message);
            }
        }

        private static string TaskName(string sessionSid)
        {
            return TaskNamePrefix + sessionSid;
        }

        // ------------------------------------------------------------------ COM plumbing

        private static Exception Unwrap(Exception ex)
        {
            TargetInvocationException tie = ex as TargetInvocationException;
            return tie != null && tie.InnerException != null ? tie.InnerException : ex;
        }

        private static object Invoke(object target, string name, object[] arguments)
        {
            try
            {
                return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, arguments);
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
        }

        private static object Get(object target, string name)
        {
            try
            {
                return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, new object[0]);
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
        }

        /// <summary>Item(i) 是带参数的属性 get（DISPATCH_PROPERTYGET），按 GetProperty 传 index 分发。</summary>
        private static object GetIndexed(object target, string name, int index)
        {
            try
            {
                return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, new object[] { index });
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
        }

        private static void Set(object target, string name, object value)
        {
            try
            {
                target.GetType().InvokeMember(name, BindingFlags.SetProperty, null, target, new object[] { value });
            }
            catch (TargetInvocationException ex)
            {
                throw Unwrap(ex);
            }
        }

        private static void Release(object target)
        {
            if (target == null)
            {
                return;
            }
            try
            {
                Marshal.FinalReleaseComObject(target);
            }
            catch (Exception)
            {
            }
        }

        private static void RunStaThread(ThreadStart work)
        {
            Exception failure = null;
            Thread thread = new Thread(delegate()
            {
                try
                {
                    work();
                }
                catch (Exception e)
                {
                    failure = e;
                }
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            if (!thread.Join(TimeSpan.FromSeconds(60)))
            {
                throw new TimeoutException("计划任务 COM 操作超时");
            }
            if (failure != null)
            {
                throw failure;
            }
        }
    }
}
