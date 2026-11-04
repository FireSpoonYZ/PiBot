using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ELauncher.Shower
{
    /// <summary>Cancellation flag for one pipe operation; the reader thread sets it, capture/input poll it.</summary>
    internal sealed class AgentOpCancel
    {
        private volatile bool cancelled;

        public bool Cancelled { get { return cancelled; } }

        public void Cancel() { cancelled = true; }
    }

    /// <summary>Protocol error carried back to the host as {code,message,outcome?}.</summary>
    internal sealed class AgentFailure
    {
        public AgentFailure(string code, string message)
            : this(code, message, null)
        {
        }

        public AgentFailure(string code, string message, string outcome)
        {
            Code = code;
            Message = message;
            Outcome = outcome;
        }

        public string Code { get; private set; }

        public string Message { get; private set; }

        public string Outcome { get; private set; }
    }

    /// <summary>
    /// Named-pipe client that runs inside the RDP child session. The host stays in the parent session and
    /// forwards JSONL frame/input/launch/cancel/release requests; capture and injection happen only here.
    /// </summary>
    public static class SessionAgent
    {
        public const int ConnectTimeoutMs = 15000;

        public static int Run(string pipeName, int expectedSessionId)
        {
            try
            {
                if (string.IsNullOrEmpty(pipeName))
                {
                    Log("agent: --pipe name is required");
                    return 2;
                }
                if (expectedSessionId <= 0)
                {
                    Log("agent: refusing expected session id " + expectedSessionId.ToString(CultureInfo.InvariantCulture));
                    return 3;
                }
                int session = AgentNative.CurrentProcessSessionId();
                if (session == 0)
                {
                    Log("agent: refusing to serve session 0");
                    return 3;
                }
                if (session != expectedSessionId)
                {
                    Log("agent: running in session " + session.ToString(CultureInfo.InvariantCulture) + ", expected " + expectedSessionId.ToString(CultureInfo.InvariantCulture));
                    return 3;
                }
                AgentNative.EnableDpiAwareness();
                using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
                {
                    pipe.Connect(ConnectTimeoutMs);
                    int hostSession;
                    if (!AgentNative.TryGetServerSession(pipe, out hostSession))
                    {
                        Log("agent: cannot identify the host session; refusing to capture an unknown desktop");
                        return 3;
                    }
                    if (hostSession == 0 || hostSession == session)
                    {
                        Log("agent: host runs in session " + hostSession.ToString(CultureInfo.InvariantCulture) + "; refusing to serve its own desktop as a child session");
                        return 3;
                    }
                    return new AgentLoop(pipe, session).Run();
                }
            }
            catch (TimeoutException)
            {
                Log("agent: timed out connecting to the host pipe");
                return 4;
            }
            catch (Exception ex)
            {
                Log("agent: fatal " + ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        internal static void Log(string message)
        {
            try
            {
                Console.Error.WriteLine(message);
            }
            catch (Exception)
            {
            }
        }
    }

    /// <summary>Session and DPI probing; never touches the parent session desktop.</summary>
    internal static class AgentNative
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDPIAware();

        public static int CurrentProcessSessionId()
        {
            uint sessionId;
            if (!ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out sessionId)) return -1;
            return (int)sessionId;
        }

        /// <summary>Input and capture coordinates must be physical pixels, exactly as they are reported.</summary>
        public static void EnableDpiAwareness()
        {
            try
            {
                SetProcessDPIAware();
            }
            catch (EntryPointNotFoundException)
            {
            }
            catch (DllNotFoundException)
            {
            }
        }

        public static bool TryGetServerSession(PipeStream pipe, out int sessionId)
        {
            sessionId = -1;
            var client = pipe as NamedPipeClientStream;
            if (client == null || client.SafePipeHandle == null || client.SafePipeHandle.IsInvalid) return false;
            uint processId;
            if (!GetNamedPipeServerProcessId(client.SafePipeHandle, out processId) || processId == 0) return false;
            uint session;
            if (!ProcessIdToSessionId(processId, out session)) return false;
            sessionId = (int)session;
            return true;
        }
    }

    /// <summary>Local JavaScriptSerializer helpers; the host keeps its own Wire.cs and is not referenced here.</summary>
    internal static class AgentJson
    {
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();

        public static Dictionary<string, object> ParseObject(string text)
        {
            return Serializer.DeserializeObject(text) as Dictionary<string, object>;
        }

        public static string Serialize(object value)
        {
            return Serializer.Serialize(value);
        }

        public static object Get(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj == null || !obj.TryGetValue(key, out value)) return null;
            return value;
        }

        public static bool TryGetString(object value, out string text)
        {
            text = value as string;
            return text != null;
        }

        public static bool TryGetInt(object value, out int number)
        {
            number = 0;
            if (value is int)
            {
                number = (int)value;
                return true;
            }
            if (value is long)
            {
                var wide = (long)value;
                if (wide < int.MinValue || wide > int.MaxValue) return false;
                number = (int)wide;
                return true;
            }
            if (value is decimal)
            {
                var exact = (decimal)value;
                if (exact != decimal.Truncate(exact) || exact < int.MinValue || exact > int.MaxValue) return false;
                number = (int)exact;
                return true;
            }
            if (value is double)
            {
                var real = (double)value;
                if (double.IsNaN(real) || double.IsInfinity(real) || real != Math.Truncate(real) || real < int.MinValue || real > int.MaxValue) return false;
                number = (int)real;
                return true;
            }
            return false;
        }

        public static bool TryGetObject(object value, out Dictionary<string, object> obj)
        {
            obj = value as Dictionary<string, object>;
            return obj != null;
        }

        public static bool TryGetArray(object value, out object[] items)
        {
            items = value as object[];
            return items != null;
        }

        /// <summary>Rejects fields outside the documented shape so bad requests fail loudly.</summary>
        public static bool HasUnexpectedField(Dictionary<string, object> obj, string[] allowed, out string field)
        {
            field = null;
            if (obj == null) return false;
            foreach (string key in obj.Keys)
            {
                bool known = false;
                for (int i = 0; i < allowed.Length; i++)
                {
                    if (string.Equals(allowed[i], key, StringComparison.Ordinal))
                    {
                        known = true;
                        break;
                    }
                }
                if (!known)
                {
                    field = key;
                    return true;
                }
            }
            return false;
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            var serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            serializer.RecursionLimit = 32;
            return serializer;
        }
    }

    internal sealed class AgentRequest
    {
        public AgentRequest(string id, string method, Dictionary<string, object> parameters)
        {
            Id = id;
            Method = method;
            Parameters = parameters;
            Cancel = new AgentOpCancel();
        }

        public string Id { get; private set; }

        public string Method { get; private set; }

        public Dictionary<string, object> Parameters { get; private set; }

        public AgentOpCancel Cancel { get; private set; }
    }

    /// <summary>
    /// Serial operation queue plus an independent reader: cancel arrives while a drag or text injection is
    /// still running, and every queued operation stays ordered with the others.
    /// </summary>
    internal sealed class AgentLoop
    {
        private const string CodeInvalidArgument = "INVALID_ARGUMENT";
        private const string CodeCancelled = "CANCELLED";
        private const string CodeUnsupported = "SHOWER_UNSUPPORTED";
        private const string CodeBusy = "SHOWER_BUSY";
        private const string CodeSessionMismatch = "SHOWER_SESSION_MISMATCH";
        private const string CodeBackendFailed = "SHOWER_BACKEND_FAILED";
        private const string CodePermissionRequired = "SHOWER_PERMISSION_REQUIRED";

        private static readonly string[] CommonFields = new string[] { "sessionId", "source", "taskId" };

        private const int MaxQueuedRequests = 16;
        private const int MaxRequestChars = 1024 * 1024;
        private const int MaxLaunchArgs = 64;
        private const int MaxLaunchArgChars = 4096;
        private const int MaxDriverPathChars = 512;
        private static readonly string[] CuaMethods = new string[] { "tools/list", "tools/call" };
        private static readonly string[] CuaRequestFields = new string[] { "method", "params" };
        private static readonly string[] CuaCallParamFields = new string[] { "name", "arguments" };

        private readonly PipeStream pipe;
        private readonly StreamReader reader;
        private readonly StreamWriter writer;
        private readonly object writeLock = new object();
        private readonly object queueLock = new object();
        private readonly Queue<AgentRequest> queue = new Queue<AgentRequest>();
        private readonly int sessionId;
        private AgentRequest current;
        private AgentCuaDriver cua;
        private string cuaDriverPath;
        // A driver kill that could not be confirmed poisons the session: no further input may run while
        // a possibly-live driver still owns the keyboard and mouse.
        private bool cuaDoomed;
        private bool stopping;

        public AgentLoop(PipeStream pipe, int sessionId)
        {
            this.pipe = pipe;
            this.sessionId = sessionId;
            var encoding = new UTF8Encoding(false);
            reader = new StreamReader(pipe, encoding, false, 4096, true);
            writer = new StreamWriter(pipe, encoding, 4096, true);
            writer.NewLine = "\n";
            writer.AutoFlush = true;
        }

        public int Run()
        {
            Write(Handshake());
            var worker = new Thread(Work);
            worker.IsBackground = true;
            worker.Name = "shower-agent-ops";
            worker.Start();
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length > MaxRequestChars)
                    {
                        SessionAgent.Log("agent: request line exceeds " + MaxRequestChars.ToString(CultureInfo.InvariantCulture) + " characters");
                        break;
                    }
                    if (line.Trim().Length == 0) continue;
                    Accept(line);
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
            finally
            {
                Shutdown(worker);
            }
            return 0;
        }

        private Dictionary<string, object> Handshake()
        {
            var message = new Dictionary<string, object>();
            message["event"] = "agent-ready";
            message["sessionId"] = sessionId;
            message["pid"] = Process.GetCurrentProcess().Id;
            return message;
        }

        private void Accept(string line)
        {
            Dictionary<string, object> request;
            try
            {
                request = AgentJson.ParseObject(line);
            }
            catch (Exception)
            {
                request = null;
            }
            if (request == null)
            {
                SessionAgent.Log("agent: dropped malformed json request");
                return;
            }
            string id;
            if (!AgentJson.TryGetString(AgentJson.Get(request, "id"), out id) || id.Length == 0)
            {
                SessionAgent.Log("agent: dropped request without id");
                return;
            }
            string unknown;
            if (AgentJson.HasUnexpectedField(request, new string[] { "id", "method", "params" }, out unknown))
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "unknown request field: " + unknown));
                return;
            }
            string method;
            if (!AgentJson.TryGetString(AgentJson.Get(request, "method"), out method) || method.Length == 0)
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "request.method must be a non-empty string"));
                return;
            }
            Dictionary<string, object> parameters;
            object rawParameters = AgentJson.Get(request, "params");
            if (rawParameters == null)
            {
                parameters = new Dictionary<string, object>();
            }
            else if (!AgentJson.TryGetObject(rawParameters, out parameters))
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "request.params must be an object"));
                return;
            }
            if (method == "cancel")
            {
                CancelOperation(id, parameters);
                return;
            }
            if (method != "frame" && method != "input" && method != "launch" && method != "release" && method != "cua")
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "unknown method: " + method + "; expected frame, input, launch, cua, cancel or release"));
                return;
            }
            if (!CheckCommonFields(id, parameters)) return;
            var operation = new AgentRequest(id, method, parameters);
            bool full;
            lock (queueLock)
            {
                full = queue.Count >= MaxQueuedRequests;
                if (!full)
                {
                    queue.Enqueue(operation);
                    Monitor.Pulse(queueLock);
                }
            }
            if (full) SendError(id, new AgentFailure(CodeBusy, "too many queued operations; wait for the session to finish"));
        }

        private bool CheckCommonFields(string id, Dictionary<string, object> parameters)
        {
            object sourceValue = AgentJson.Get(parameters, "source");
            if (sourceValue != null)
            {
                string source;
                if (!AgentJson.TryGetString(sourceValue, out source) || (source != "agent" && source != "human"))
                {
                    SendError(id, new AgentFailure(CodeInvalidArgument, "params.source must be agent or human"));
                    return false;
                }
            }
            object taskIdValue = AgentJson.Get(parameters, "taskId");
            if (taskIdValue != null)
            {
                string taskId;
                if (!AgentJson.TryGetString(taskIdValue, out taskId) || taskId.Length == 0)
                {
                    SendError(id, new AgentFailure(CodeInvalidArgument, "params.taskId must be a non-empty string"));
                    return false;
                }
            }
            object sessionValue = AgentJson.Get(parameters, "sessionId");
            if (sessionValue != null && !(sessionValue is string))
            {
                // The shower session id is opaque here; the host may also pass the Windows session number.
                int numericSession;
                if (!AgentJson.TryGetInt(sessionValue, out numericSession))
                {
                    SendError(id, new AgentFailure(CodeInvalidArgument, "params.sessionId must be a string or null"));
                    return false;
                }
            }
            return true;
        }

        private void CancelOperation(string id, Dictionary<string, object> parameters)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(parameters, new string[] { "requestId" }, out unknown))
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "unknown cancel field: " + unknown));
                return;
            }
            string target;
            if (!AgentJson.TryGetString(AgentJson.Get(parameters, "requestId"), out target) || target.Length == 0)
            {
                SendError(id, new AgentFailure(CodeInvalidArgument, "cancel.requestId must be a non-empty string"));
                return;
            }
            // An already finished request cannot be unsent; cancel stays idempotent and reports false.
            bool cancelled = false;
            lock (queueLock)
            {
                if (current != null && string.Equals(current.Id, target, StringComparison.Ordinal))
                {
                    current.Cancel.Cancel();
                    cancelled = true;
                }
                foreach (AgentRequest pending in queue)
                {
                    if (string.Equals(pending.Id, target, StringComparison.Ordinal))
                    {
                        pending.Cancel.Cancel();
                        cancelled = true;
                    }
                }
            }
            var result = new Dictionary<string, object>();
            result["cancelled"] = cancelled;
            SendResult(id, result);
        }

        private void Work()
        {
            while (true)
            {
                AgentRequest operation;
                lock (queueLock)
                {
                    while (queue.Count == 0 && !stopping) Monitor.Wait(queueLock);
                    if (queue.Count == 0) return;
                    operation = queue.Dequeue();
                    current = operation;
                }
                try
                {
                    if (operation.Cancel.Cancelled)
                    {
                        SendError(operation.Id, new AgentFailure(CodeCancelled, "operation cancelled before it started", "not-sent"));
                        continue;
                    }
                    Execute(operation);
                }
                catch (Exception ex)
                {
                    SendError(operation.Id, new AgentFailure(CodeBackendFailed, "agent operation failed: " + ex.Message));
                }
                finally
                {
                    lock (queueLock)
                    {
                        if (object.ReferenceEquals(current, operation)) current = null;
                    }
                }
            }
        }

        private void Execute(AgentRequest request)
        {
            AgentFailure mismatch = VerifySession();
            if (mismatch != null)
            {
                SendError(request.Id, mismatch);
                return;
            }
            if (cuaDoomed && request.Method != "release")
            {
                SendError(request.Id, new AgentFailure(CodeBackendFailed,
                    "a cua driver could not be confirmed stopped; this session no longer accepts input"));
                return;
            }
            if (request.Method == "frame") ExecuteFrame(request);
            else if (request.Method == "input") ExecuteInput(request);
            else if (request.Method == "launch") ExecuteLaunch(request);
            else if (request.Method == "cua") ExecuteCua(request);
            else ExecuteRelease(request);
        }

        /// <summary>A replaced or foreign desktop must never receive input.</summary>
        private AgentFailure VerifySession()
        {
            int now = AgentNative.CurrentProcessSessionId();
            if (now != sessionId)
            {
                return new AgentFailure(CodeSessionMismatch, "agent desktop session is " + now.ToString(CultureInfo.InvariantCulture) + ", expected " + sessionId.ToString(CultureInfo.InvariantCulture));
            }
            return null;
        }

        private void ExecuteFrame(AgentRequest request)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(request.Parameters, WithCommon("limits"), out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown frame field: " + unknown));
                return;
            }
            AgentCaptureLimits limits;
            AgentFailure failure;
            if (!AgentCapture.TryReadLimits(AgentJson.Get(request.Parameters, "limits"), out limits, out failure))
            {
                SendError(request.Id, failure);
                return;
            }
            Dictionary<string, object> frame = AgentCapture.Capture(limits, request.Cancel, out failure);
            if (frame == null)
            {
                SendError(request.Id, failure ?? new AgentFailure(CodeBackendFailed, "screen capture failed"));
                return;
            }
            SendResult(request.Id, frame);
        }

        private void ExecuteInput(AgentRequest request)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(request.Parameters, WithCommon("input"), out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown input field: " + unknown));
                return;
            }
            Dictionary<string, object> input;
            if (!AgentJson.TryGetObject(AgentJson.Get(request.Parameters, "input"), out input))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "input.input must be an object"));
                return;
            }
            AgentFailure failure;
            Dictionary<string, object> result = AgentInput.Execute(input, request.Cancel, out failure);
            if (result == null)
            {
                SendError(request.Id, failure ?? new AgentFailure(CodeBackendFailed, "input injection failed"));
                return;
            }
            SendResult(request.Id, result);
        }

        private void ExecuteLaunch(AgentRequest request)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(request.Parameters, WithCommon("launch"), out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown launch field: " + unknown));
                return;
            }
            Dictionary<string, object> launch;
            if (!AgentJson.TryGetObject(AgentJson.Get(request.Parameters, "launch"), out launch))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.launch must be an object"));
                return;
            }
            string kind;
            if (!AgentJson.TryGetString(AgentJson.Get(launch, "kind"), out kind) || kind.Length == 0)
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.kind must be a non-empty string"));
                return;
            }
            if (kind == "app")
            {
                // Windows has no app catalog here; the shared capability list reports process launches only.
                SendError(request.Id, new AgentFailure(CodeUnsupported, "Windows shower launches program paths only; use kind process"));
                return;
            }
            if (kind != "process")
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.kind must be app or process"));
                return;
            }
            if (AgentJson.HasUnexpectedField(launch, new string[] { "kind", "program", "args", "cwd" }, out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown launch field for kind process: " + unknown));
                return;
            }
            string program;
            if (!AgentJson.TryGetString(AgentJson.Get(launch, "program"), out program) || program.Length == 0)
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.program must be a non-empty string"));
                return;
            }
            string[] arguments;
            AgentFailure argumentFailure;
            if (!ReadArguments(launch, out arguments, out argumentFailure))
            {
                SendError(request.Id, argumentFailure);
                return;
            }
            string workingDirectory = null;
            object rawCwd = AgentJson.Get(launch, "cwd");
            if (rawCwd != null)
            {
                if (!AgentJson.TryGetString(rawCwd, out workingDirectory) || workingDirectory.Length == 0)
                {
                    SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.cwd must be a non-empty string"));
                    return;
                }
                if (!Directory.Exists(workingDirectory))
                {
                    SendError(request.Id, new AgentFailure(CodeInvalidArgument, "launch.cwd does not exist: " + workingDirectory));
                    return;
                }
            }
            StartProcess(request.Id, program, arguments, workingDirectory);
        }

        private void StartProcess(string id, string program, string[] arguments, string workingDirectory)
        {
            var startInfo = new ProcessStartInfo();
            startInfo.FileName = program;
            startInfo.Arguments = BuildArgumentLine(arguments);
            if (workingDirectory != null) startInfo.WorkingDirectory = workingDirectory;
            // Same user token as the agent, no shell interpolation and no credential or URL handling.
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = false;
            startInfo.WindowStyle = ProcessWindowStyle.Normal;
            try
            {
                using (Process started = Process.Start(startInfo))
                {
                    var result = new Dictionary<string, object>();
                    result["started"] = true;
                    result["kind"] = "process";
                    result["program"] = program;
                    result["pid"] = ProcessId(started);
                    SendResult(id, result);
                }
            }
            catch (Win32Exception ex)
            {
                string code = ex.NativeErrorCode == 5 ? CodePermissionRequired : CodeBackendFailed;
                SendError(id, new AgentFailure(code, "cannot start " + program + ": " + ex.Message));
            }
            catch (InvalidOperationException ex)
            {
                SendError(id, new AgentFailure(CodeBackendFailed, "cannot start " + program + ": " + ex.Message));
            }
        }

        private static int ProcessId(Process process)
        {
            if (process == null) return 0;
            try
            {
                return process.Id;
            }
            catch (InvalidOperationException)
            {
                return 0;
            }
        }

        private static bool ReadArguments(Dictionary<string, object> launch, out string[] arguments, out AgentFailure failure)
        {
            arguments = new string[0];
            failure = null;
            object rawArguments = AgentJson.Get(launch, "args");
            if (rawArguments == null) return true;
            object[] items;
            if (!AgentJson.TryGetArray(rawArguments, out items))
            {
                failure = new AgentFailure(CodeInvalidArgument, "launch.args must be an array of strings");
                return false;
            }
            if (items.Length > MaxLaunchArgs)
            {
                failure = new AgentFailure(CodeInvalidArgument, "launch.args accepts at most " + MaxLaunchArgs.ToString(CultureInfo.InvariantCulture) + " entries");
                return false;
            }
            var parsed = new string[items.Length];
            for (int i = 0; i < items.Length; i++)
            {
                string value;
                if (!AgentJson.TryGetString(items[i], out value))
                {
                    failure = new AgentFailure(CodeInvalidArgument, "launch.args entries must be strings");
                    return false;
                }
                if (value.Length > MaxLaunchArgChars)
                {
                    failure = new AgentFailure(CodeInvalidArgument, "launch.args entries accept at most " + MaxLaunchArgChars.ToString(CultureInfo.InvariantCulture) + " characters");
                    return false;
                }
                parsed[i] = value;
            }
            arguments = parsed;
            return true;
        }

        private static string BuildArgumentLine(string[] arguments)
        {
            if (arguments == null || arguments.Length == 0) return string.Empty;
            var builder = new StringBuilder();
            for (int i = 0; i < arguments.Length; i++)
            {
                if (i > 0) builder.Append(' ');
                builder.Append(QuoteArgument(arguments[i]));
            }
            return builder.ToString();
        }

        /// <summary>CommandLineToArgvW quoting; only matters because no shell interprets the line.</summary>
        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length != 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            var builder = new StringBuilder();
            builder.Append('"');
            int backslashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    builder.Append('\\', backslashes * 2 + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0)
                {
                    builder.Append('\\', backslashes);
                    backslashes = 0;
                }
                builder.Append(c);
            }
            if (backslashes > 0) builder.Append('\\', backslashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        private void ExecuteRelease(AgentRequest request)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(request.Parameters, CommonFields, out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown release field: " + unknown));
                return;
            }
            // The host owns the session lifecycle; the agent only guarantees no key or button stays pressed.
            StopCua();
            AgentInput.ReleaseHeldInput();
            var result = new Dictionary<string, object>();
            result["released"] = true;
            SendResult(request.Id, result);
        }

        private void ExecuteCua(AgentRequest request)
        {
            string unknown;
            if (AgentJson.HasUnexpectedField(request.Parameters, WithCommon("driverPath", "request"), out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown cua field: " + unknown));
                return;
            }
            string driverPath;
            if (!AgentJson.TryGetString(AgentJson.Get(request.Parameters, "driverPath"), out driverPath) || driverPath.Length == 0)
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "cua.driverPath must be a non-empty string"));
                return;
            }
            if (driverPath.Length > MaxDriverPathChars)
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "cua.driverPath is too long"));
                return;
            }
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(driverPath);
            }
            catch (Exception)
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "cua.driverPath is not a usable absolute path"));
                return;
            }
            Dictionary<string, object> cuaRequest;
            if (!AgentJson.TryGetObject(AgentJson.Get(request.Parameters, "request"), out cuaRequest))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "cua.request must be an object"));
                return;
            }
            if (AgentJson.HasUnexpectedField(cuaRequest, CuaRequestFields, out unknown))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown cua request field: " + unknown));
                return;
            }
            string mcpMethod;
            if (!AgentJson.TryGetString(AgentJson.Get(cuaRequest, "method"), out mcpMethod)
                || (mcpMethod != CuaMethods[0] && mcpMethod != CuaMethods[1]))
            {
                SendError(request.Id, new AgentFailure(CodeInvalidArgument, "cua.request.method must be tools/list or tools/call"));
                return;
            }
            if (mcpMethod == CuaMethods[1])
            {
                Dictionary<string, object> mcpParams;
                if (!AgentJson.TryGetObject(AgentJson.Get(cuaRequest, "params"), out mcpParams)
                    || AgentJson.Get(mcpParams, "name") == null || !(AgentJson.Get(mcpParams, "name") is string)
                    || ((string)AgentJson.Get(mcpParams, "name")).Length == 0)
                {
                    SendError(request.Id, new AgentFailure(CodeInvalidArgument, "tools/call params.name must be a non-empty string"));
                    return;
                }
                if (AgentJson.HasUnexpectedField(mcpParams, CuaCallParamFields, out unknown))
                {
                    SendError(request.Id, new AgentFailure(CodeInvalidArgument, "unknown tools/call params field: " + unknown));
                    return;
                }
                object rawArguments = AgentJson.Get(mcpParams, "arguments");
                if (rawArguments != null && !(rawArguments is Dictionary<string, object>))
                {
                    SendError(request.Id, new AgentFailure(CodeInvalidArgument, "tools/call params.arguments must be an object"));
                    return;
                }
            }
            AgentCuaDriver driver = EnsureCua(fullPath, request.Id, request.Cancel);
            if (driver == null) return;
            AgentFailure failure;
            Dictionary<string, object> result = driver.Call(cuaRequest, request.Cancel, out failure);
            if (result == null)
            {
                if (!driver.Alive)
                {
                    // Synchronous, confirmed kill first; held input is released only after the whole
                    // driver tree is provably dead, never while it might still press keys.
                    if (driver.ConfirmedStopped())
                    {
                        AgentInput.ReleaseHeldInput();
                    }
                    else
                    {
                        cuaDoomed = true;
                        SendError(request.Id, new AgentFailure(CodeBackendFailed,
                            "the cua driver could not be confirmed stopped; held input was not released and this session no longer accepts input",
                            "unconfirmed"));
                        return;
                    }
                }
                SendError(request.Id, failure ?? new AgentFailure(CodeBackendFailed, "cua request failed"));
                return;
            }
            SendResult(request.Id, result);
        }

        /// <summary>
        /// One driver per agent, lazily started inside this child session with the exact path the trusted
        /// host pinned. A different path is never swapped into a running driver; a dead driver may restart
        /// only for the same path.
        /// </summary>
        private AgentCuaDriver EnsureCua(string driverPath, string requestId, AgentOpCancel cancel)
        {
            // Once pinned, a session never swaps to another program; a dead driver may only restart for
            // the same absolute path.
            if (cuaDriverPath != null && !string.Equals(cuaDriverPath, driverPath, StringComparison.OrdinalIgnoreCase))
            {
                SendError(requestId, new AgentFailure(CodeInvalidArgument, "the cua driver path for this session is already pinned"));
                return null;
            }
            if (cua != null && cua.Alive) return cua;
            if (!StopCua())
            {
                SendError(requestId, new AgentFailure(CodeBackendFailed,
                    "the previous cua driver could not be confirmed stopped; this session no longer accepts input",
                    "unconfirmed"));
                return null;
            }
            AgentFailure failure;
            AgentCuaDriver started = AgentCuaDriver.Start(driverPath, cancel, out failure);
            if (started == null)
            {
                SendError(requestId, failure ?? new AgentFailure(CodeBackendFailed, "the cua driver did not start"));
                return null;
            }
            cua = started;
            cuaDriverPath = driverPath;
            SessionAgent.Log("agent: cua driver started");
            return started;
        }

        /// <summary>
        /// Synchronously kills the whole driver tree, then — only when the kill was confirmed — releases
        /// the modifiers/buttons it may have held. Returns false when the process could not be proven
        /// dead; the agent then refuses further input instead of pretending the driver stopped.
        /// </summary>
        private bool StopCua()
        {
            AgentCuaDriver driver = cua;
            cua = null;
            if (driver == null) return true;
            driver.TerminateNow();
            if (!driver.ConfirmedStopped())
            {
                cuaDoomed = true;
                try { driver.Dispose(); } catch (Exception) { }
                return false;
            }
            try { driver.Dispose(); } catch (Exception) { }
            // The driver injects through its own input path; releasing known modifiers/buttons here is the
            // only session-local guarantee we have once it is gone.
            AgentInput.ReleaseHeldInput();
            return true;
        }

        private static string[] WithCommon(params string[] methodFields)
        {
            var fields = new string[CommonFields.Length + methodFields.Length];
            Array.Copy(CommonFields, fields, CommonFields.Length);
            Array.Copy(methodFields, 0, fields, CommonFields.Length, methodFields.Length);
            return fields;
        }

        private void SendResult(string id, Dictionary<string, object> result)
        {
            var message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = true;
            message["result"] = result;
            Write(message);
        }

        private void SendError(string id, AgentFailure failure)
        {
            var body = new Dictionary<string, object>();
            body["code"] = failure.Code;
            body["message"] = failure.Message;
            if (!string.IsNullOrEmpty(failure.Outcome)) body["outcome"] = failure.Outcome;
            var message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = false;
            message["error"] = body;
            Write(message);
        }

        private void Write(Dictionary<string, object> message)
        {
            string line;
            try
            {
                line = AgentJson.Serialize(message);
            }
            catch (Exception ex)
            {
                SessionAgent.Log("agent: cannot serialize response: " + ex.Message);
                return;
            }
            lock (writeLock)
            {
                try
                {
                    writer.WriteLine(line);
                    writer.Flush();
                }
                catch (IOException)
                {
                }
                catch (ObjectDisposedException)
                {
                }
            }
        }

        private void Shutdown(Thread worker)
        {
            lock (queueLock)
            {
                stopping = true;
                foreach (AgentRequest pending in queue) pending.Cancel.Cancel();
                if (current != null) current.Cancel.Cancel();
                Monitor.PulseAll(queueLock);
            }
            try
            {
                worker.Join(250);
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
            StopCua();
        }
    }
}
