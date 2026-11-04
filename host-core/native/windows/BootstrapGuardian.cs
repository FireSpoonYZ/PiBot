using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// 记录 EnsureEnabled 改前的系统状态，并在所属宿主退出后把子会话开关与 TermService 恢复原值。
    /// 只恢复自己记录的原值，绝不改 Hello/NLA/防火墙/RDP-Tcp。
    /// </summary>
    internal static class BootstrapGuardian
    {
        private const long HostStartToleranceTicks = 2 * TimeSpan.TicksPerSecond;
        private const int PollMilliseconds = 2000;

        internal sealed class EnableState
        {
            internal int HostPid;
            internal long HostStartTicks;
            internal int ParentSessionId;
            internal bool ChildSessionsBefore;
            internal bool TermServiceBeforeRunning;
            internal bool Applied;
            internal int GuardianPid;
            internal bool GuardianElevated;
            internal int OwnedChildSessionId;
            internal string OwnedUserSid;
            internal string CreatedUtc;
        }

        internal static int Run(string[] args)
        {
            Dictionary<string, string> options = SessionBootstrap.ParseOptions(args, 1);
            string dir;
            try
            {
                dir = BootstrapFile.NormalizeDir(BootstrapFile.Get(options, "state-dir"), false);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("bootstrap-guard: " + e.Message);
                return 2;
            }
            int hostPid = BootstrapFile.GetInt(options, "host-pid", 0);
            if (hostPid <= 0)
            {
                return 2;
            }
            EnableState state = ReadState(dir);
            if (state == null || state.HostPid != hostPid)
            {
                BootstrapLog.Write(dir, "guardian 退出：没有属于宿主 " + hostPid.ToString(CultureInfo.InvariantCulture) + " 的状态记录");
                return 0;
            }
            BootstrapLog.Write(dir, "guardian 监视宿主 pid=" + hostPid.ToString(CultureInfo.InvariantCulture));
            while (HostAlive(state))
            {
                Thread.Sleep(PollMilliseconds);
                EnableState current = ReadState(dir);
                if (current == null || current.HostPid != state.HostPid || current.HostStartTicks != state.HostStartTicks)
                {
                    BootstrapLog.Write(dir, "guardian 退出：状态记录已被替换或已恢复");
                    return 0;
                }
                // 同一宿主可能随后绑定 owned child，必须跟着更新。
                state = current;
                if (state.GuardianElevated && BootstrapNative.IsElevated())
                    SessionBootstrap.ProcessDelegatedLaunches(dir, state);
            }

            // 宿主已退出：再取一次最新同 PID/start 记录，避免读到旧快照。
            EnableState latest = ReadState(dir);
            if (latest != null && latest.HostPid == state.HostPid && latest.HostStartTicks == state.HostStartTicks)
            {
                state = latest;
            }

            if (!CleanupOwnedChild(dir, state))
            {
                BootstrapLog.Write(dir, "归属子会话未能注销，保留 owner 记录待下次清理，本次不改系统设置");
                return 0;
            }
            bool restored = RestoreValues(dir, state.ChildSessionsBefore, state.TermServiceBeforeRunning);
            BootstrapLog.Write(dir, "宿主已退出，恢复结果 restored=" + restored);
            EnableState after = ReadState(dir);
            if (restored && after != null && after.HostPid == state.HostPid && after.HostStartTicks == state.HostStartTicks)
            {
                TryDelete(StatePath(dir));
            }
            return 0;
        }

        internal static string StatePath(string dir)
        {
            return Path.Combine(dir, BootstrapFile.EnableStateName);
        }

        internal static EnableState ReadState(string dir)
        {
            string path = StatePath(dir);
            try
            {
                if (!File.Exists(path))
                {
                    return null;
                }
                Dictionary<string, string> map = BootstrapFile.Read(path);
                EnableState state = new EnableState();
                state.HostPid = BootstrapFile.GetInt(map, "hostPid", 0);
                state.HostStartTicks = BootstrapFile.GetLong(map, "hostStartTicks", 0);
                state.ChildSessionsBefore = BootstrapFile.GetBool(map, "childSessionsBefore", false);
                state.TermServiceBeforeRunning = BootstrapFile.GetBool(map, "termServiceBeforeRunning", false);
                state.Applied = BootstrapFile.GetBool(map, "applied", false);
                state.GuardianPid = BootstrapFile.GetInt(map, "guardianPid", 0);
                state.GuardianElevated = BootstrapFile.GetBool(map, "guardianElevated", false);
                state.ParentSessionId = BootstrapFile.GetInt(map, "parentSessionId", 0);
                state.OwnedChildSessionId = BootstrapFile.GetInt(map, "ownedChildSessionId", 0);
                state.OwnedUserSid = BootstrapFile.Get(map, "ownedUserSid");
                state.CreatedUtc = BootstrapFile.Get(map, "createdUtc");
                if (state.HostPid <= 0 || state.HostStartTicks <= 0)
                {
                    return null;
                }
                return state;
            }
            catch (Exception error)
            {
                BootstrapLog.Write(dir, "读取 owner 状态失败: " + error.GetType().Name);
                return null;
            }
        }

        internal static void WriteState(string dir, EnableState state)
        {
            Dictionary<string, string> map = new Dictionary<string, string>();
            BootstrapFile.Set(map, "version", "1");
            BootstrapFile.SetInt(map, "hostPid", state.HostPid);
            BootstrapFile.SetLong(map, "hostStartTicks", state.HostStartTicks);
            BootstrapFile.Set(map, "childSessionsBefore", state.ChildSessionsBefore ? "1" : "0");
            BootstrapFile.Set(map, "termServiceBeforeRunning", state.TermServiceBeforeRunning ? "1" : "0");
            BootstrapFile.Set(map, "applied", state.Applied ? "1" : "0");
            BootstrapFile.SetInt(map, "guardianPid", state.GuardianPid);
            BootstrapFile.Set(map, "guardianElevated", state.GuardianElevated ? "1" : "0");
            BootstrapFile.SetInt(map, "parentSessionId", state.ParentSessionId);
            BootstrapFile.SetInt(map, "ownedChildSessionId", state.OwnedChildSessionId);
            BootstrapFile.Set(map, "ownedUserSid", state.OwnedUserSid);
            BootstrapFile.Set(map, "createdUtc", state.CreatedUtc);
            BootstrapFile.Write(StatePath(dir), map);
        }

        /// <summary>
        /// 登记（或沿用）本宿主的 owner 基线记录。已启用时也要登记，否则宿主被强杀会遗留子会话。
        /// 同一 host 的记录不覆盖已有基线，避免把已改动状态当成原值。
        /// </summary>
        internal static EnableState EnsureOwnerRecord(string dir, int hostPid, long hostStartTicks, int parentSessionId, bool childSessionsBefore, bool termServiceBeforeRunning)
        {
            EnableState existing = ReadState(dir);
            bool matches = existing != null && existing.HostPid == hostPid && existing.HostStartTicks == hostStartTicks;
            if (existing != null && !matches) throw new Win32Exception(170, "上一宿主的清理尚未完成，保留其原始状态记录");
            EnableState record = matches ? existing : new EnableState();
            if (!matches)
            {
                record.HostPid = hostPid;
                record.HostStartTicks = hostStartTicks;
                record.ChildSessionsBefore = childSessionsBefore;
                record.TermServiceBeforeRunning = termServiceBeforeRunning;
                record.Applied = true;
                record.GuardianPid = 0;
                record.CreatedUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            }
            if (parentSessionId > 0)
            {
                record.ParentSessionId = parentSessionId;
            }
            WriteState(dir, record);
            return record;
        }

        internal static int EnsureGuardian(string dir, EnableState record)
        {
            if (record == null)
            {
                return 0;
            }
            if (GuardianAlive(record.GuardianPid))
            {
                return record.GuardianPid;
            }
            record.GuardianPid = Spawn(dir, record.HostPid, record.HostStartTicks);
            WriteState(dir, record);
            return record.GuardianPid;
        }

        /// <summary>把已核验的 owned child 与宿主用户绑定到同一 owner 记录，guardian 会随读随用。</summary>
        internal static void BindOwnedChild(string dir, int hostPid, long hostStartTicks, int parentSessionId, int childSessionId, string userSid)
        {
            bool childSessionsBefore;
            if (!BootstrapNative.TryIsChildSessionsEnabled(out childSessionsBefore))
            {
                // 读不到原值时不擅自回改全局设置，只当已经启用。
                childSessionsBefore = true;
            }
            bool termServiceBefore = BootstrapNative.TermServiceRunning();
            EnableState record = EnsureOwnerRecord(dir, hostPid, hostStartTicks, parentSessionId, childSessionsBefore, termServiceBefore);
            record.ParentSessionId = parentSessionId;
            record.OwnedChildSessionId = childSessionId;
            record.OwnedUserSid = userSid;
            WriteState(dir, record);
            EnsureGuardian(dir, record);
            BootstrapLog.Write(dir, "绑定归属子会话 " + childSessionId.ToString(CultureInfo.InvariantCulture) + " 到宿主 " + hostPid.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 宿主退出后只注销记录里的 owned child：要求仍是本会话的子会话、且子/parent 会话用户都等于记录用户；
        /// 普通权限 guardian 不用 WTSQueryUserToken，改用会话用户名翻译 SID。
        /// </summary>
        private static bool CleanupOwnedChild(string dir, EnableState state)
        {
            if (state.OwnedChildSessionId <= 0)
            {
                return true;
            }
            uint child = (uint)state.OwnedChildSessionId;
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture) + "：SessionLoggedOn 开始");
            bool loggedOn = BootstrapNative.SessionLoggedOn(child);
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture)
                + "：SessionLoggedOn 结束 loggedOn=" + loggedOn);
            if (!loggedOn)
            {
                BootstrapLog.Write(dir, "归属子会话 " + state.OwnedChildSessionId.ToString(CultureInfo.InvariantCulture) + " 已不在登录态，无需注销");
                return true;
            }
            if (string.IsNullOrEmpty(state.OwnedUserSid) || state.ParentSessionId <= 0)
            {
                BootstrapLog.Write(dir, "owner 记录缺少用户/父会话信息，拒绝注销会话");
                return false;
            }
            if (Process.GetCurrentProcess().SessionId != state.ParentSessionId)
            {
                BootstrapLog.Write(dir, "guardian 不在 parent 会话，无法核验归属，拒绝注销会话");
                return false;
            }
            uint actualChild;
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture) + "：TryGetChildSessionId 开始");
            bool gotChild = BootstrapNative.TryGetChildSessionId(out actualChild);
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture)
                + "：TryGetChildSessionId 结束 ok=" + gotChild + " actual=" + actualChild.ToString(CultureInfo.InvariantCulture));
            if (!gotChild || actualChild != child)
            {
                BootstrapLog.Write(dir, "当前子会话与记录不一致(记录=" + child.ToString(CultureInfo.InvariantCulture)
                    + " 实际=" + actualChild.ToString(CultureInfo.InvariantCulture) + ")，拒绝注销会话");
                return false;
            }
            string childUserSid;
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture) + "：TrySessionUserSid(child) 开始");
            bool childSidOk = BootstrapNative.TrySessionUserSid(child, out childUserSid);
            BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture)
                + "：TrySessionUserSid(child) 结束 ok=" + childSidOk);
            string parentUserSid = null;
            bool parentSidOk = false;
            if (childSidOk)
            {
                BootstrapLog.Write(dir, "归属清理 parent=" + state.ParentSessionId.ToString(CultureInfo.InvariantCulture)
                    + "：TrySessionUserSid(parent) 开始");
                parentSidOk = BootstrapNative.TrySessionUserSid((uint)state.ParentSessionId, out parentUserSid);
                BootstrapLog.Write(dir, "归属清理 parent=" + state.ParentSessionId.ToString(CultureInfo.InvariantCulture)
                    + "：TrySessionUserSid(parent) 结束 ok=" + parentSidOk);
            }
            if (!childSidOk || !parentSidOk)
            {
                BootstrapLog.Write(dir, "无法读取子会话/parent 会话用户，拒绝注销会话");
                return false;
            }
            if (!string.Equals(childUserSid, state.OwnedUserSid, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(parentUserSid, state.OwnedUserSid, StringComparison.OrdinalIgnoreCase))
            {
                BootstrapLog.Write(dir, "子会话/parent 会话用户与记录不一致，拒绝注销他人会话");
                return false;
            }

            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture)
                        + "：LogoffSession 开始 attempt=" + (attempt + 1).ToString(CultureInfo.InvariantCulture));
                    BootstrapNative.LogoffSession(child);
                    BootstrapLog.Write(dir, "归属清理 session=" + child.ToString(CultureInfo.InvariantCulture) + "：LogoffSession 返回");
                }
                catch (Exception e)
                {
                    BootstrapLog.Write(dir, "注销归属子会话失败: " + e.Message);
                }
                for (int wait = 0; wait < 20; wait++)
                {
                    Thread.Sleep(500);
                    if (!BootstrapNative.SessionLoggedOn(child))
                    {
                        BootstrapLog.Write(dir, "已注销归属子会话 " + child.ToString(CultureInfo.InvariantCulture));
                        return true;
                    }
                }
            }
            BootstrapLog.Write(dir, "归属子会话 " + child.ToString(CultureInfo.InvariantCulture) + " 未能在限定时间内注销");
            return false;
        }

        /// <summary>复用授权须匹配宿主身份、已生效状态和提权 guardian。</summary>
        internal static bool IsReadyForHost(string dir, int hostPid, long hostStartTicks)
        {
            EnableState state = ReadState(dir);
            string reason;
            if (state == null) reason = "owner-missing-or-unreadable";
            else if (state.HostPid != hostPid || state.HostStartTicks != hostStartTicks) reason = "owner-mismatch";
            else if (!state.Applied) reason = "not-applied";
            else if (!state.GuardianElevated) reason = "guardian-not-elevated";
            else if (!GuardianAlive(state.GuardianPid)) reason = "guardian-not-alive";
            else reason = "ready";
            BootstrapLog.Write(dir, "授权复用检查 host=" + hostPid.ToString(CultureInfo.InvariantCulture)
                + " start=" + hostStartTicks.ToString(CultureInfo.InvariantCulture)
                + " owner=" + (state == null ? "none" : state.HostPid.ToString(CultureInfo.InvariantCulture))
                + " ownerStart=" + (state == null ? "none" : state.HostStartTicks.ToString(CultureInfo.InvariantCulture))
                + " guardian=" + (state == null ? "none" : state.GuardianPid.ToString(CultureInfo.InvariantCulture))
                + " result=" + reason);
            return reason == "ready";
        }

        internal static void DeleteState(string dir)
        {
            TryDelete(StatePath(dir));
        }

        /// <summary>上一次宿主异常退出留下未恢复的基线时，先注销它记录的 child 再恢复，避免把已改动状态当成新基线。</summary>
        internal static void RestoreAbandoned(string dir)
        {
            EnableState state = ReadState(dir);
            if (state == null || HostAlive(state))
            {
                return;
            }
            BootstrapLog.Write(dir, "发现已退出宿主遗留的启用状态，先清理并恢复原值");
            if (!CleanupOwnedChild(dir, state))
            {
                BootstrapLog.Write(dir, "遗留归属子会话未能注销，保留记录且不改系统设置");
                return;
            }
            bool restored = RestoreValues(dir, state.ChildSessionsBefore, state.TermServiceBeforeRunning);
            if (restored)
            {
                TryDelete(StatePath(dir));
            }
            else
            {
                BootstrapLog.Write(dir, "遗留状态恢复失败，保留记录作为基线");
            }
        }

        internal static bool RestoreValues(string dir, bool childSessionsBefore, bool termServiceBeforeRunning)
        {
            bool ok = true;
            if (!childSessionsBefore)
            {
                bool restored = false;
                for (int attempt = 0; attempt < 3 && !restored; attempt++)
                {
                    try
                    {
                        bool current;
                        if (!BootstrapNative.TryIsChildSessionsEnabled(out current))
                        {
                            Thread.Sleep(1000);
                            continue;
                        }
                        if (!current)
                        {
                            restored = true;
                            break;
                        }
                        BootstrapNative.SetChildSessionsEnabled(false);
                        bool after;
                        restored = BootstrapNative.TryIsChildSessionsEnabled(out after) && !after;
                    }
                    catch (Exception e)
                    {
                        BootstrapLog.Write(dir, "恢复子会话开关失败: " + e.Message);
                    }
                    if (!restored)
                    {
                        Thread.Sleep(1000);
                    }
                }
                if (!restored)
                {
                    ok = false;
                    BootstrapLog.Write(dir, "子会话开关未能恢复为 false");
                }
            }
            if (!termServiceBeforeRunning)
            {
                try
                {
                    if (!BootstrapNative.TryStopTermService(TimeSpan.FromSeconds(30)))
                    {
                        ok = false;
                        BootstrapLog.Write(dir, "TermService 未能恢复为 Stopped");
                    }
                }
                catch (Exception e)
                {
                    ok = false;
                    BootstrapLog.Write(dir, "恢复 TermService 失败: " + e.Message);
                }
            }
            return ok;
        }

        internal static bool GuardianAlive(int pid)
        {
            if (pid <= 0)
            {
                return false;
            }
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    return !process.HasExited;
                }
            }
            catch (Win32Exception)
            {
                // 普通宿主可能无法查询提权 guardian，不能据此启动第二个恢复者。
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal static int Spawn(string dir, int hostPid, long hostStartTicks)
        {
            string exe = SessionBootstrap.SelfExePath();
            string arguments = "bootstrap-guard --state-dir " + SessionBootstrap.Quote(dir)
                + " --host-pid " + hostPid.ToString(CultureInfo.InvariantCulture);
            ProcessStartInfo info = new ProcessStartInfo(exe, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.WorkingDirectory = Path.GetDirectoryName(exe);
            Process guardian = Process.Start(info);
            int pid = guardian.Id;
            guardian.Dispose();
            BootstrapLog.Write(dir, "已启动 guardian pid=" + pid.ToString(CultureInfo.InvariantCulture)
                + " 监视宿主 " + hostPid.ToString(CultureInfo.InvariantCulture)
                + "(start=" + hostStartTicks.ToString(CultureInfo.InvariantCulture) + ")");
            return pid;
        }

        private static bool HostAlive(EnableState state)
        {
            try
            {
                using (Process process = Process.GetProcessById(state.HostPid))
                {
                    long start = process.StartTime.ToUniversalTime().Ticks;
                    return Math.Abs(start - state.HostStartTicks) <= HostStartToleranceTicks;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
            catch (Win32Exception)
            {
                return false;
            }
        }

        private static void TryDelete(string path)
        {
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
    }
}
