using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// 子会话启用与 agent 启动。
    /// 实测：普通提权令牌复制子会话 explorer 令牌后 CreateProcessAsUser 返回 1314（缺 SeAssignPrimaryToken）；
    /// 且 WTSQueryUserToken 需要 SeTcbPrivilege。因此用一次性 SYSTEM 计划任务做跳板，
    /// 由 SYSTEM 取子会话用户令牌，再把该用户的普通（非提权）agent 启动在 winsta0\default。
    /// </summary>
    public static class SessionBootstrap
    {
        private const int ElevationTimeoutMilliseconds = 120000;
        private const int ResultTimeoutMilliseconds = 45000;
        private const long HostStartToleranceTicks = 2 * TimeSpan.TicksPerSecond;
        private const string AgentMode = "agent";

        /// <summary>启用 Windows 子会话并按需启动 TermService；记录原值并派 guardian 在宿主退出后恢复。</summary>
        public static void EnsureEnabled(string stateDir)
        {
            string dir = BootstrapFile.NormalizeDir(stateDir, true);
            BootstrapNative.EnsureStateDirAcl(dir, null);

            Process host = Process.GetCurrentProcess();
            int hostPid = host.Id;
            long hostStart = HostStartTicks(host);
            string hostSid = BootstrapNative.CurrentUserSid();

            // 遗留恢复的特权操作只发生在已提权上下文；普通宿主把恢复交给 elevated worker，
            // 不在 UAC 之前尝试需要权限的注销/系统还原（会在远端阻塞且无 consent 可点）。
            if (BootstrapNative.CanActAsSystem() || BootstrapNative.IsElevated())
            {
                BootstrapGuardian.RestoreAbandoned(dir);
            }

            bool enabled;
            bool known = BootstrapNative.TryIsChildSessionsEnabled(out enabled);
            BootstrapGuardian.EnableState remainingOwner = BootstrapGuardian.ReadState(dir);
            bool currentOwner = remainingOwner == null || (remainingOwner.HostPid == hostPid && remainingOwner.HostStartTicks == hostStart);
            if (known && enabled && BootstrapNative.TermServiceRunning() && currentOwner && BootstrapNative.IsElevated())
            {
                // 系统状态无需改动，但仍要登记 owner 并派无需额外授权的 guardian：
                // 否则宿主被强杀时会遗留已登录的 child。基线为 enabled/running，guardian 不会改全局设置。
                BootstrapGuardian.EnableState owner = BootstrapGuardian.EnsureOwnerRecord(dir, hostPid, hostStart, host.SessionId, true, true);
                owner.GuardianElevated = true;
                BootstrapGuardian.WriteState(dir, owner);
                BootstrapGuardian.EnsureGuardian(dir, owner);
                BootstrapLog.Write(dir, "子会话与 TermService 已就绪，只登记 owner 与 guardian");
                return;
            }

            if (BootstrapGuardian.IsReadyForHost(dir, hostPid, hostStart))
            {
                BootstrapLog.Write(dir, "本次宿主已记录启用状态，跳过重复启用");
                return;
            }

            if (BootstrapNative.CanActAsSystem() || BootstrapNative.IsElevated())
            {
                EnsureWorker(dir, hostPid, hostStart, hostSid);
            }
            else
            {
                string arguments = "--state-dir " + Quote(dir)
                    + " --host-pid " + hostPid.ToString(CultureInfo.InvariantCulture)
                    + " --host-start " + hostStart.ToString(CultureInfo.InvariantCulture)
                    + " --host-sid " + Quote(hostSid);
                BootstrapLog.Write(dir, "bootstrap-ensure request: " + arguments);
                RunElevatedSync(dir, "bootstrap-ensure", arguments, ElevationTimeoutMilliseconds);
                if (!BootstrapGuardian.IsReadyForHost(dir, hostPid, hostStart))
                {
                    throw new Win32Exception(5, "启用 Windows 子会话失败：未获得管理员授权或状态未生效");
                }
            }

            bool applied;
            if (!BootstrapNative.TryIsChildSessionsEnabled(out applied) || !applied)
            {
                throw new InvalidOperationException("子会话开关读回不一致");
            }
            if (!BootstrapNative.TermServiceRunning())
            {
                throw new InvalidOperationException("TermService 未处于运行状态");
            }
        }

        /// <summary>
        /// 在已登录的子会话里启动本程序 agent 模式。固定 exe、固定参数，不接受任意命令或任意会话。
        /// 非提权宿主复用启动时 prepare 授权的提权 guardian；guardian 缺失时明确失败，
        /// 要求重启 Host 重新授权，绝不在会话创建路径上再次发起 UAC。
        /// </summary>
        public static void LaunchAgent(int childSessionId, int parentSessionId, string pipeName, string stateDir, string exePath)
        {
            string dir = BootstrapFile.NormalizeDir(stateDir, true);
            BootstrapNative.EnsureStateDirAcl(dir, null);

            if (childSessionId < 1 || parentSessionId < 1)
            {
                throw new ArgumentException("会话 ID 无效");
            }
            if (childSessionId == parentSessionId)
            {
                throw new ArgumentException("child 与 parent 会话不能相同");
            }
            if (!IsValidPipeName(pipeName))
            {
                throw new ArgumentException("pipe 名无效");
            }
            Process host = Process.GetCurrentProcess();
            if (host.SessionId != parentSessionId)
            {
                throw new InvalidOperationException("parent 会话与当前宿主会话不一致");
            }
            VerifyChildSessionForParent(childSessionId, parentSessionId);
            string exe = NormalizeAgentExe(exePath);
            string userSid = BootstrapNative.CurrentUserSid();
            long hostStart = HostStartTicks(host);

            // 先绑定归属：即使后续启动失败或宿主被强杀，guardian 也能只注销这一条 child。
            BootstrapGuardian.BindOwnedChild(dir, host.Id, hostStart, parentSessionId, childSessionId, userSid);

            string nonce = Guid.NewGuid().ToString("N");
            string requestPath = Path.Combine(dir, BootstrapFile.LaunchPrefix + nonce + BootstrapFile.RequestSuffix);
            Dictionary<string, string> request = new Dictionary<string, string>();
            BootstrapFile.Set(request, "version", "1");
            BootstrapFile.SetInt(request, "childSessionId", childSessionId);
            BootstrapFile.SetInt(request, "parentSessionId", parentSessionId);
            BootstrapFile.Set(request, "pipe", pipeName);
            BootstrapFile.Set(request, "exe", exe);
            BootstrapFile.Set(request, "userSid", userSid);
            BootstrapFile.SetInt(request, "hostPid", host.Id);
            BootstrapFile.SetLong(request, "hostStartTicks", hostStart);
            BootstrapFile.SetInt(request, "hostSessionId", host.SessionId);
            BootstrapFile.Set(request, "createdUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
            bool delegated = !BootstrapNative.IsElevated() && BootstrapGuardian.IsReadyForHost(dir, host.Id, hostStart);
            BootstrapFile.Set(request, "guardian", delegated ? "1" : "0");
            BootstrapFile.Write(requestPath, request);
            BootstrapLog.Write(dir, "请求在子会话 " + childSessionId.ToString(CultureInfo.InvariantCulture) + " 启动 agent");

            string arguments = "--state-dir " + Quote(dir) + " --request " + Quote(requestPath);
            try
            {
                if (delegated)
                {
                    BootstrapLog.Write(dir, "已提交给本宿主的提权 guardian，无需再次 UAC");
                }
                else if (BootstrapNative.CanActAsSystem())
                {
                    RunSystemBootstrap(dir, requestPath, userSid);
                    DeleteLaunchFiles(requestPath);
                }
                else if (BootstrapNative.IsElevated())
                {
                    BootstrapTask.CleanupStale(dir, TimeSpan.FromMinutes(10));
                    CleanupStaleLaunchFiles(dir);
                    RunTaskBootstrap(dir, requestPath);
                }
                else
                {
                    // 不静默重新提权：缺失的启动授权只由下一次 Host 启动时的 prepare 恢复。
                    BootstrapLog.Write(dir, "启动授权 guardian 不可用，拒绝在会话中重新 UAC；重启 Host 以重新授权");
                    throw new Win32Exception(5, "Windows 虚拟屏的启动授权已失效；请重启 Host 后重试");
                }
            }
            catch (Exception)
            {
                TryDelete(requestPath);
                throw;
            }
        }

        /// <summary>bootstrap-* 入口，由 Program.Main 分发。</summary>
        public static int Run(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                Usage();
                return 2;
            }
            try
            {
                // 容错：Program.Main 可能原样传 "bootstrap-*"，也可能只传后面一段。
                string mode = args[0] == null ? "" : args[0];
                if (mode.StartsWith("bootstrap-", StringComparison.OrdinalIgnoreCase))
                {
                    mode = mode.Substring("bootstrap-".Length);
                }
                if (string.Equals(mode, "ensure", StringComparison.OrdinalIgnoreCase))
                {
                    return RunEnsureWorker(args);
                }
                if (string.Equals(mode, "launch", StringComparison.OrdinalIgnoreCase))
                {
                    return RunLaunchWorker(args);
                }
                if (string.Equals(mode, "system", StringComparison.OrdinalIgnoreCase))
                {
                    return RunSystemWorker(args);
                }
                if (string.Equals(mode, "guard", StringComparison.OrdinalIgnoreCase))
                {
                    return BootstrapGuardian.Run(args);
                }
                Usage();
                return 2;
            }
            catch (Exception e)
            {
                string diagnostic = e.InnerException != null ? e.InnerException.Message : e.Message;
                string logDir = BootstrapFile.Get(ParseOptions(args, 1), "state-dir");
                BootstrapLog.Write(logDir, "bootstrap 失败: " + SanitizeMessage(diagnostic));
                return 3;
            }
        }

        internal static string SelfExePath()
        {
            try
            {
                return Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
            }
            catch (Exception)
            {
                return Path.GetFullPath(Assembly.GetEntryAssembly().Location);
            }
        }

        internal static string Quote(string value)
        {
            if (value == null)
            {
                return "\"\"";
            }
            if (value.IndexOf('"') >= 0)
            {
                throw new ArgumentException("参数不能包含引号");
            }
            return "\"" + value + "\"";
        }

        internal static Dictionary<string, string> ParseOptions(string[] args, int startIndex)
        {
            Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = startIndex; i < args.Length; i++)
            {
                string argument = args[i];
                if (argument == null || !argument.StartsWith("--", StringComparison.Ordinal))
                {
                    continue;
                }
                string key = argument.Substring(2);
                string value = "";
                if (i + 1 < args.Length && args[i + 1] != null && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    i++;
                    value = args[i];
                }
                options[key] = value;
            }
            return options;
        }

        private static int RunEnsureWorker(string[] args)
        {
            Dictionary<string, string> options = ParseOptions(args, 1);
            string dir = BootstrapFile.NormalizeDir(BootstrapFile.Get(options, "state-dir"), true);
            int hostPid = BootstrapFile.GetInt(options, "host-pid", 0);
            long hostStart = BootstrapFile.GetLong(options, "host-start", 0);
            string hostSid = BootstrapFile.Get(options, "host-sid");
            if (hostPid <= 0 || hostStart <= 0)
            {
                BootstrapLog.Write(dir, "bootstrap-ensure 参数不完整");
                return 2;
            }
            if (!BootstrapNative.IsElevated() && !BootstrapNative.IsSystem())
            {
                BootstrapLog.Write(dir, "bootstrap-ensure 需要管理员权限");
                return 5;
            }
            BootstrapNative.EnsureStateDirAcl(dir, hostSid);
            EnsureWorker(dir, hostPid, hostStart, hostSid);
            return 0;
        }

        // The elevated guardian only accepts fixed agent launches for the native Host it supervises.
        internal static void ProcessDelegatedLaunches(string dir, BootstrapGuardian.EnableState owner)
        {
            foreach (string file in Directory.GetFiles(dir, BootstrapFile.LaunchPrefix + "*" + BootstrapFile.RequestSuffix))
            {
                if (file.EndsWith(BootstrapFile.ResultSuffix, StringComparison.OrdinalIgnoreCase)) continue;
                bool delegated = false;
                try
                {
                    Dictionary<string, string> map = BootstrapFile.Read(file);
                    if (!BootstrapFile.GetBool(map, "guardian", false)) continue;
                    delegated = true;
                    LaunchRequest request = ParseLaunchRequest(dir, file);
                    if (request.HostPid != owner.HostPid || request.HostStartTicks != owner.HostStartTicks)
                        throw new InvalidOperationException("guardian 请求不属于当前宿主");
                    if (request.ParentSessionId != owner.ParentSessionId || request.ChildSessionId != owner.OwnedChildSessionId
                        || !string.Equals(request.UserSid, owner.OwnedUserSid, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("guardian 请求的会话或用户不匹配");
                    // WTSQueryUserToken validation remains in the existing LocalSystem worker.
                    RunLaunchWorker(new string[] { "bootstrap-launch", "--state-dir", dir, "--request", file });
                }
                catch (Exception error)
                {
                    BootstrapLog.Write(dir, "guardian 启动失败: " + SanitizeMessage(error.Message));
                }
                finally
                {
                    // Never replay a launch whose result may already have taken effect.
                    if (delegated) DeleteLaunchFiles(file);
                }
            }
        }

        private static int RunLaunchWorker(string[] args)
        {
            Dictionary<string, string> options = ParseOptions(args, 1);
            string dir = BootstrapFile.NormalizeDir(BootstrapFile.Get(options, "state-dir"), true);
            string requestPath = BootstrapFile.Get(options, "request");
            if (!BootstrapFile.IsDirectChild(dir, requestPath))
            {
                BootstrapLog.Write(dir, "bootstrap-launch 请求文件无效");
                return 2;
            }
            if (!BootstrapNative.IsElevated() && !BootstrapNative.IsSystem())
            {
                BootstrapLog.Write(dir, "bootstrap-launch 需要管理员权限");
                return 5;
            }
            BootstrapNative.EnsureStateDirAcl(dir, null);
            LaunchRequest helperRequest = ParseLaunchRequest(dir, requestPath);
            if (helperRequest.ChildSessionId < 1 || helperRequest.ParentSessionId < 1
                || helperRequest.ChildSessionId == helperRequest.ParentSessionId)
            {
                BootstrapLog.Write(dir, "bootstrap-launch 请求中的会话 ID 无效");
                return 2;
            }
            VerifyChildSessionForParent(helperRequest.ChildSessionId, helperRequest.ParentSessionId);
            if (BootstrapNative.IsSystem())
            {
                RunSystemBootstrap(dir, requestPath, null);
            }
            else
            {
                BootstrapTask.CleanupStale(dir, TimeSpan.FromMinutes(10));
                CleanupStaleLaunchFiles(dir);
                RunTaskBootstrap(dir, requestPath);
            }
            return 0;
        }

        private static int RunSystemWorker(string[] args)
        {
            Dictionary<string, string> options = ParseOptions(args, 1);
            string dir = BootstrapFile.NormalizeDir(BootstrapFile.Get(options, "state-dir"), true);
            string requestPath = BootstrapFile.Get(options, "request");
            if (!BootstrapFile.IsDirectChild(dir, requestPath))
            {
                return 2;
            }
            if (!BootstrapNative.IsSystem())
            {
                BootstrapLog.Write(dir, "bootstrap-system 只能以 SYSTEM 身份运行");
                return 5;
            }
            try
            {
                RunSystemBootstrap(dir, requestPath, null);
                return 0;
            }
            catch (Exception e)
            {
                BootstrapLog.Write(dir, "SYSTEM 阶段失败: " + SanitizeMessage(e.Message));
                return 3;
            }
        }

        /// <summary>启用子会话、启动 TermService、记录原值并派 guardian；失败时回滚本次改动。</summary>
        private static void EnsureWorker(string dir, int hostPid, long hostStart, string hostSid)
        {
            if (!BootstrapNative.IsElevated() && !BootstrapNative.IsSystem())
            {
                throw new Win32Exception(5, "启用子会话需要管理员权限");
            }
            BootstrapGuardian.RestoreAbandoned(dir);

            BootstrapGuardian.EnableState state = BootstrapGuardian.ReadState(dir);
            bool adopted = state != null && state.HostPid == hostPid && state.HostStartTicks == hostStart;
            if (state != null && !adopted) throw new Win32Exception(170, "上一宿主的清理尚未完成，不能覆盖恢复基线");

            bool beforeChildSessions;
            if (!BootstrapNative.TryIsChildSessionsEnabled(out beforeChildSessions))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "读取子会话开关失败");
            }
            bool beforeTermService = BootstrapNative.TermServiceRunning();
            if (state != null)
            {
                // 沿用已记录的原始基线：要么是本宿主重复调用，要么上一次宿主未能恢复成功。
                beforeChildSessions = state.ChildSessionsBefore;
                beforeTermService = state.TermServiceBeforeRunning;
            }

            try
            {
                if (!BootstrapNative.TermServiceRunning())
                {
                    BootstrapNative.StartTermService();
                }
                bool enabled;
                if (!BootstrapNative.TryIsChildSessionsEnabled(out enabled))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "读取子会话开关失败");
                }
                if (!enabled)
                {
                    BootstrapNative.SetChildSessionsEnabled(true);
                }
                if (!BootstrapNative.TryIsChildSessionsEnabled(out enabled) || !enabled)
                {
                    throw new InvalidOperationException("子会话开关读回不一致");
                }
                if (!BootstrapNative.TermServiceRunning())
                {
                    throw new InvalidOperationException("TermService 未处于运行状态");
                }

                BootstrapGuardian.EnableState record = new BootstrapGuardian.EnableState();
                record.HostPid = hostPid;
                record.HostStartTicks = hostStart;
                record.ParentSessionId = Process.GetCurrentProcess().SessionId;
                record.ChildSessionsBefore = beforeChildSessions;
                record.TermServiceBeforeRunning = beforeTermService;
                record.Applied = true;
                record.CreatedUtc = adopted && state.CreatedUtc != null
                    ? state.CreatedUtc
                    : DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                record.GuardianElevated = true;
                record.GuardianPid = adopted && state.GuardianElevated && BootstrapGuardian.GuardianAlive(state.GuardianPid) ? state.GuardianPid : 0;
                BootstrapGuardian.WriteState(dir, record);

                if (record.GuardianPid <= 0)
                {
                    record.GuardianPid = BootstrapGuardian.Spawn(dir, hostPid, hostStart);
                    BootstrapGuardian.WriteState(dir, record);
                }
                BootstrapLog.Write(dir, "子会话已启用<TermService=" + (BootstrapNative.TermServiceRunning() ? "Running" : "?")
                    + " 原值 childSessions=" + beforeChildSessions + " term=" + beforeTermService
                    + " guardian=" + record.GuardianPid.ToString(CultureInfo.InvariantCulture) + ">");
            }
            catch (Exception)
            {
                BootstrapGuardian.RestoreValues(dir, beforeChildSessions, beforeTermService);
                // 本次未成功，删掉“已生效”记录，避免下次误判为已启用。
                BootstrapGuardian.DeleteState(dir);
                throw;
            }
        }

        private static void RunTaskBootstrap(string dir, string requestPath)
        {
            string resultPath = ResultPath(requestPath);
            TryDelete(resultPath);
            string taskName = BootstrapTask.NewName();
            string markerPath = Path.Combine(dir, BootstrapFile.TaskPrefix + taskName + BootstrapFile.RequestSuffix);
            Dictionary<string, string> marker = new Dictionary<string, string>();
            BootstrapFile.Set(marker, "task", taskName);
            BootstrapFile.Set(marker, "request", requestPath);
            BootstrapFile.Set(marker, "createdUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
            BootstrapFile.Write(markerPath, marker);
            try
            {
                string self = SelfExePath();
                // 任务动作要带固定 mode，否则 Program.Main 无法 dispatch 到 bootstrap-system。
                string arguments = "bootstrap-system --state-dir " + Quote(dir) + " --request " + Quote(requestPath);
                BootstrapTask.RegisterAndRun(taskName, self, arguments, Path.GetDirectoryName(self));

                int waited = 0;
                while (waited < ResultTimeoutMilliseconds && !File.Exists(resultPath))
                {
                    Thread.Sleep(200);
                    waited += 200;
                }
                if (!File.Exists(resultPath))
                {
                    throw new TimeoutException("SYSTEM 启动任务在超时内没有返回结果");
                }
                Dictionary<string, string> result = BootstrapFile.Read(resultPath);
                if (!BootstrapFile.GetBool(result, "ok", false))
                {
                    throw new InvalidOperationException("子会话 agent 启动失败: "
                        + (BootstrapFile.Get(result, "code") ?? "")
                        + " " + (BootstrapFile.Get(result, "message") ?? ""));
                }
                BootstrapLog.Write(dir, "子会话 agent 已启动 pid=" + (BootstrapFile.Get(result, "pid") ?? "?"));
            }
            finally
            {
                BootstrapTask.Delete(taskName);
                TryDelete(markerPath);
                DeleteLaunchFiles(requestPath);
            }
        }

        /// <summary>SYSTEM 阶段：核验 parent/child/当前用户后，用子会话用户的普通令牌启动固定 exe。</summary>
        private static void RunSystemBootstrap(string dir, string requestPath, string hostSidHint)
        {
            string resultPath = ResultPath(requestPath);
            int pid = 0;
            string message = null;
            try
            {
                LaunchRequest request = ParseLaunchRequest(dir, requestPath);
                VerifyLaunchRequest(request, hostSidHint);
                pid = StartAgent(request);
            }
            catch (Exception e)
            {
                message = SanitizeMessage(e.Message);
                BootstrapLog.Write(dir, "SYSTEM 阶段启动失败: " + message);
            }

            Dictionary<string, string> result = new Dictionary<string, string>();
            BootstrapFile.Set(result, "ok", message == null ? "1" : "0");
            BootstrapFile.SetInt(result, "pid", pid);
            BootstrapFile.Set(result, "completedUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
            if (message != null)
            {
                BootstrapFile.Set(result, "code", "BOOTSTRAP_LAUNCH_FAILED");
                BootstrapFile.Set(result, "message", message);
            }
            try
            {
                BootstrapFile.Write(resultPath, result);
            }
            catch (Exception e)
            {
                BootstrapLog.Write(dir, "写入启动结果失败: " + e.Message);
                if (message == null)
                {
                    message = "写入启动结果失败";
                }
            }
            if (message != null)
            {
                throw new InvalidOperationException("子会话 agent 启动失败: " + message);
            }
        }

        private static int StartAgent(LaunchRequest request)
        {
            BootstrapNative.EnableLaunchPrivileges();
            string childUserSid;
            IntPtr token = BootstrapNative.DuplicateSessionUserToken((uint)request.ChildSessionId, out childUserSid);
            try
            {
                if (!string.Equals(childUserSid, request.HostSid, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("子会话用户与宿主用户不一致");
                }
                BootstrapNative.BindTokenToSession(token, (uint)request.ChildSessionId);
                string arguments = AgentMode
                    + " --pipe " + Quote(request.PipeName)
                    + " --session-id " + request.ChildSessionId.ToString(CultureInfo.InvariantCulture);
                string workingDirectory = Path.GetDirectoryName(request.ExePath);
                BootstrapLog.Write(null, "以子会话普通用户令牌启动 agent session="
                    + request.ChildSessionId.ToString(CultureInfo.InvariantCulture)
                    + " user=" + BootstrapNative.SessionUserName((uint)request.ChildSessionId));
                return BootstrapNative.LaunchInSession(
                    token,
                    request.ExePath,
                    arguments,
                    workingDirectory,
                    (uint)request.ChildSessionId,
                    childUserSid);
            }
            finally
            {
                BootstrapNative.ReleaseHandle(token);
            }
        }

        private sealed class LaunchRequest
        {
            internal int ChildSessionId;
            internal int ParentSessionId;
            internal string PipeName;
            internal string ExePath;
            internal string UserSid;
            internal int HostPid;
            internal long HostStartTicks;
            internal int HostSessionId;
            internal string HostSid;
        }

        private static LaunchRequest ParseLaunchRequest(string dir, string requestPath)
        {
            if (!BootstrapFile.IsDirectChild(dir, requestPath))
            {
                throw new InvalidOperationException("请求文件不在状态目录内");
            }
            if (!File.Exists(requestPath))
            {
                throw new FileNotFoundException("请求文件不存在", requestPath);
            }
            if ((File.GetAttributes(requestPath) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("请求文件是重解析点");
            }
            Dictionary<string, string> map = BootstrapFile.Read(requestPath);
            LaunchRequest request = new LaunchRequest();
            request.ChildSessionId = BootstrapFile.GetInt(map, "childSessionId", 0);
            request.ParentSessionId = BootstrapFile.GetInt(map, "parentSessionId", 0);
            request.PipeName = BootstrapFile.Get(map, "pipe");
            request.ExePath = BootstrapFile.Get(map, "exe");
            request.UserSid = BootstrapFile.Get(map, "userSid");
            request.HostPid = BootstrapFile.GetInt(map, "hostPid", 0);
            request.HostStartTicks = BootstrapFile.GetLong(map, "hostStartTicks", 0);
            request.HostSessionId = BootstrapFile.GetInt(map, "hostSessionId", 0);
            return request;
        }

        private static void VerifyLaunchRequest(LaunchRequest request, string hostSidHint)
        {
            if (request.ChildSessionId < 1 || request.ParentSessionId < 1)
            {
                throw new InvalidOperationException("请求中的会话 ID 无效");
            }
            if (request.ChildSessionId == request.ParentSessionId)
            {
                throw new InvalidOperationException("请求中的 child 与 parent 会话相同");
            }
            if (request.HostSessionId != request.ParentSessionId)
            {
                throw new InvalidOperationException("请求中的宿主会话与 parent 会话不一致");
            }
            if (!IsValidPipeName(request.PipeName))
            {
                throw new InvalidOperationException("请求中的 pipe 名无效");
            }
            if (string.IsNullOrEmpty(request.UserSid))
            {
                throw new InvalidOperationException("请求缺少用户 SID");
            }
            string expectedExe = NormalizeAgentExe(request.ExePath);
            request.ExePath = expectedExe;

            int hostSession;
            long hostStart;
            string hostImage;
            string hostSid;
            BootstrapNative.DescribeProcess(request.HostPid, out hostSession, out hostImage, out hostStart, out hostSid);
            if (hostSession != request.ParentSessionId)
            {
                throw new InvalidOperationException("宿主进程会话与 parent 会话不一致");
            }
            if (!string.Equals(hostImage, expectedExe, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("宿主进程不是同一程序");
            }
            if (Math.Abs(hostStart - request.HostStartTicks) > HostStartToleranceTicks)
            {
                throw new InvalidOperationException("宿主进程启动时间不匹配");
            }
            if (!string.Equals(hostSid, request.UserSid, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("宿主进程用户与请求用户不一致");
            }
            if (!string.IsNullOrEmpty(hostSidHint) && !string.Equals(hostSidHint, hostSid, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("调用方用户与宿主进程用户不一致");
            }

            string parentSid;
            BootstrapNative.QuerySessionUserSid((uint)request.ParentSessionId, out parentSid);
            if (!string.Equals(parentSid, hostSid, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("parent 会话用户与宿主用户不一致");
            }
            if (!BootstrapNative.SessionIsActive((uint)request.ChildSessionId))
            {
                throw new InvalidOperationException("子会话未登录或不在活动状态");
            }
            request.HostSid = hostSid;
        }

        private static string NormalizeAgentExe(string exePath)
        {
            if (string.IsNullOrEmpty(exePath))
            {
                throw new ArgumentException("exePath 不能为空");
            }
            string full;
            try
            {
                full = Path.GetFullPath(exePath);
            }
            catch (Exception)
            {
                throw new ArgumentException("exePath 无效");
            }
            if (!File.Exists(full))
            {
                throw new FileNotFoundException("找不到 agent 可执行文件", full);
            }
            string self = SelfExePath();
            if (!string.Equals(Path.GetDirectoryName(full), Path.GetDirectoryName(self), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("agent 必须是宿主同目录的固定程序");
            }
            if (!string.Equals(Path.GetFileName(full), Path.GetFileName(self), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("agent 必须是宿主自身程序");
            }
            return full;
        }

        private static bool IsValidPipeName(string pipeName)
        {
            return !string.IsNullOrEmpty(pipeName) && Regex.IsMatch(pipeName, "^[A-Za-z0-9._-]{1,200}$");
        }

        /// <summary>
        /// parent 会话阶段（宿主与提权助手）核验目标会话确实是本会话的子会话；
        /// SYSTEM 阶段（会话 0）没有该关系，由请求/宿主 PID 启动时间/SID 校验负责。
        /// </summary>
        private static void VerifyChildSessionForParent(int childSessionId, int parentSessionId)
        {
            if (Process.GetCurrentProcess().SessionId != parentSessionId)
            {
                return;
            }
            BootstrapNative.RequireChildSessionId(childSessionId);
        }

        private static long HostStartTicks(Process process)
        {
            return process.StartTime.ToUniversalTime().Ticks;
        }

        private static string ResultPath(string requestPath)
        {
            return requestPath.Substring(0, requestPath.Length - BootstrapFile.RequestSuffix.Length)
                + BootstrapFile.ResultSuffix;
        }

        private static void DeleteLaunchFiles(string requestPath)
        {
            TryDelete(requestPath);
            TryDelete(ResultPath(requestPath));
        }

        private static void CleanupStaleLaunchFiles(string dir)
        {
            string[] files;
            try
            {
                files = Directory.GetFiles(dir, BootstrapFile.LaunchPrefix + "*");
            }
            catch (Exception)
            {
                return;
            }
            DateTime threshold = DateTime.UtcNow - TimeSpan.FromHours(1);
            for (int i = 0; i < files.Length; i++)
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(files[i]) > threshold)
                    {
                        continue;
                    }
                    File.Delete(files[i]);
                }
                catch (Exception e)
                {
                    BootstrapLog.Write(dir, "清理旧的启动请求失败: " + e.Message);
                }
            }
        }

        private static void RunElevatedSync(string dir, string mode, string arguments, int timeoutMilliseconds)
        {
            ProcessStartInfo info = new ProcessStartInfo(SelfExePath(), mode + " " + arguments);
            info.UseShellExecute = true;
            info.Verb = "runas";
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process helper;
            try
            {
                helper = Process.Start(info);
            }
            catch (Win32Exception e)
            {
                BootstrapLog.Write(dir, mode + " 提权失败: " + e.Message);
                throw new Win32Exception(e.NativeErrorCode, "需要管理员授权: " + e.Message);
            }
            using (helper)
            {
                if (!helper.WaitForExit(timeoutMilliseconds))
                {
                    BootstrapLog.Write(dir, mode + " 提权助手等待超时");
                    throw new TimeoutException("提权助手在超时内未结束");
                }
                BootstrapLog.Write(dir, mode + " 提权助手退出码 "
                    + helper.ExitCode.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static string SanitizeMessage(string message)
        {
            if (message == null)
            {
                return "";
            }
            string flat = message.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
            return flat.Length > 400 ? flat.Substring(0, 400) : flat;
        }

        private static void TryDelete(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
            }
        }

        private static void Usage()
        {
            Console.Error.WriteLine("用法: bootstrap-ensure --state-dir <绝对路径> --host-pid <pid> --host-start <ticks> [--host-sid <sid>]");
            Console.Error.WriteLine("      bootstrap-launch --state-dir <绝对路径> --request <文件>");
            Console.Error.WriteLine("      bootstrap-system --state-dir <绝对路径> --request <文件>");
            Console.Error.WriteLine("      bootstrap-guard --state-dir <绝对路径> --host-pid <pid>");
        }
    }
}
