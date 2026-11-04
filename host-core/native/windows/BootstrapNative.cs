using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using TimeoutException = System.TimeoutException;
using System.Text;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// bootstrap 自用状态/请求文件：本模块自己写、自己读的 key=value，不解析外部 JSON，
    /// 也不接受外部提供的路径内容，避免把不可信输入当命令。
    /// </summary>
    internal static class BootstrapFile
    {
        internal const string EnableStateName = "bootstrap-enable-state.ini";
        internal const string LogName = "bootstrap.log";
        internal const string LaunchPrefix = "bootstrap-launch-";
        internal const string TaskPrefix = "bootstrap-task-";
        internal const string RequestSuffix = ".ini";
        internal const string ResultSuffix = ".result.ini";

        internal static Dictionary<string, string> Read(string path)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string[] lines = File.ReadAllLines(path, Encoding.UTF8);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0 || line[0] == '#')
                {
                    continue;
                }
                int separator = line.IndexOf('=');
                if (separator <= 0)
                {
                    continue;
                }
                map[line.Substring(0, separator).Trim()] = line.Substring(separator + 1).Trim();
            }
            return map;
        }

        internal static void Write(string path, IDictionary<string, string> map)
        {
            StringBuilder text = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in map)
            {
                text.Append(pair.Key);
                text.Append('=');
                text.Append(pair.Value);
                text.Append("\r\n");
            }
            WriteAtomic(path, text.ToString());
        }

        internal static void WriteAtomic(string path, string text)
        {
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, text, Encoding.UTF8);
            if (File.Exists(path))
            {
                try
                {
                    File.Replace(temporary, path, null);
                    return;
                }
                catch (IOException)
                {
                }
                catch (PlatformNotSupportedException)
                {
                }
                File.Delete(path);
            }
            File.Move(temporary, path);
        }

        internal static string Get(IDictionary<string, string> map, string key)
        {
            string value;
            return map.TryGetValue(key, out value) ? value : null;
        }

        internal static int GetInt(IDictionary<string, string> map, string key, int fallback)
        {
            int value;
            string text = Get(map, key);
            return text != null && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        internal static long GetLong(IDictionary<string, string> map, string key, long fallback)
        {
            long value;
            string text = Get(map, key);
            return text != null && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        internal static bool GetBool(IDictionary<string, string> map, string key, bool fallback)
        {
            string text = Get(map, key);
            if (text == null)
            {
                return fallback;
            }
            return text == "1" || string.Equals(text, "true", StringComparison.OrdinalIgnoreCase);
        }

        internal static void Set(IDictionary<string, string> map, string key, string value)
        {
            map[key] = value == null ? "" : value;
        }

        internal static void SetInt(IDictionary<string, string> map, string key, int value)
        {
            map[key] = value.ToString(CultureInfo.InvariantCulture);
        }

        internal static void SetLong(IDictionary<string, string> map, string key, long value)
        {
            map[key] = value.ToString(CultureInfo.InvariantCulture);
        }

        internal static string NormalizeDir(string dir, bool create)
        {
            if (string.IsNullOrEmpty(dir) || !Path.IsPathRooted(dir))
            {
                throw new ArgumentException("state-dir 必须是绝对路径");
            }
            string full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (create && !Directory.Exists(full))
            {
                Directory.CreateDirectory(full);
            }
            if (!Directory.Exists(full))
            {
                throw new DirectoryNotFoundException("状态目录不存在: " + full);
            }
            return full;
        }

        /// <summary>只接受状态目录的直接子文件，禁止子目录或目录外路径。</summary>
        internal static bool IsDirectChild(string dir, string file)
        {
            if (string.IsNullOrEmpty(dir) || string.IsNullOrEmpty(file) || !Path.IsPathRooted(file))
            {
                return false;
            }
            string parent;
            try
            {
                parent = Path.GetDirectoryName(Path.GetFullPath(file));
            }
            catch (Exception)
            {
                return false;
            }
            if (parent == null)
            {
                return false;
            }
            string expected = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string actual = parent.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class BootstrapLog
    {
        private const long MaxBytes = 512 * 1024;

        internal static void Write(string stateDir, string message)
        {
            string line = DateTime.Now.ToString("o", CultureInfo.InvariantCulture)
                + " pid=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                + " " + message;
            try
            {
                Console.Error.WriteLine(line);
            }
            catch (Exception)
            {
            }
            if (string.IsNullOrEmpty(stateDir))
            {
                return;
            }
            try
            {
                string path = Path.Combine(stateDir, BootstrapFile.LogName);
                FileInfo info = new FileInfo(path);
                if (info.Exists && info.Length > MaxBytes)
                {
                    string previous = path + ".1";
                    if (File.Exists(previous))
                    {
                        File.Delete(previous);
                    }
                    File.Move(path, previous);
                }
                File.AppendAllText(path, line + "\r\n", Encoding.UTF8);
            }
            catch (Exception)
            {
            }
        }
    }

    /// <summary>Win32/WTS 封装：令牌、会话、TermService、子会话开关。</summary>
    internal static class BootstrapNative
    {
        internal const uint MaximumAllowed = 0x02000000;
        internal const uint ProcessQueryLimitedInformation = 0x1000;
        internal const uint CreateUnicodeEnvironment = 0x00000400;
        internal const uint CreateNoWindow = 0x08000000;

        private const uint TokenQuery = 0x0008;
        private const int TokenUserClass = 1;
        private const int TokenSessionIdClass = 12;
        private const int TokenLinkedTokenClass = 19;
        private const int TokenElevationClass = 20;
        private const int SecurityImpersonation = 2;
        private const int TokenPrimary = 1;
        private const uint SePrivilegeEnabled = 0x00000002;
        private const int WtsUserNameClass = 5;
        private const int WtsDomainNameClass = 7;
        private const int WtsConnectStateClass = 8;
        private const int WtsActiveState = 0;
        private const int WtsDisconnectedState = 4;
        private const int StartfUseShowWindow = 0x1;
        private const int ErrorNotAllAssigned = 1300;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Luid
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LuidAndAttributes
        {
            public Luid Luid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TokenPrivileges
        {
            public uint PrivilegeCount;
            public LuidAndAttributes Privileges;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returnedLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges newState, int bufferLength, IntPtr previousState, IntPtr returnLength);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUser(
            IntPtr token,
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool DestroyEnvironmentBlock(IntPtr environment);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSIsChildSessionsEnabled(out bool enabled);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSEnableChildSessions(bool enable);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSGetChildSessionId(out uint sessionId);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSLogoffSession(IntPtr server, uint sessionId, bool wait);

        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytesReturned);

        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr memory);

        internal static bool IsSystem()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            return identity.User != null && identity.User.IsWellKnown(WellKnownSidType.LocalSystemSid);
        }

        internal static bool IsElevated()
        {
            return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        }

        internal static string CurrentUserSid()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            if (identity.User == null)
            {
                throw new InvalidOperationException("无法读取当前用户 SID");
            }
            return identity.User.Value;
        }

        /// <summary>
        /// 能启用 SeTcbPrivilege 才说明本进程可直接执行 SYSTEM 阶段（宿主本身以 SYSTEM 运行）。
        /// 普通提权管理员令牌不具备该特权，依赖计划任务跳板，这是实测 1314 的根因。
        /// </summary>
        internal static bool CanActAsSystem()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcessHandle(), TokenQuery | 0x0020 /*TOKEN_ADJUST_PRIVILEGES*/, out token))
            {
                return false;
            }
            try
            {
                return EnablePrivilege(token, "SeTcbPrivilege");
            }
            finally
            {
                CloseHandle(token);
            }
        }

        /// <summary>SYSTEM/管理员令牌上的必需特权；失败直接抛出，避免带着 1314 继续。</summary>
        internal static void EnableLaunchPrivileges()
        {
            string[] names = new string[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" };
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcessHandle(), TokenQuery | 0x0020, out token))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "打开本进程令牌失败");
            }
            try
            {
                for (int i = 0; i < names.Length; i++)
                {
                    int error = 0;
                    if (!EnablePrivilege(token, names[i], out error))
                    {
                        throw new Win32Exception(error, "启用特权失败: " + names[i]);
                    }
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }

        private static IntPtr GetCurrentProcessHandle()
        {
            return new IntPtr(-1);
        }

        private static bool EnablePrivilege(IntPtr token, string name)
        {
            int error;
            return EnablePrivilege(token, name, out error);
        }

        private static bool EnablePrivilege(IntPtr token, string name, out int error)
        {
            error = 0;
            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            TokenPrivileges privileges = new TokenPrivileges();
            privileges.PrivilegeCount = 1;
            privileges.Privileges = new LuidAndAttributes();
            privileges.Privileges.Luid = luid;
            privileges.Privileges.Attributes = SePrivilegeEnabled;
            if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            // AdjustTokenPrivileges 成功但未全部指派时 last error = ERROR_NOT_ALL_ASSIGNED
            int last = Marshal.GetLastWin32Error();
            if (last == ErrorNotAllAssigned)
            {
                error = last;
                return false;
            }
            return true;
        }

        internal static string TokenSid(IntPtr token)
        {
            int needed = 0;
            GetTokenInformation(token, TokenUserClass, IntPtr.Zero, 0, out needed);
            if (needed <= 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "查询令牌用户失败");
            }
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, TokenUserClass, buffer, needed, out needed))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "查询令牌用户失败");
                }
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                return new SecurityIdentifier(sid).Value;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        internal static bool TryTokenSid(IntPtr processHandle, out string sid)
        {
            sid = null;
            IntPtr token;
            if (!OpenProcessToken(processHandle, TokenQuery, out token))
            {
                return false;
            }
            try
            {
                sid = TokenSid(token);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                CloseHandle(token);
            }
        }

        private static bool TryGetLinkedToken(IntPtr token, out IntPtr linked)
        {
            linked = IntPtr.Zero;
            int size = IntPtr.Size + 8;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int needed;
                if (!GetTokenInformation(token, TokenLinkedTokenClass, buffer, size, out needed))
                {
                    return false;
                }
                linked = Marshal.ReadIntPtr(buffer);
                return linked != IntPtr.Zero;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool TokenIsElevated(IntPtr token)
        {
            IntPtr buffer = Marshal.AllocHGlobal(4);
            try
            {
                int needed;
                if (!GetTokenInformation(token, TokenElevationClass, buffer, 4, out needed))
                {
                    // 查不到提权状态就不能冒充“普通令牌”，必须向上报错。
                    int error = Marshal.GetLastWin32Error();
                    throw new Win32Exception(error, "查询令牌提权状态失败 (Win32=" + error + ", needed=" + needed + ")");
                }
                return Marshal.ReadInt32(buffer) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>
        /// WTSQueryUserToken 需要 SeTcbPrivilege（只有 SYSTEM 具备）；提权令牌只能靠受限链接令牌降权，
        /// 拿不到非提权令牌就明确失败，绝不把提权 agent 放进子会话。
        /// </summary>
        internal static IntPtr DuplicateSessionUserToken(uint sessionId, out string userSid)
        {
            IntPtr impersonation;
            if (!WTSQueryUserToken(sessionId, out impersonation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSQueryUserToken 失败(session=" + sessionId.ToString(CultureInfo.InvariantCulture) + ")");
            }
            IntPtr linked = IntPtr.Zero;
            try
            {
                userSid = TokenSid(impersonation);
                IntPtr source = impersonation;
                if (TokenIsElevated(impersonation))
                {
                    if (!TryGetLinkedToken(impersonation, out linked) || linked == IntPtr.Zero)
                    {
                        throw new InvalidOperationException("子会话用户令牌是提权令牌且没有受限链接令牌，无法按普通权限启动 agent");
                    }
                    if (TokenIsElevated(linked))
                    {
                        throw new InvalidOperationException("子会话用户的链接令牌仍是提权令牌，无法按普通权限启动 agent");
                    }
                    source = linked;
                }
                if (TokenIsElevated(source))
                {
                    throw new InvalidOperationException("无法取得子会话用户的非提权令牌");
                }
                IntPtr primary;
                if (!DuplicateTokenEx(source, MaximumAllowed, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "复制子会话用户令牌失败");
                }
                try
                {
                    if (TokenIsElevated(primary))
                    {
                        throw new InvalidOperationException("复制出的 agent 令牌仍是提权令牌");
                    }
                }
                catch (Exception)
                {
                    ReleaseHandle(primary);
                    throw;
                }
                return primary;
            }
            finally
            {
                CloseHandle(impersonation);
                if (linked != IntPtr.Zero)
                {
                    CloseHandle(linked);
                }
            }
        }

        /// <summary>parent 会话阶段核验：目标会话必须真的是本会话的子会话，不接受同 user 的任意 session。</summary>
        internal static void RequireChildSessionId(int expectedChildSessionId)
        {
            uint actual;
            if (!WTSGetChildSessionId(out actual))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSGetChildSessionId 失败");
            }
            if (actual != (uint)expectedChildSessionId)
            {
                throw new InvalidOperationException("目标会话 " + expectedChildSessionId.ToString(CultureInfo.InvariantCulture)
                    + " 不是本会话的子会话(实际=" + actual.ToString(CultureInfo.InvariantCulture) + ")");
            }
        }

        internal static bool TryGetChildSessionId(out uint sessionId)
        {
            uint value;
            bool ok = WTSGetChildSessionId(out value);
            sessionId = value;
            return ok;
        }

        /// <summary>会话处于登录态（Active/Disconnected 且已登录用户），用于注销前后的核验。</summary>
        internal static bool SessionLoggedOn(uint sessionId)
        {
            IntPtr buffer;
            uint bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WtsConnectStateClass, out buffer, out bytes))
            {
                return false;
            }
            int state;
            try
            {
                state = Marshal.ReadInt32(buffer);
            }
            finally
            {
                WTSFreeMemory(buffer);
            }
            if (state != WtsActiveState && state != WtsDisconnectedState)
            {
                return false;
            }
            return !string.IsNullOrEmpty(SessionUserName(sessionId));
        }

        /// <summary>
        /// 不依赖 WTSQueryUserToken（需要 SYSTEM）拿会话用户 SID：会话用户名 + NTAccount 翻译。
        /// </summary>
        internal static bool TrySessionUserSid(uint sessionId, out string sid)
        {
            sid = null;
            string account = SessionUserName(sessionId);
            if (string.IsNullOrEmpty(account))
            {
                return false;
            }
            try
            {
                SecurityIdentifier identifier = (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
                sid = identifier.Value;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>只发起注销（wait:false），同步等待可能无界阻塞；完成由调用方的 SessionLoggedOn 轮询确认。</summary>
        internal static void LogoffSession(uint sessionId)
        {
            if (!WTSLogoffSession(IntPtr.Zero, sessionId, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSLogoffSession 失败(session=" + sessionId.ToString(CultureInfo.InvariantCulture) + ")");
            }
        }

        internal static void BindTokenToSession(IntPtr primary, uint sessionId)
        {
            uint value = sessionId;
            if (!SetTokenInformation(primary, TokenSessionIdClass, ref value, 4))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "设置令牌会话失败");
            }
            IntPtr buffer = Marshal.AllocHGlobal(8);
            try
            {
                int needed;
                int actual = -1;
                if (GetTokenInformation(primary, TokenSessionIdClass, buffer, 8, out needed))
                {
                    actual = Marshal.ReadInt32(buffer);
                }
                if (actual != (int)sessionId)
                {
                    throw new InvalidOperationException("令牌会话读回不一致(实际=" + actual.ToString(CultureInfo.InvariantCulture) + ")");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>
        /// 用给定令牌在 winsta0\\default 启动固定程序，并核验新进程的会话与用户；
        /// 不一致立即终止，绝不把未核验的进程留在机器上。
        /// </summary>
        internal static int LaunchInSession(IntPtr token, string exePath, string arguments, string workingDirectory, uint sessionId, string expectedUserSid)
        {
            // 环境块失败就报错，绝不静默继承 SYSTEM 的环境。
            IntPtr environment;
            if (!CreateEnvironmentBlock(out environment, token, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "创建子会话用户环境块失败");
            }
            StartupInfo startupInfo = new StartupInfo();
            startupInfo.cb = Marshal.SizeOf(typeof(StartupInfo));
            startupInfo.lpDesktop = "winsta0\\default";
            startupInfo.dwFlags = StartfUseShowWindow;
            startupInfo.wShowWindow = 0;
            StringBuilder commandLine = new StringBuilder("\"" + exePath + "\" " + arguments, 1024);
            ProcessInformation processInformation;
            bool created = CreateProcessAsUser(
                token,
                exePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CreateUnicodeEnvironment | CreateNoWindow,
                environment,
                workingDirectory,
                ref startupInfo,
                out processInformation);
            int error = Marshal.GetLastWin32Error();
            if (environment != IntPtr.Zero)
            {
                DestroyEnvironmentBlock(environment);
            }
            if (!created)
            {
                throw new Win32Exception(error, "CreateProcessAsUser 失败(1314=缺少令牌权限)");
            }
            try
            {
                int actualSession = -1;
                try
                {
                    using (Process child = Process.GetProcessById(processInformation.dwProcessId))
                    {
                        actualSession = child.SessionId;
                    }
                }
                catch (Exception)
                {
                }
                string sid;
                bool hasSid = TryTokenSid(processInformation.hProcess, out sid);
                if (actualSession != (int)sessionId || !hasSid || !string.Equals(sid, expectedUserSid, StringComparison.OrdinalIgnoreCase))
                {
                    TerminateProcess(processInformation.hProcess, 1);
                    throw new InvalidOperationException("agent 会话/用户核验失败(session=" + actualSession.ToString(CultureInfo.InvariantCulture) + ")");
                }
                return processInformation.dwProcessId;
            }
            finally
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
        }

        internal static void QuerySessionUserSid(uint sessionId, out string userSid)
        {
            IntPtr token;
            if (!WTSQueryUserToken(sessionId, out token))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSQueryUserToken 失败(session=" + sessionId.ToString(CultureInfo.InvariantCulture) + ")");
            }
            try
            {
                userSid = TokenSid(token);
            }
            finally
            {
                CloseHandle(token);
            }
        }

        internal static bool SessionIsActive(uint sessionId)
        {
            IntPtr buffer;
            uint bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WtsConnectStateClass, out buffer, out bytes))
            {
                return false;
            }
            try
            {
                return Marshal.ReadInt32(buffer) == WtsActiveState;
            }
            finally
            {
                WTSFreeMemory(buffer);
            }
        }

        internal static string SessionUserName(uint sessionId)
        {
            string user = QuerySessionString(sessionId, WtsUserNameClass);
            string domain = QuerySessionString(sessionId, WtsDomainNameClass);
            if (string.IsNullOrEmpty(user))
            {
                return "";
            }
            return string.IsNullOrEmpty(domain) ? user : domain + "\\" + user;
        }

        private static string QuerySessionString(uint sessionId, int infoClass)
        {
            IntPtr buffer;
            uint bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buffer, out bytes))
            {
                return "";
            }
            try
            {
                return Marshal.PtrToStringUni(buffer) ?? "";
            }
            finally
            {
                WTSFreeMemory(buffer);
            }
        }

        /// <summary>一次取齐宿主进程的会话、路径、启动时间与用户，用于 parent/user 归属核验。</summary>
        internal static void DescribeProcess(int pid, out int sessionId, out string imagePath, out long startTicks, out string userSid)
        {
            Process process;
            try
            {
                process = Process.GetProcessById(pid);
            }
            catch (ArgumentException e)
            {
                throw new InvalidOperationException("宿主进程 " + pid.ToString(CultureInfo.InvariantCulture) + " 不存在或已退出", e);
            }
            using (process)
            {
                sessionId = process.SessionId;
                startTicks = process.StartTime.ToUniversalTime().Ticks;
                string path;
                try
                {
                    path = process.MainModule.FileName;
                }
                catch (Win32Exception e)
                {
                    throw new Win32Exception(e.NativeErrorCode, "读取宿主进程路径失败: " + e.Message);
                }
                imagePath = Path.GetFullPath(path);
                userSid = ProcessTokenSid(pid);
            }
        }

        private static string ProcessTokenSid(int pid)
        {
            IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "打开宿主进程失败");
            }
            try
            {
                string sid;
                if (!TryTokenSid(handle, out sid))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "读取宿主进程令牌失败");
                }
                return sid;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        internal static bool TryIsChildSessionsEnabled(out bool enabled)
        {
            bool value;
            bool ok = WTSIsChildSessionsEnabled(out value);
            enabled = value;
            return ok;
        }

        internal static void SetChildSessionsEnabled(bool enabled)
        {
            if (!WTSEnableChildSessions(enabled))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSEnableChildSessions(" + enabled + ") 失败");
            }
        }

        internal static bool TermServiceRunning()
        {
            try
            {
                using (ServiceController controller = new ServiceController("TermService"))
                {
                    return controller.Status == ServiceControllerStatus.Running;
                }
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        internal static void StartTermService()
        {
            using (ServiceController controller = new ServiceController("TermService"))
            {
                controller.Refresh();
                if (controller.Status != ServiceControllerStatus.Running)
                {
                    controller.Start();
                }
                controller.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            }
        }

        internal static bool TryStopTermService(TimeSpan timeout)
        {
            using (ServiceController controller = new ServiceController("TermService"))
            {
                controller.Refresh();
                if (controller.Status == ServiceControllerStatus.Stopped)
                {
                    return true;
                }
                controller.Stop();
                try
                {
                    controller.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
                }
                catch (System.ServiceProcess.TimeoutException)
                {
                    return false;
                }
                return true;
            }
        }

        internal static void ReleaseHandle(IntPtr handle)
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
            }
        }

        /// <summary>状态目录只允许当前用户与 SYSTEM（可附加宿主用户），去掉继承来的宽权限。</summary>
        internal static void EnsureStateDirAcl(string dir, string extraUserSid)
        {
            DirectoryInfo info = new DirectoryInfo(dir);
            if (!info.Exists)
            {
                info.Create();
            }
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            List<SecurityIdentifier> identities = new List<SecurityIdentifier>();
            identities.Add(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
            WindowsIdentity current = WindowsIdentity.GetCurrent();
            if (current.User != null)
            {
                identities.Add(current.User);
            }
            if (!string.IsNullOrEmpty(extraUserSid))
            {
                identities.Add(new SecurityIdentifier(extraUserSid));
            }
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            for (int i = 0; i < identities.Count; i++)
            {
                security.AddAccessRule(new FileSystemAccessRule(
                    identities[i],
                    FileSystemRights.FullControl,
                    inheritance,
                    PropagationFlags.None,
                    AccessControlType.Allow));
            }
            info.SetAccessControl(security);
        }
    }

    /// <summary>
    /// 一次性 SYSTEM 计划任务：提权助手登记 → 任务立即运行一次 → 助手删除任务。
    /// 只登记本模块命名的任务，绝不触碰其它任务。
    /// </summary>
    internal static class BootstrapTask
    {
        private const string Prefix = "ELauncherShowerBootstrap-";

        internal static string NewName()
        {
            return Prefix + Guid.NewGuid().ToString("N").Substring(0, 12);
        }

        internal static bool IsOwnedName(string name)
        {
            return !string.IsNullOrEmpty(name) && name.StartsWith(Prefix, StringComparison.Ordinal);
        }

        internal static void RegisterAndRun(string taskName, string exePath, string arguments, string workingDirectory)
        {
            if (!IsOwnedName(taskName))
            {
                throw new ArgumentException("任务名必须由本模块生成");
            }
            RunStaThread(delegate { RegisterCore(taskName, exePath, arguments, workingDirectory); });
        }

        internal static void Delete(string taskName)
        {
            if (!IsOwnedName(taskName))
            {
                return;
            }
            try
            {
                RunStaThread(delegate { DeleteCore(taskName); });
            }
            catch (Exception e)
            {
                BootstrapLog.Write(null, "删除临时计划任务失败 " + taskName + ": " + e.Message);
            }
        }

        /// <summary>只清理本模块标记文件对应、且已超时的任务，避免残留永久特权入口。</summary>
        internal static void CleanupStale(string stateDir, TimeSpan minimumAge)
        {
            string[] files;
            try
            {
                files = Directory.GetFiles(stateDir, BootstrapFile.TaskPrefix + "*.ini");
            }
            catch (Exception)
            {
                return;
            }
            DateTime threshold = DateTime.UtcNow - minimumAge;
            for (int i = 0; i < files.Length; i++)
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(files[i]) > threshold)
                    {
                        continue;
                    }
                    string name = Path.GetFileNameWithoutExtension(files[i]);
                    string taskName = name.Substring(BootstrapFile.TaskPrefix.Length);
                    if (!IsOwnedName(taskName))
                    {
                        continue;
                    }
                    Delete(taskName);
                    File.Delete(files[i]);
                }
                catch (Exception e)
                {
                    BootstrapLog.Write(stateDir, "清理临时任务标记失败: " + e.Message);
                }
            }
        }

        private static void RegisterCore(string taskName, string exePath, string arguments, string workingDirectory)
        {
            object service = null;
            object folder = null;
            object definition = null;
            object registered = null;
            try
            {
                service = Connect();
                folder = Invoke(service, "GetFolder", new object[] { "\\" });
                definition = Invoke(service, "NewTask", new object[] { 0 });

                object registrationInfo = Get(definition, "RegistrationInfo");
                Set(registrationInfo, "Author", "ELauncher Shower");
                Set(registrationInfo, "Description", "一次性 SYSTEM bootstrap，运行后立即删除");

                object principal = Get(definition, "Principal");
                Set(principal, "UserId", "SYSTEM");
                Set(principal, "LogonType", 5);
                Set(principal, "RunLevel", 1);

                object settings = Get(definition, "Settings");
                Set(settings, "Enabled", true);
                Set(settings, "AllowDemandStart", true);
                Set(settings, "MultipleInstances", 2);
                Set(settings, "ExecutionTimeLimit", "PT1M");
                Set(settings, "DisallowStartIfOnBatteries", false);
                Set(settings, "StopIfGoingOnBatteries", false);
                Set(settings, "StartWhenAvailable", false);
                Set(settings, "RunOnlyIfIdle", false);
                Set(settings, "Hidden", true);

                object actions = Get(definition, "Actions");
                object action = Invoke(actions, "Create", new object[] { 0 });
                Set(action, "Path", exePath);
                Set(action, "Arguments", arguments);
                Set(action, "WorkingDirectory", workingDirectory);

                registered = Invoke(folder, "RegisterTaskDefinition", new object[] { taskName, definition, 6, null, null, 5, null });
                Invoke(registered, "Run", new object[] { null });
                BootstrapLog.Write(null, "已登记并运行一次性 SYSTEM 任务 " + taskName);
            }
            finally
            {
                Release(registered);
                Release(definition);
                Release(folder);
                Release(service);
            }
        }

        private static void DeleteCore(string taskName)
        {
            object service = null;
            object folder = null;
            try
            {
                service = Connect();
                folder = Invoke(service, "GetFolder", new object[] { "\\" });
                Invoke(folder, "DeleteTask", new object[] { taskName, 0 });
                BootstrapLog.Write(null, "已删除一次性 SYSTEM 任务 " + taskName);
            }
            finally
            {
                Release(folder);
                Release(service);
            }
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

        private static object Invoke(object target, string name, object[] arguments)
        {
            return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, arguments);
        }

        private static object Get(object target, string name)
        {
            return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, new object[0]);
        }

        private static void Set(object target, string name, object value)
        {
            target.GetType().InvokeMember(name, BindingFlags.SetProperty, null, target, new object[] { value });
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
