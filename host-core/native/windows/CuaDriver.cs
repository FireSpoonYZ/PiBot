using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// One persistent cua-driver-rs "mcp --direct" child per session agent. The driver is spawned by this
    /// agent, so it always inherits the agent's interactive child-session desktop; it is never started by
    /// the parent-session host and never connects to a global daemon. The process lives in a kill-on-close
    /// job with its helpers; if that containment cannot be set up the driver is never left running.
    /// stdio is bounded UTF-8 JSONL; notifications and unrelated ids never satisfy a request, malformed or
    /// resultless responses are fatal to the driver, and a cancel/timeout/stop terminates and confirms the
    /// whole tree dead before held input is released — nothing is ever replayed.
    /// </summary>
    internal sealed class AgentCuaDriver : IDisposable
    {
        // 128 KiB request budget, a 2 MiB single-line response cap and a bounded total backlog.
        private const int MaxRequestBytes = 128 * 1024;
        private const int MaxLineBytes = 2 * 1024 * 1024;
        private const int MaxPendingBytes = 4 * 1024 * 1024;
        private const int StderrLineChars = 512;
        private const int StderrKeep = 8;
        private const int StderrChunkChars = 256;
        private const int CallTimeoutMs = 30000;
        private const int HandshakeTimeoutMs = 10000;
        private const int StopGraceMs = 3000;
        private const int KillConfirmMs = 5000;
        private const int ErrorMessageChars = 400;

        // Owned-helpers cleanup: the driver and everything it spawns live in a kill-on-close job, so a
        // terminate removes the whole tree, never an arbitrary process list.
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        /// <summary>Confirmed termination state; Terminate never reports killed without seeing it.</summary>
        private enum StopState
        {
            Alive,
            Killing,
            Dead,
            Unknown
        }

        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        private readonly object gate = new object();
        /// <summary>Serialized with Call(); the worker only ever runs one MCP request per driver.</summary>
        private readonly object rpcLock = new object();
        private readonly Queue<string> lines = new Queue<string>();
        private readonly List<string> diagnostics = new List<string>();
        private readonly string driverPath;
        private Process process;
        private IntPtr job;
        private Stream stdin;
        private int pendingBytes;
        private int nextId;
        private StopState state;
        private string deadReason;
        // 终止门：任意时刻只有一个调用者执行 kill/close，其余在 gate 上等它的结果。
        private bool terminating;
        private bool disposed;

        private AgentCuaDriver(string driverPath)
        {
            this.driverPath = driverPath;
        }

        /// <summary>True while the driver is running; a killed-but-unconfirmed driver counts as stopped.</summary>
        public bool Alive
        {
            get
            {
                lock (gate)
                {
                    return state == StopState.Alive && !disposed;
                }
            }
        }


        /// <summary>Spawns the driver inside this session, assigns its job and finishes the MCP handshake.</summary>
        public static AgentCuaDriver Start(string driverPath, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            if (cancel != null && cancel.Cancelled)
            {
                failure = new AgentFailure("CANCELLED", "cua driver start cancelled before it began", "not-sent");
                return null;
            }
            var driver = new AgentCuaDriver(driverPath);
            var info = new ProcessStartInfo();
            info.FileName = driverPath;
            info.Arguments = "mcp --direct";
            info.UseShellExecute = false;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Utf8;
            info.StandardErrorEncoding = Utf8;
            info.CreateNoWindow = true;
            try
            {
                info.EnvironmentVariables["DO_NOT_TRACK"] = "1";
            }
            catch (Exception)
            {
            }
            try
            {
                driver.process = Process.Start(info);
            }
            catch (Exception ex)
            {
                failure = new AgentFailure("SHOWER_BACKEND_FAILED", "cannot start the cua driver: " + ex.Message, "not-sent");
                return null;
            }
            if (driver.process == null)
            {
                failure = new AgentFailure("SHOWER_BACKEND_FAILED", "cannot start the cua driver", "not-sent");
                return null;
            }
            try
            {
                driver.AssignJob();
            }
            catch (Exception ex)
            {
                // Containment is mandatory: a driver we cannot track must never survive this call.
                driver.TerminateNow();
                failure = new AgentFailure("SHOWER_BACKEND_FAILED", "cannot contain the cua driver in a job: " + ex.Message, "not-sent");
                return null;
            }
            driver.stdin = driver.process.StandardInput.BaseStream;
            var stdoutThread = new Thread(new ThreadStart(delegate { driver.ReadStdout(driver.process.StandardOutput.BaseStream); }));
            stdoutThread.IsBackground = true;
            stdoutThread.Name = "shower-cua-stdout";
            stdoutThread.Start();
            var stderrThread = new Thread(new ThreadStart(delegate { driver.ReadStderr(driver.process.StandardError.BaseStream); }));
            stderrThread.IsBackground = true;
            stderrThread.Name = "shower-cua-stderr";
            stderrThread.Start();
            var initialize = new Dictionary<string, object>();
            initialize["protocolVersion"] = "2024-11-05";
            initialize["capabilities"] = new Dictionary<string, object>();
            var clientInfo = new Dictionary<string, object>();
            clientInfo["name"] = "e-launcher";
            clientInfo["version"] = "1.0.0";
            initialize["clientInfo"] = clientInfo;
            Dictionary<string, object> ignored;
            AgentFailure handshake = driver.CallRpc("initialize", initialize, HandshakeTimeoutMs, cancel, out ignored);
            if (handshake != null)
            {
                driver.TerminateNow();
                failure = handshake;
                return null;
            }
            var notification = new Dictionary<string, object>();
            notification["jsonrpc"] = "2.0";
            notification["method"] = "notifications/initialized";
            AgentFailure notified = driver.WriteMessage(AgentJson.Serialize(notification), cancel);
            if (notified != null)
            {
                driver.TerminateNow();
                failure = notified;
                return null;
            }
            return driver;
        }

        /// <summary>Driver plus every spawned helper die together; assignment failure rejects the start.</summary>
        private void AssignJob()
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                throw new InvalidOperationException("cannot create the cua driver job (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
            }
            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation)));
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buffer, (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
                {
                    throw new InvalidOperationException("cannot configure the cua driver job (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            if (!AssignProcessToJobObject(job, process.Handle))
            {
                throw new InvalidOperationException("cannot assign the cua driver to its job (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
            }
        }

        /// <summary>
        /// Sends one tools/list or tools/call and waits for its matching response. Notifications and stale
        /// ids are dropped; a malformed or resultless reply is fatal to the driver. A cancel or timeout
        /// synchronously kills the whole tree before reporting, so no later input can keep running.
        /// </summary>
        public Dictionary<string, object> Call(Dictionary<string, object> request, AgentOpCancel cancel, out AgentFailure failure)
        {
            string method = AgentJson.Get(request, "method") as string;
            object parameters = AgentJson.Get(request, "params");
            Dictionary<string, object> result;
            lock (rpcLock)
            {
                failure = CallRpc(method, parameters, CallTimeoutMs, cancel, out result);
            }
            if (failure != null) return null;
            var wrapped = new Dictionary<string, object>();
            wrapped["result"] = result ?? new Dictionary<string, object>();
            return wrapped;
        }

        private AgentFailure CallRpc(string method, object parameters, int timeoutMs, AgentOpCancel cancel, out Dictionary<string, object> result)
        {
            result = null;
            if (cancel != null && cancel.Cancelled)
            {
                return new AgentFailure("CANCELLED", "cua request cancelled before it was sent", "not-sent");
            }
            string id;
            lock (gate)
            {
                if (state != StopState.Alive || disposed) return DeadFailure();
                nextId++;
                id = "cua-" + nextId.ToString(CultureInfo.InvariantCulture);
            }
            var message = new Dictionary<string, object>();
            message["jsonrpc"] = "2.0";
            message["id"] = id;
            message["method"] = method;
            message["params"] = parameters ?? new Dictionary<string, object>();
            string line;
            try
            {
                line = AgentJson.Serialize(message);
            }
            catch (Exception ex)
            {
                return new AgentFailure("INVALID_ARGUMENT", "cua request cannot be serialized: " + ex.Message, "not-sent");
            }
            AgentFailure wrote = WriteMessage(line, cancel);
            if (wrote != null) return wrote;
            var deadline = Stopwatch.StartNew();
            for (;;)
            {
                if (cancel != null && cancel.Cancelled)
                {
                    // The driver may already be injecting; only a confirmed dead tree proves input stopped.
                    TerminateNow();
                    return new AgentFailure("CANCELLED", "cua request cancelled; the driver was stopped and the result is unconfirmed", "unconfirmed");
                }
                string pending;
                int remaining;
                lock (gate)
                {
                    if (state != StopState.Alive || disposed) return DeadFailure();
                    pending = lines.Count > 0 ? lines.Dequeue() : null;
                    if (pending != null) pendingBytes -= Encoding.UTF8.GetByteCount(pending);
                    remaining = timeoutMs - (int)Math.Min(deadline.ElapsedMilliseconds, timeoutMs);
                }
                if (pending != null)
                {
                    Dictionary<string, object> parsed;
                    try
                    {
                        parsed = AgentJson.ParseObject(pending);
                    }
                    catch (Exception)
                    {
                        parsed = null;
                    }
                    if (parsed == null)
                    {
                        TerminateNow();
                        return new AgentFailure("SHOWER_BACKEND_FAILED", "the cua driver sent malformed json and was stopped", "unconfirmed");
                    }
                    // Driver notifications and unrelated ids are protocol noise, never a result.
                    if (AgentJson.Get(parsed, "method") != null) continue;
                    string answer = AgentJson.Get(parsed, "id") as string;
                    if (!string.Equals(answer, id, StringComparison.Ordinal)) continue;
                    Dictionary<string, object> error;
                    if (AgentJson.TryGetObject(AgentJson.Get(parsed, "error"), out error) && error != null)
                    {
                        string text = AgentJson.Get(error, "message") as string;
                        if (text == null || text.Length == 0) text = "the cua driver reported an error";
                        if (text.Length > ErrorMessageChars) text = text.Substring(0, ErrorMessageChars);
                        return new AgentFailure("SHOWER_BACKEND_FAILED", "cua driver: " + text);
                    }
                    object rawResult = AgentJson.Get(parsed, "result");
                    result = rawResult as Dictionary<string, object>;
                    if (result == null)
                    {
                        // Missing or non-object results are protocol violations, never a silent success.
                        TerminateNow();
                        return new AgentFailure("SHOWER_BACKEND_FAILED", "the cua driver answered without a valid result and was stopped", "unconfirmed");
                    }
                    return null;
                }
                if (remaining <= 0)
                {
                    TerminateNow();
                    return new AgentFailure(
                        "SHOWER_BACKEND_FAILED",
                        "the cua driver did not answer " + method + " within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms; the driver was stopped and the result is unconfirmed",
                        "unconfirmed");
                }
                lock (gate)
                {
                    if (lines.Count == 0 && state == StopState.Alive && !disposed)
                    {
                        Monitor.Wait(gate, Math.Min(remaining, 250));
                    }
                }
            }
        }

        /// <summary>Cancels are checked before and after the blocking stdin write; gate is never held here.</summary>
        private AgentFailure WriteMessage(string line, AgentOpCancel cancel)
        {
            if (cancel != null && cancel.Cancelled)
            {
                return new AgentFailure("CANCELLED", "cua request cancelled before it was sent", "not-sent");
            }
            byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
            if (bytes.Length > MaxRequestBytes)
            {
                return new AgentFailure("INVALID_ARGUMENT", "cua request exceeds the " + MaxRequestBytes.ToString(CultureInfo.InvariantCulture) + " byte limit", "not-sent");
            }
            lock (gate)
            {
                if (state != StopState.Alive || disposed) return DeadFailure();
            }
            try
            {
                // No lock held: a stuck pipe can only stall this call's own worker, never the readers or
                // the cancel path that terminates the driver.
                stdin.Write(bytes, 0, bytes.Length);
                stdin.Flush();
            }
            catch (Exception ex)
            {
                TerminateNow();
                return new AgentFailure("SHOWER_BACKEND_FAILED", "cannot write to the cua driver: " + ex.Message, "unconfirmed");
            }
            if (cancel != null && cancel.Cancelled)
            {
                TerminateNow();
                return new AgentFailure("CANCELLED", "cua request cancelled right after it was sent; the driver was stopped and the result is unconfirmed", "unconfirmed");
            }
            return null;
        }

        private AgentFailure DeadFailure()
        {
            string reason;
            string last;
            StopState stopped;
            lock (gate)
            {
                reason = deadReason;
                last = diagnostics.Count > 0 ? diagnostics[diagnostics.Count - 1] : null;
                stopped = state;
            }
            string message = "the cua driver is not running";
            if (stopped == StopState.Unknown) message = "the cua driver could not be confirmed stopped";
            else if (!string.IsNullOrEmpty(reason)) message = "the cua driver stopped: " + reason;
            if (!string.IsNullOrEmpty(last)) message += " (stderr: " + last + ")";
            if (message.Length > ErrorMessageChars) message = message.Substring(0, ErrorMessageChars);
            return new AgentFailure("SHOWER_BACKEND_FAILED", message, "unconfirmed");
        }

        /// <summary>Confirmed dead is the only state that allows held-input release and later cua calls.</summary>
        public bool ConfirmedStopped()
        {
            TerminateNow();
            lock (gate)
            {
                return state == StopState.Dead;
            }
        }

        /// <summary>Bounded byte reads: each stdout line is capped and the backlog cannot grow unbounded.</summary>
        private void ReadStdout(Stream stream)
        {
            var buffer = new byte[64 * 1024];
            var current = new MemoryStream();
            try
            {
                int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    for (int i = 0; i < read; i++)
                    {
                        byte b = buffer[i];
                        if (b == 0x0A)
                        {
                            string text = Utf8.GetString(current.GetBuffer(), 0, (int)current.Length);
                            current.SetLength(0);
                            Enqueue(text);
                            if (!Alive) return;
                            continue;
                        }
                        current.WriteByte(b);
                        if (current.Length > MaxLineBytes)
                        {
                            FailStream("response line exceeds the " + MaxLineBytes.ToString(CultureInfo.InvariantCulture) + " byte cap");
                            return;
                        }
                    }
                    if (!Alive) return;
                }
            }
            catch (Exception)
            {
            }
            finally
            {
                current.Dispose();
                lock (gate)
                {
                    if (state == StopState.Alive && !disposed)
                    {
                        state = StopState.Killing;
                        if (deadReason == null) deadReason = "unexpected exit";
                    }
                    Monitor.PulseAll(gate);
                }
            }
        }

        private void Enqueue(string line)
        {
            lock (gate)
            {
                if (state != StopState.Alive || disposed) return;
                int size = Encoding.UTF8.GetByteCount(line);
                if (pendingBytes + size > MaxPendingBytes)
                {
                    state = StopState.Killing;
                    if (deadReason == null) deadReason = "response backlog exceeds the " + MaxPendingBytes.ToString(CultureInfo.InvariantCulture) + " byte cap";
                    Monitor.PulseAll(gate);
                    KillInBackground();
                    return;
                }
                lines.Enqueue(line);
                pendingBytes += size;
                Monitor.PulseAll(gate);
            }
        }

        /// <summary>stderr is bounded diagnostics only; payloads and credentials are never logged.</summary>
        private void ReadStderr(Stream stream)
        {
            var buffer = new byte[8192];
            var line = new StringBuilder();
            try
            {
                int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    string chunk = Utf8.GetString(buffer, 0, read);
                    for (int i = 0; i < chunk.Length; i++)
                    {
                        char c = chunk[i];
                        if (c == '\n')
                        {
                            PushDiagnostic(line.ToString());
                            line.Length = 0;
                            continue;
                        }
                        if (c == '\r') continue;
                        if (line.Length < StderrChunkChars) line.Append(c);
                    }
                }
            }
            catch (Exception)
            {
            }
            if (line.Length > 0) PushDiagnostic(line.ToString());
        }

        private void PushDiagnostic(string text)
        {
            string trimmed = text.Trim();
            if (trimmed.Length == 0) return;
            if (trimmed.Length > StderrLineChars) trimmed = trimmed.Substring(0, StderrLineChars);
            lock (gate)
            {
                diagnostics.Add(trimmed);
                while (diagnostics.Count > StderrKeep) diagnostics.RemoveAt(0);
            }
        }

        private void FailStream(string reason)
        {
            lock (gate)
            {
                if (state == StopState.Alive)
                {
                    state = StopState.Killing;
                    if (deadReason == null) deadReason = reason;
                }
                Monitor.PulseAll(gate);
            }
            KillInBackground();
        }

        /// <summary>
        /// Readers cannot block on Terminate inside the gate, so the kill itself runs off-thread; the
        /// state is already Killing, so no waiter can observe the driver as alive in between.
        /// </summary>
        private void KillInBackground()
        {
            ThreadPool.QueueUserWorkItem(delegate { TerminateNow(); });
        }

        /// <summary>
        /// Synchronously ends the whole job tree and confirms it. Exactly one caller runs the kill
        /// sequence and owns the job handle — every concurrent caller waits on gate for its outcome,
        /// so the handle can never be closed twice. Returns only once the driver is dead, or with
        /// state Unknown when even that cannot be proven; a later call may retry from Unknown since
        /// the process handle is still valid. Never reports a success it did not see.
        /// </summary>
        public void TerminateNow()
        {
            Process target;
            IntPtr tree;
            lock (gate)
            {
                if (state == StopState.Dead)
                {
                    Monitor.PulseAll(gate);
                    return;
                }
                // Followers wait for the in-flight kill rather than racing it; the leader pulses gate
                // once it has a verdict.
                while (terminating && state != StopState.Dead)
                {
                    Monitor.Wait(gate);
                }
                if (state == StopState.Dead)
                {
                    Monitor.PulseAll(gate);
                    return;
                }
                // Leader: claims the job handle so nobody else can close or reuse it.
                terminating = true;
                state = StopState.Killing;
                if (deadReason == null) deadReason = "terminated";
                target = process;
                tree = job;
                job = IntPtr.Zero;
                Monitor.PulseAll(gate);
            }
            bool confirmed = false;
            if (target != null)
            {
                try
                {
                    target.StandardInput.Close();
                }
                catch (Exception)
                {
                }
                try
                {
                    if (!target.WaitForExit(StopGraceMs))
                    {
                        if (tree != IntPtr.Zero) TerminateJobObject(tree, 1);
                        if (!target.WaitForExit(KillConfirmMs))
                        {
                            target.Kill();
                            confirmed = target.WaitForExit(KillConfirmMs);
                        }
                        else
                        {
                            confirmed = true;
                        }
                    }
                    else
                    {
                        confirmed = true;
                    }
                }
                catch (Exception)
                {
                    confirmed = false;
                }
            }
            if (tree != IntPtr.Zero)
            {
                try { CloseHandle(tree); } catch (Exception) { }
            }
            lock (gate)
            {
                // Termination is never claimed without proof; an unconfirmed kill keeps the agent from
                // releasing input or answering as if the driver had stopped. On Unknown a retry still
                // owns the process handle, so it can attempt the kill again.
                state = confirmed ? StopState.Dead : StopState.Unknown;
                terminating = false;
                Monitor.PulseAll(gate);
            }
        }

        public void Dispose()
        {
            TerminateNow();
            lock (gate)
            {
                disposed = true;
                Monitor.PulseAll(gate);
            }
            try
            {
                if (process != null) process.Dispose();
            }
            catch (Exception)
            {
            }
        }
    }
}
