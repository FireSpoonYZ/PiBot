using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>Session and identity probes owned by the host; nothing here touches the parent desktop.</summary>
    internal static class HostNative
    {
        /// <summary>WTSGetChildSessionId is missing: the Windows build has no child session feature.</summary>
        internal const int UnsupportedChildSessions = -1;

        private const int WtsUserName = 5;
        private const int ProcessQueryLimitedInformation = 0x1000;
        private const int TokenQuery = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        private struct InternetAccount
        {
            public int IsInternetIdentity;
            public uint Flags;
            public IntPtr Provider;
            public IntPtr Principal;
            public IntPtr Sid;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buffer);

        [DllImport("netapi32.dll")]
        private static extern int NetApiBufferFree(IntPtr buffer);

        internal static void CurrentAccountHint(out string user, out string domain)
        {
            user = Environment.UserName;
            domain = Environment.UserDomainName;
            IntPtr buffer;
            if (NetUserGetInfo(null, user, 24, out buffer) != 0) return;
            try
            {
                InternetAccount account = (InternetAccount)Marshal.PtrToStructure(buffer, typeof(InternetAccount));
                if (account.IsInternetIdentity == 0 || account.Sid == IntPtr.Zero) return;
                if (new SecurityIdentifier(account.Sid).Value != CurrentUserSid()) return;
                string principal = Marshal.PtrToStringUni(account.Principal);
                string provider = Marshal.PtrToStringUni(account.Provider);
                if (!string.IsNullOrEmpty(principal) && !string.IsNullOrEmpty(provider))
                {
                    user = principal;
                    domain = provider;
                }
            }
            finally
            {
                NetApiBufferFree(buffer);
            }
        }

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSGetChildSessionId(out uint sessionId);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSLogoffSession(IntPtr server, int sessionId, bool wait);

        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "WTSQuerySessionInformationW")]
        private static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);

        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr buffer);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        /// <summary>-1 when the API is absent, 0 when no child session exists for this session.</summary>
        internal static int ChildSessionId()
        {
            try
            {
                uint child;
                if (WTSGetChildSessionId(out child)) return (int)child;
                HostLog.Info("WTSGetChildSessionId reports no child session (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
                return 0;
            }
            catch (EntryPointNotFoundException)
            {
                return UnsupportedChildSessions;
            }
            catch (DllNotFoundException)
            {
                return UnsupportedChildSessions;
            }
        }

        internal static string QuerySessionUser(int sessionId)
        {
            IntPtr buffer = IntPtr.Zero;
            int bytes;
            try
            {
                if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WtsUserName, out buffer, out bytes)) return null;
                if (buffer == IntPtr.Zero || bytes <= 0) return null;
                return Marshal.PtrToStringUni(buffer);
            }
            catch (EntryPointNotFoundException)
            {
                return null;
            }
            finally
            {
                if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
            }
        }

        /// <summary>只发起注销（wait:false），同步等待可能无界阻塞；完成由调用方核验。</summary>
        internal static bool LogoffSession(int sessionId)
        {
            try
            {
                return WTSLogoffSession(IntPtr.Zero, sessionId, false);
            }
            catch (EntryPointNotFoundException)
            {
                return false;
            }
            catch (DllNotFoundException)
            {
                return false;
            }
        }

        /// <summary>The agent must be the child session's process of this user, or its frames are foreign.</summary>
        internal static void VerifyAgentProcess(int processId, int expectedSessionId)
        {
            uint session;
            if (!ProcessIdToSessionId((uint)processId, out session))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "agent process " + processId.ToString(CultureInfo.InvariantCulture) + " is not visible to the host");
            }
            if ((int)session != expectedSessionId)
            {
                throw new HostFault(
                    HostErrorCodes.SessionMismatch,
                    "agent process " + processId.ToString(CultureInfo.InvariantCulture) + " runs in session " + session.ToString(CultureInfo.InvariantCulture) + ", expected " + expectedSessionId.ToString(CultureInfo.InvariantCulture));
            }
            string agentUser = ProcessUserSid(processId);
            string currentUser = CurrentUserSid();
            if (agentUser == null)
            {
                HostLog.Warn("cannot read the agent token user; the pipe DACL still limits peers to this user and SYSTEM");
                return;
            }
            if (currentUser != null && !string.Equals(agentUser, currentUser, StringComparison.OrdinalIgnoreCase))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "agent process " + processId.ToString(CultureInfo.InvariantCulture) + " runs as another user");
            }
        }

        internal static string CurrentUserSid()
        {
            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                {
                    return identity.User == null ? null : identity.User.Value;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ProcessUserSid(int processId)
        {
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (process == IntPtr.Zero) return null;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(process, TokenQuery, out token)) return null;
                using (WindowsIdentity identity = new WindowsIdentity(token))
                {
                    return identity.User == null ? null : identity.User.Value;
                }
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
                CloseHandle(process);
            }
        }
    }

    /// <summary>
    /// Named pipe server for one child session agent. The DACL admits only the current user and SYSTEM, the
    /// name is random per host run and the handshake is validated against the expected child session.
    /// </summary>
    internal sealed class AgentLink
    {
        private const int MaxLineChars = 8 * 1024 * 1024;
        private const int BufferSize = 64 * 1024;

        private readonly string pipeName;
        private readonly NamedPipeServerStream pipe;
        private readonly object writeLock = new object();
        private readonly object pendingLock = new object();
        private readonly Dictionary<string, AgentCall> pending = new Dictionary<string, AgentCall>(StringComparer.Ordinal);
        private readonly HashSet<string> ignored = new HashSet<string>(StringComparer.Ordinal);
        private readonly ManualResetEventSlim handshakeDone = new ManualResetEventSlim(false);
        private StreamReader reader;
        private StreamWriter writer;
        private Thread readThread;
        private int expectedSessionId;
        private bool handshakeReceived;
        private HostFault handshakeFault;
        private bool closed;

        internal AgentLink()
        {
            pipeName = "e-launcher-shower-host-" + Guid.NewGuid().ToString("N");
            pipe = CreatePipe(pipeName);
        }

        internal string PipeName
        {
            get { return pipeName; }
        }

        /// <summary>Accepts the agent connection and validates its handshake before any frame or input moves.</summary>
        internal void WaitForAgent(int expectedSessionId, int timeoutMs)
        {
            this.expectedSessionId = expectedSessionId;
            IAsyncResult waiting = pipe.BeginWaitForConnection(null, null);
            if (!waiting.AsyncWaitHandle.WaitOne(timeoutMs))
            {
                Close();
                throw new HostFault(HostErrorCodes.NotReady, "the child session agent did not connect within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms");
            }
            pipe.EndWaitForConnection(waiting);
            var encoding = new UTF8Encoding(false);
            reader = new StreamReader(pipe, encoding, false, 8192, true);
            writer = new StreamWriter(pipe, encoding, 8192, true);
            writer.NewLine = "\n";
            writer.AutoFlush = true;
            readThread = new Thread(ReadLoop);
            readThread.IsBackground = true;
            readThread.Name = "shower-host-agent";
            readThread.Start();
            if (!handshakeDone.Wait(timeoutMs))
            {
                Close();
                throw new HostFault(HostErrorCodes.NotReady, "the child session agent did not finish its handshake within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms");
            }
            if (handshakeFault != null)
            {
                HostFault fault = handshakeFault;
                Close();
                throw fault;
            }
            if (!handshakeReceived)
            {
                Close();
                throw new HostFault(HostErrorCodes.NotReady, "the child session agent closed the pipe before its handshake");
            }
        }

        internal Dictionary<string, object> Call(string method, Dictionary<string, object> parameters, int timeoutMs, WireRelay relay)
        {
            return Call(method, parameters, timeoutMs, relay, 0);
        }

        /// <summary>
        /// cancelSettleMs: after the timeout fires and cancel reaches the agent, keep waiting that bounded
        /// window for the real reply. cua needs it so the agent's driver kill + held-input release finishes
        /// (or is confirmed failed) before the host reports the call to Node.
        /// </summary>
        internal Dictionary<string, object> Call(string method, Dictionary<string, object> parameters, int timeoutMs, WireRelay relay, int cancelSettleMs)
        {
            var call = new AgentCall();
            string id = Guid.NewGuid().ToString("N");
            string failureCode = method == "input" ? HostErrorCodes.InputFailed : HostErrorCodes.BackendFailed;
            lock (pendingLock)
            {
                if (closed) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
                pending[id] = call;
            }
            bool written = false;
            try
            {
                var message = new Dictionary<string, object>();
                message["id"] = id;
                message["method"] = method;
                message["params"] = parameters ?? new Dictionary<string, object>();
                Write(message);
                written = true;
                if (relay != null) relay.AgentRequestId = id;
                if (!call.Done.Wait(timeoutMs))
                {
                    // The agent may still be injecting; stop it and report the input as unconfirmed, never resent.
                    CancelRemote(id);
                    if (cancelSettleMs > 0 && call.Done.Wait(cancelSettleMs))
                    {
                        // Agent finished its cleanup and answered inside the settle window.
                        if (call.FaultCode != null) throw new HostFault(call.FaultCode, call.FaultMessage, call.FaultOutcome);
                        return call.Result;
                    }
                    throw new HostFault(failureCode, "the child session agent did not answer " + method + " within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms", "unconfirmed");
                }
                if (call.FaultCode != null) throw new HostFault(call.FaultCode, call.FaultMessage, call.FaultOutcome);
                return call.Result;
            }
            catch (HostFault)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new HostFault(failureCode, "cannot reach the child session agent: " + ex.Message, written ? "unconfirmed" : "not-sent");
            }
            finally
            {
                lock (pendingLock)
                {
                    pending.Remove(id);
                }
            }
        }

        internal void CancelRemote(string requestId)
        {
            if (string.IsNullOrEmpty(requestId)) return;
            string id = Guid.NewGuid().ToString("N");
            lock (pendingLock)
            {
                if (closed) return;
                ignored.Add(id);
            }
            var parameters = new Dictionary<string, object>();
            parameters["requestId"] = requestId;
            var message = new Dictionary<string, object>();
            message["id"] = id;
            message["method"] = "cancel";
            message["params"] = parameters;
            try
            {
                Write(message);
            }
            catch (Exception ex)
            {
                HostLog.Warn("agent cancel failed: " + ex.Message);
            }
        }

        /// <summary>Asks the agent to release held input and closes the channel; the host owns the session.</summary>
        internal void ReleaseAndClose(int timeoutMs)
        {
            try
            {
                bool open;
                lock (pendingLock)
                {
                    open = !closed;
                }
                if (open) Call("release", new Dictionary<string, object>(), timeoutMs, null);
            }
            catch (HostFault fault)
            {
                HostLog.Warn("agent release failed: " + fault.Message);
            }
            finally
            {
                Close();
            }
        }

        internal void Close()
        {
            lock (pendingLock)
            {
                if (closed) return;
                closed = true;
            }
            try
            {
                lock (writeLock)
                {
                    if (writer != null) writer.Flush();
                }
            }
            catch (Exception)
            {
            }
            try
            {
                pipe.Close();
            }
            catch (Exception)
            {
            }
            try
            {
                if (readThread != null && readThread != Thread.CurrentThread) readThread.Join(250);
            }
            catch (Exception)
            {
            }
            FailPending(new HostFault(HostErrorCodes.NotReady, "the child session agent channel is closed"));
            handshakeDone.Set();
        }

        private static NamedPipeServerStream CreatePipe(string name)
        {
            var security = new PipeSecurity();
            string current = HostNative.CurrentUserSid();
            if (current != null)
            {
                var user = new SecurityIdentifier(current);
                security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
            }
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            security.AddAccessRule(new PipeAccessRule(system, PipeAccessRights.FullControl, AccessControlType.Allow));
            return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, BufferSize, BufferSize, security);
        }

        private void ReadLoop()
        {
            try
            {
                bool first = true;
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length > MaxLineChars)
                    {
                        HostLog.Warn("agent line exceeds the wire cap; closing the channel");
                        break;
                    }
                    if (line.Trim().Length == 0) continue;
                    if (first)
                    {
                        first = false;
                        AcceptHandshake(line);
                        if (handshakeFault != null) break;
                        continue;
                    }
                    Dispatch(line);
                }
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            catch (InvalidOperationException)
            {
            }
            catch (Exception ex)
            {
                HostLog.Warn("agent reader failed: " + ex.Message);
            }
            finally
            {
                handshakeDone.Set();
                Close();
            }
        }

        private void AcceptHandshake(string line)
        {
            try
            {
                Dictionary<string, object> message = WireJson.TryParseObject(line);
                if (message == null)
                {
                    handshakeFault = new HostFault(HostErrorCodes.SessionMismatch, "agent handshake is not a json object");
                    return;
                }
                string kind = WireJson.GetString(message, "event");
                if (!string.Equals(kind, "agent-ready", StringComparison.Ordinal))
                {
                    handshakeFault = new HostFault(HostErrorCodes.SessionMismatch, "agent handshake event must be agent-ready");
                    return;
                }
                int? session = WireJson.Int(WireJson.Get(message, "sessionId"));
                int? pid = WireJson.Int(WireJson.Get(message, "pid"));
                if (session == null || pid == null || pid.Value <= 0)
                {
                    handshakeFault = new HostFault(HostErrorCodes.SessionMismatch, "agent handshake needs an integer sessionId and pid");
                    return;
                }
                if (session.Value != expectedSessionId)
                {
                    handshakeFault = new HostFault(
                        HostErrorCodes.SessionMismatch,
                        "agent handshake reports session " + session.Value.ToString(CultureInfo.InvariantCulture) + ", expected " + expectedSessionId.ToString(CultureInfo.InvariantCulture));
                    return;
                }
                HostNative.VerifyAgentProcess(pid.Value, session.Value);
                handshakeReceived = true;
                HostLog.Info("agent ready in session " + session.Value.ToString(CultureInfo.InvariantCulture) + " pid " + pid.Value.ToString(CultureInfo.InvariantCulture));
            }
            catch (HostFault fault)
            {
                handshakeFault = fault;
            }
            catch (Exception ex)
            {
                handshakeFault = new HostFault(HostErrorCodes.SessionMismatch, "agent handshake failed: " + ex.Message);
            }
            finally
            {
                handshakeDone.Set();
            }
        }

        private void Dispatch(string line)
        {
            Dictionary<string, object> message = WireJson.TryParseObject(line);
            if (message == null)
            {
                HostLog.Warn("agent sent malformed json; ignored");
                return;
            }
            string id = WireJson.GetString(message, "id");
            if (string.IsNullOrEmpty(id))
            {
                HostLog.Warn("agent sent a message without id; ignored");
                return;
            }
            AgentCall call;
            lock (pendingLock)
            {
                if (ignored.Remove(id)) return;
                if (!pending.TryGetValue(id, out call))
                {
                    HostLog.Warn("agent answered an unknown request");
                    return;
                }
            }
            object ok = WireJson.Get(message, "ok");
            if (ok is bool && (bool)ok)
            {
                call.Complete(WireJson.GetObject(message, "result"));
                return;
            }
            Dictionary<string, object> error = WireJson.GetObject(message, "error");
            string code = WireJson.GetString(error, "code") ?? HostErrorCodes.BackendFailed;
            string text = WireJson.GetString(error, "message") ?? "the child session agent reported a failure";
            string outcome = WireJson.GetString(error, "outcome");
            call.Fail(code, text, outcome);
        }

        private void Write(Dictionary<string, object> message)
        {
            string line;
            try
            {
                line = WireJson.Serialize(message);
            }
            catch (Exception ex)
            {
                throw new HostFault(HostErrorCodes.BackendFailed, "cannot serialize the agent request: " + ex.Message);
            }
            lock (writeLock)
            {
                if (writer == null) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
                writer.WriteLine(line);
                writer.Flush();
            }
        }

        private void FailPending(HostFault fault)
        {
            List<AgentCall> waiting;
            lock (pendingLock)
            {
                waiting = new List<AgentCall>(pending.Values);
                pending.Clear();
            }
            for (int i = 0; i < waiting.Count; i++) waiting[i].Fail(fault.Code, fault.Message, fault.Outcome);
        }

        private sealed class AgentCall
        {
            private readonly ManualResetEventSlim done = new ManualResetEventSlim(false);

            internal ManualResetEventSlim Done
            {
                get { return done; }
            }

            internal Dictionary<string, object> Result { get; private set; }

            internal string FaultCode { get; private set; }

            internal string FaultMessage { get; private set; }

            internal string FaultOutcome { get; private set; }

            internal void Complete(Dictionary<string, object> result)
            {
                Result = result ?? new Dictionary<string, object>();
                done.Set();
            }

            internal void Fail(string code, string message, string outcome)
            {
                FaultCode = code ?? HostErrorCodes.BackendFailed;
                FaultMessage = message ?? "the child session agent reported a failure";
                FaultOutcome = outcome;
                done.Set();
            }
        }
    }
}
