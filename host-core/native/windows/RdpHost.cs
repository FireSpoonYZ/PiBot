using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using MSTSCLib;

namespace ELauncher.Shower
{
    /// <summary>
    /// AxHost wrapper for the MsRdpClient9 non-scriptable control (client9)
    /// 8B918B82-7985-4C24-89DF-C33AD2BBFBCD.
    /// </summary>
    internal sealed class RdpControl : AxHost
    {
        internal RdpControl()
            : base(RdpHost.ClientClsid)
        {
        }

        internal object Ocx
        {
            get { return GetOcx(); }
        }
    }

    internal sealed class RdpWindow : Form
    {
        private bool background = true;

        protected override bool ShowWithoutActivation { get { return background; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                if (background) parameters.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                return parameters;
            }
        }

        internal void SetBackground(bool value)
        {
            background = value;
            UpdateStyles();
        }
    }

    /// <summary>
    /// Parent-session host. Owns the STA RDP child-session connection, the child session lifecycle and the
    /// named pipe server to the child-session agent. Capture and injection happen only in the agent, so this
    /// process never reads or drives the parent graphical session.
    /// </summary>
    internal sealed class RdpHost
    {
        internal const string ClientClsid = "8B918B82-7985-4C24-89DF-C33AD2BBFBCD";

        private const int PreviewOrigin = 80;
        private const int DefaultDesktopWidth = 1280;
        private const int DefaultDesktopHeight = 800;
        private const int WireFrameCapBytes = 2 * 1024 * 1024;
        private const int UiStartTimeoutMs = 20000;
        private const int UiStopTimeoutMs = 2000;
        private const int BootstrapTimeoutMs = 300000;
        private const int AgentConnectTimeoutMs = 60000;
        private const int RelayTimeoutMs = 25000;
        // Agent-side tools/call budget is 30 s; the relay gives it bounded room so a timeout still comes
        // from the agent (driver killed, result unconfirmed), not from a premature host give-up.
        private const int CuaRelayTimeoutMs = 34000;
        // After a relay timeout the agent gets this bounded window to finish its own cleanup (driver kill
        // + held-input release) and answer; only then does the host report the call to Node.
        private const int CuaCancelSettleMs = 10000;
        private const int SessionCloseTimeoutMs = 5000;
        // 注销核验上限：给总 15 s release 留出 agent 释放与断连空间，仅查询本机 WTS 状态。
        private const int LogoffVerifyTimeoutMs = 8000;
        // 内部轮询预算：低于父 launcher 的 200 s 硬上限，留出收尾与结果行时间。
        // 它不覆盖 prepare 与凭据框模态阻塞；外部超时强杀由 launcher 兜底，不等于 cleanup 已验证。
        private const int OnboardingBudgetMs = 180000;
        // 密码被拒或账户输入错误时允许有限重试，绝不无限弹框。
        private const int OnboardingMaxAttempts = 3;

        private static readonly string[] WindowsKeys = new string[]
        {
            "ENTER", "TAB", "ESCAPE", "SPACE", "BACKSPACE", "DELETE", "LEFT", "UP", "RIGHT", "DOWN",
            "HOME", "END", "PAGEUP", "PAGEDOWN",
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R",
            "S", "T", "U", "V", "W", "X", "Y", "Z",
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"
        };

        private static readonly string[] RequestFields = new string[] { "id", "method", "params" };
        // Trusted metadata the manager forwards with any call; never guessed, never model supplied. The agent
        // only receives source/taskId, because its own schema rejects anything else.
        private static readonly string[] TrustedFields = new string[] { "source", "taskId", "callId" };
        private static readonly string[] PrepareFields = WithTrusted(new string[0]);
        private static readonly string[] StatusFields = WithTrusted(new string[] { "sessionId" });
        private static readonly string[] EnsureFields = WithTrusted(new string[] { "sessionId", "options" });
        private static readonly string[] CreateOptionFields = new string[] { "width", "height" };
        private static readonly string[] FrameFields = WithTrusted(new string[] { "sessionId", "limits" });
        private static readonly string[] FrameLimitFields = new string[] { "maxWidth", "maxHeight", "maxBytes" };
        private static readonly string[] InputFields = WithTrusted(new string[] { "sessionId", "input" });
        private static readonly string[] LaunchFields = WithTrusted(new string[] { "sessionId", "launch" });
        private static readonly string[] PreviewFields = WithTrusted(new string[] { "sessionId", "preview", "mode" });
        private static readonly string[] ReleaseFields = WithTrusted(new string[] { "sessionId" });
        private static readonly string[] CancelFields = WithTrusted(new string[] { "requestId" });
        private static readonly string[] CuaFields = WithTrusted(new string[] { "sessionId", "driverPath", "request" });
        private static readonly string[] CuaRequestFields = new string[] { "method", "params" };
        private static readonly string[] CuaParamFields = new string[] { "name", "arguments" };
        private const int MaxCuaDriverPathChars = 512;

        private readonly string stateDir;
        private readonly string exePath;
        private readonly int parentSessionId;
        private readonly WireWriter wire;
        private readonly object stateLock = new object();
        private readonly object opLock = new object();
        private readonly object cleanupLock = new object();
        private readonly Dictionary<string, WireRelay> relays = new Dictionary<string, WireRelay>(StringComparer.Ordinal);
        private readonly ManualResetEventSlim uiReady = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim uiExited = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim loginComplete = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim rdpDisconnected = new ManualResetEventSlim(true);

        private RdpWindow ui;
        private RdpControl control;
        private IMsRdpClient9 client;
        private ShowerCredentials pendingCredential;
        private bool credentialRejected;
        private string uiFault;
        private volatile bool closingUi;

        private string sessionId;
        private string phase = "idle";
        private string phaseCode;
        private string phaseMessage;
        private int sourceWidth;
        private int sourceHeight;
        private int childSession;
        private bool ownsChild;
        private string loginFault;
        private AgentLink agent;
        private DateTime updatedAt = DateTime.UtcNow;
        private int generation;
        private long frameSerial;
        // 仅本次进程内 prepare 成功的授权宿主才能创建子会话；启动失败不假装已授权。
        private bool prepared;
        private readonly object prepareLock = new object();
        // 仅本进程显式 shower-setup 引导允许 PrepareCredentials 弹凭据框；普通 host 路径只读已存凭据。
        private bool onboarding;

        private RdpHost(string stateDir)
        {
            this.stateDir = stateDir;
            exePath = ResolveExePath();
            parentSessionId = Process.GetCurrentProcess().SessionId;
            wire = new WireWriter(Console.Out);
        }

        internal static int Run(string[] args)
        {
            string stateDir = CommandLine.Value(args, "--state-dir");
            if (string.IsNullOrEmpty(stateDir))
            {
                HostLog.Warn("host requires --state-dir <absolute directory>");
                return 2;
            }
            string resolved;
            try
            {
                resolved = Path.GetFullPath(stateDir);
                Directory.CreateDirectory(resolved);
            }
            catch (Exception ex)
            {
                HostLog.Warn("state dir is unusable: " + ex.Message);
                return 2;
            }
            var host = new RdpHost(resolved);
            return host.Execute();
        }

        private int Execute()
        {
            StartUiThread();
            if (!uiReady.Wait(UiStartTimeoutMs) || uiFault != null)
            {
                HostLog.Warn("rdp window failed: " + (uiFault ?? "it did not start in time"));
                ShutdownUi();
                return 1;
            }
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null) HandleLine(line);
            }
            catch (Exception ex)
            {
                HostLog.Warn("stdin failed: " + ex.Message);
            }
            HostLog.Info("stdin closed; releasing the owned session");
            string owned = CurrentSession();
            if (owned != null)
            {
                try
                {
                    Cleanup(owned, "eof");
                }
                catch (Exception ex)
                {
                    HostLog.Warn("cleanup failed: " + ex.Message);
                }
            }
            ShutdownUi();
            return 0;
        }

        private static string ResolveExePath()
        {
            try
            {
                return Process.GetCurrentProcess().MainModule.FileName;
            }
            catch (Exception)
            {
                return Application.ExecutablePath;
            }
        }

        private void StartUiThread()
        {
            var thread = new Thread(UiThreadMain);
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Name = "shower-host-rdp";
            thread.Start();
        }

        private void UiThreadMain()
        {
            try
            {
                Application.EnableVisualStyles();
                ui = new RdpWindow();
                ui.Text = "e-launcher shower";
                ui.FormBorderStyle = FormBorderStyle.SizableToolWindow;
                ui.MinimizeBox = false;
                ui.ShowInTaskbar = false;
                ui.StartPosition = FormStartPosition.Manual;
                ui.Location = new Point(-32000, -32000);
                ui.Size = new Size(DefaultDesktopWidth, DefaultDesktopHeight);
                ui.FormClosing += delegate(object sender, FormClosingEventArgs e)
                {
                    if (closingUi) return;
                    // Closing the preview window must not tear down the graphical environment.
                    e.Cancel = true;
                    ui.Visible = false;
                };
                IntPtr handle = ui.Handle;
                if (handle == IntPtr.Zero) HostLog.Warn("rdp window has no handle");
                uiReady.Set();
                Application.Run(new ApplicationContext(ui));
            }
            catch (Exception ex)
            {
                uiFault = ex.GetType().Name + ": " + ex.Message;
                HostLog.Warn("rdp window failed: " + uiFault);
                uiReady.Set();
            }
            finally
            {
                uiExited.Set();
            }
        }

        private void ShutdownUi()
        {
            closingUi = true;
            Form form = ui;
            if (form == null) return;
            try
            {
                if (form.IsHandleCreated && !form.IsDisposed)
                {
                    form.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); });
                }
            }
            catch (Exception)
            {
            }
            uiExited.Wait(UiStopTimeoutMs);
        }

        private void RunOnUi(Action action)
        {
            Form form = ui;
            if (form == null || form.IsDisposed || !form.IsHandleCreated)
            {
                throw new HostFault(HostErrorCodes.Unavailable, "the rdp window is not available");
            }
            if (!form.InvokeRequired)
            {
                action();
                return;
            }
            Exception failure = null;
            form.Invoke((MethodInvoker)delegate
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            });
            if (failure != null) throw failure;
        }

        // ---------------------------------------------------------------------------------- request loop

        private void HandleLine(string line)
        {
            if (line == null || line.Trim().Length == 0) return;
            Dictionary<string, object> envelope = WireJson.TryParseObject(line);
            if (envelope == null)
            {
                HostLog.Warn("dropped a malformed request line");
                return;
            }
            string id = WireJson.GetString(envelope, "id");
            if (string.IsNullOrEmpty(id))
            {
                HostLog.Warn("dropped a request without id");
                return;
            }
            string unknown;
            if (WireJson.HasUnexpectedField(envelope, RequestFields, out unknown))
            {
                wire.Failure(id, HostErrorCodes.InvalidArgument, "unknown request field: " + unknown, null);
                return;
            }
            string method = WireJson.GetString(envelope, "method");
            if (string.IsNullOrEmpty(method))
            {
                wire.Failure(id, HostErrorCodes.InvalidArgument, "request.method must be a non-empty string", null);
                return;
            }
            Dictionary<string, object> parameters;
            object rawParameters = WireJson.Get(envelope, "params");
            if (rawParameters == null)
            {
                parameters = new Dictionary<string, object>();
            }
            else
            {
                parameters = rawParameters as Dictionary<string, object>;
                if (parameters == null)
                {
                    wire.Failure(id, HostErrorCodes.InvalidArgument, "request.params must be an object", null);
                    return;
                }
            }
            var request = new WireRequest(id, method, parameters);
            ThreadPool.QueueUserWorkItem(delegate { Handle(request); });
        }

        private void Handle(WireRequest request)
        {
            bool tracked = request.Method == "frame" || request.Method == "input" || request.Method == "launch" || request.Method == "cua";
            WireRelay relay = null;
            if (tracked)
            {
                relay = new WireRelay();
                lock (stateLock)
                {
                    relays[request.Id] = relay;
                }
            }
            try
            {
                object result;
                switch (request.Method)
                {
                    case "prepare":
                        result = Prepare(request.Params);
                        break;
                    case "status":
                        result = Status(request.Params);
                        break;
                    case "ensure":
                        result = Ensure(request.Params);
                        break;
                    case "frame":
                        lock (opLock)
                        {
                            result = Frame(request.Params, relay);
                        }
                        break;
                    case "input":
                        lock (opLock)
                        {
                            result = Forward(request.Params, relay, false);
                        }
                        break;
                    case "launch":
                        lock (opLock)
                        {
                            result = Forward(request.Params, relay, true);
                        }
                        break;
                    case "cua":
                        lock (opLock)
                        {
                            result = Cua(request.Params, relay);
                        }
                        break;
                    case "preview":
                        lock (opLock)
                        {
                            result = Preview(request.Params);
                        }
                        break;
                    case "release":
                        result = Release(request.Params);
                        break;
                    case "cancel":
                        result = Cancel(request.Params);
                        break;
                    default:
                        throw new HostFault(HostErrorCodes.Unsupported, "unknown method: " + request.Method + "; expected prepare, status, ensure, frame, input, launch, cua, preview, release or cancel");
                }
                wire.Result(request.Id, result);
            }
            catch (HostFault fault)
            {
                wire.Failure(request.Id, fault.Code, fault.Message, fault.Outcome);
            }
            catch (Exception ex)
            {
                HostLog.Warn(request.Method + " failed: " + ex.GetType().Name + ": " + ex.Message);
                wire.Failure(request.Id, HostErrorCodes.BackendFailed, ex.Message, null);
            }
            finally
            {
                if (tracked)
                {
                    lock (stateLock)
                    {
                        relays.Remove(request.Id);
                    }
                }
            }
        }

        // ---------------------------------------------------------------------------------- prepare

        /// <summary>Startup authorization only: enables child sessions and the guardian; never creates a desktop.</summary>
        private object Prepare(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, PrepareFields, "prepare");
            lock (prepareLock)
            {
                if (prepared) return PreparedResult();
                try
                {
                    RunBounded("child session enablement", delegate { SessionBootstrap.EnsureEnabled(stateDir); }, BootstrapTimeoutMs);
                }
                catch (HostFault)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    throw new HostFault(HostErrorCodes.PermissionRequired, "startup authorization failed: " + ex.Message);
                }
                prepared = true;
                HostLog.Info("child session enablement prepared for this host");
                return PreparedResult();
            }
        }

        private static Dictionary<string, object> PreparedResult()
        {
            var result = new Dictionary<string, object>();
            result["prepared"] = true;
            return result;
        }

        // ---------------------------------------------------------------------------------- status

        private object Status(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, StatusFields, "status");
            string requested = WireJson.GetString(parameters, "sessionId");
            lock (stateLock)
            {
                if (!string.IsNullOrEmpty(requested) && sessionId != null && !string.Equals(requested, sessionId, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
                return Snapshot();
            }
        }

        private Dictionary<string, object> Snapshot()
        {
            var session = new Dictionary<string, object>();
            session["sessionId"] = sessionId;
            session["platform"] = "windows";
            session["phase"] = phase;
            session["width"] = sourceWidth;
            session["height"] = sourceHeight;
            session["capabilities"] = Capabilities();
            session["updatedAt"] = updatedAt.ToString("o", CultureInfo.InvariantCulture);
            if (phaseCode != null)
            {
                var error = new Dictionary<string, object>();
                error["code"] = phaseCode;
                error["message"] = phaseMessage ?? string.Empty;
                session["error"] = error;
            }
            return session;
        }

        private static Dictionary<string, object> Capabilities()
        {
            var launchKinds = new List<object>();
            // The Windows agent launches program paths; there is no Windows app catalog behind this host.
            launchKinds.Add("process");
            var inputKinds = new List<object>();
            inputKinds.Add("click");
            inputKinds.Add("drag");
            inputKinds.Add("scroll");
            inputKinds.Add("key");
            inputKinds.Add("text");
            var keys = new List<object>();
            for (int i = 0; i < WindowsKeys.Length; i++) keys.Add(WindowsKeys[i]);
            var capabilities = new Dictionary<string, object>();
            capabilities["launchKinds"] = launchKinds;
            capabilities["inputKinds"] = inputKinds;
            capabilities["keys"] = keys;
            capabilities["nativePreview"] = true;
            return capabilities;
        }

        private void SetPhase(string next, string code, string message)
        {
            Dictionary<string, object> snapshot;
            bool changed;
            lock (stateLock)
            {
                changed = !string.Equals(phase, next, StringComparison.Ordinal) || !string.Equals(phaseCode, code, StringComparison.Ordinal);
                snapshot = ApplyPhase(next, code, message);
            }
            if (changed) wire.StatusEvent(snapshot);
        }

        private void SetPhaseFor(int expectedGeneration, string next, string code, string message)
        {
            Dictionary<string, object> snapshot = null;
            bool changed = false;
            lock (stateLock)
            {
                if (generation != expectedGeneration) return;
                changed = !string.Equals(phase, next, StringComparison.Ordinal) || !string.Equals(phaseCode, code, StringComparison.Ordinal);
                snapshot = ApplyPhase(next, code, message);
            }
            if (changed) wire.StatusEvent(snapshot);
        }

        /// <summary>Caller holds stateLock; returns the snapshot that matches the new phase.</summary>
        private Dictionary<string, object> ApplyPhase(string next, string code, string message)
        {
            phase = next;
            phaseCode = code;
            phaseMessage = message;
            updatedAt = DateTime.UtcNow;
            return Snapshot();
        }

        private bool IsCurrent(int expectedGeneration)
        {
            lock (stateLock)
            {
                return generation == expectedGeneration;
            }
        }

        private void RequireCurrent(int expectedGeneration)
        {
            if (!IsCurrent(expectedGeneration)) throw new HostFault(HostErrorCodes.Cancelled, "the session start was superseded by release");
        }

        private void MarkReady()
        {
            Dictionary<string, object> snapshot;
            lock (stateLock)
            {
                if (sessionId == null || string.Equals(phase, "ready", StringComparison.Ordinal)) return;
                snapshot = ApplyPhase("ready", null, null);
            }
            wire.StatusEvent(snapshot);
        }

        private string CurrentSession()
        {
            lock (stateLock)
            {
                return sessionId;
            }
        }

        private string RequireSession(Dictionary<string, object> parameters)
        {
            string requested = WireJson.GetString(parameters, "sessionId");
            if (string.IsNullOrEmpty(requested)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.sessionId is required");
            lock (stateLock)
            {
                if (sessionId == null) throw new HostFault(HostErrorCodes.SessionNotFound, "this host owns no session");
                if (!string.Equals(sessionId, requested, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
            }
            return requested;
        }

        private void RequireReady()
        {
            string current;
            string code;
            string message;
            lock (stateLock)
            {
                current = phase;
                code = phaseCode;
                message = phaseMessage;
            }
            if (string.Equals(current, "ready", StringComparison.Ordinal)) return;
            if (string.Equals(current, "error", StringComparison.Ordinal) && code != null)
            {
                throw new HostFault(code, message ?? "the child session failed");
            }
            if (string.Equals(current, "authentication-required", StringComparison.Ordinal))
            {
                throw new HostFault(HostErrorCodes.AuthRequired, message ?? "the child session still needs a local sign-in or unlock");
            }
            throw new HostFault(HostErrorCodes.NotReady, "the child session is " + current);
        }

        private static void CheckFields(Dictionary<string, object> parameters, string[] allowed, string method)
        {
            string unknown;
            if (WireJson.HasUnexpectedField(parameters, allowed, out unknown))
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "unknown " + method + " field: " + unknown);
            }
        }

        private static string[] WithTrusted(string[] fields)
        {
            var allowed = new string[fields.Length + TrustedFields.Length];
            Array.Copy(fields, allowed, fields.Length);
            Array.Copy(TrustedFields, 0, allowed, fields.Length, TrustedFields.Length);
            return allowed;
        }

        // ---------------------------------------------------------------------------------- ensure

        private object Ensure(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, EnsureFields, "ensure");
            string requested = WireJson.GetString(parameters, "sessionId");
            if (string.IsNullOrEmpty(requested)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.sessionId is required");
            Dictionary<string, object> options = WireJson.GetObject(parameters, "options");
            CheckFields(options, CreateOptionFields, "options");
            int width = OptionDimension(options, "width");
            int height = OptionDimension(options, "height");
            lock (prepareLock)
            {
                if (!prepared)
                {
                    throw new HostFault(
                        HostErrorCodes.PermissionRequired,
                        "this host has no startup authorization; restart the Host and approve the administrator prompt");
                }
            }
            int expectedGeneration;
            lock (stateLock)
            {
                if (sessionId != null)
                {
                    if (!string.Equals(sessionId, requested, StringComparison.Ordinal))
                    {
                        throw new HostFault(HostErrorCodes.Busy, "this host already owns session " + sessionId);
                    }
                    return Snapshot();
                }
                generation++;
                expectedGeneration = generation;
                sessionId = requested;
                childSession = 0;
                ownsChild = false;
                sourceWidth = 0;
                sourceHeight = 0;
                frameSerial = 0;
                loginFault = null;
                loginComplete.Reset();
            }
            // RDP logon and bootstrap continue in the background without blocking the caller.
            SetPhase("starting", null, null);
            var worker = new Thread(delegate() { StartSession(expectedGeneration, width, height); });
            worker.IsBackground = true;
            worker.Name = "shower-host-start";
            worker.Start();
            return Snapshot();
        }

        private void StartSession(int expectedGeneration, int width, int height)
        {
            AgentLink link = null;
            try
            {
                int before = HostNative.ChildSessionId();
                if (before == HostNative.UnsupportedChildSessions)
                {
                    throw new HostFault(HostErrorCodes.Unavailable, "this Windows build does not expose WTSGetChildSessionId; child sessions are unavailable");
                }
                if (before > 0) throw new HostFault(HostErrorCodes.Busy, "another child session already exists; it will not be adopted");
                HostLog.Info("child session before connect: " + before.ToString(CultureInfo.InvariantCulture));
                // 启动授权只来自本次 Host 启动时的 prepare；会话创建路径不触发新的 UAC。
                RequireCurrent(expectedGeneration);
                link = new AgentLink();
                AgentLink pending = link;
                lock (stateLock)
                {
                    agent = pending;
                }
                ConnectRdp(width, height);
                SetPhaseFor(expectedGeneration, "starting", null, null);
                // 使用已保存凭据在后台等待登录，不阻塞 RPC。
                while (!loginComplete.Wait(500)) RequireCurrent(expectedGeneration);
                RequireCurrent(expectedGeneration);
                string fault;
                lock (stateLock)
                {
                    fault = loginFault;
                }
                if (fault != null) throw new HostFault(
                    credentialRejected ? HostErrorCodes.AuthRequired : HostErrorCodes.BackendFailed,
                    credentialRejected ? "Windows 虚拟屏登录失败；请更新凭据管理器中的 e-launcher/Shower/localhost 后释放并重建" : fault);
                int child = WaitForChildSession();
                if (child <= 0) throw new HostFault(HostErrorCodes.Unavailable, "no child session was created after logon");
                if (child == parentSessionId) throw new HostFault(HostErrorCodes.SessionMismatch, "the reported child session is the parent session");
                VerifyChildSessionUser(child);
                lock (stateLock)
                {
                    childSession = child;
                    ownsChild = true;
                }
                HostLog.Info("child session " + child.ToString(CultureInfo.InvariantCulture) + " is logged on");
                // Logon complete: hide the native preview while the desktop and executor initialize.
                SetPhaseFor(expectedGeneration, "starting", null, null);
                ApplyPreview("hidden");
                int launchedChild = child;
                AgentLink launched = link;
                RunBounded("agent launch", delegate { SessionBootstrap.LaunchAgent(launchedChild, parentSessionId, launched.PipeName, stateDir, exePath); }, BootstrapTimeoutMs);
                RunOnUi(delegate
                {
                    RequireCurrent(expectedGeneration);
                    // 引导模式下新凭据要等 agent 握手验证后才由引导流程统一提交；普通路径行为不变。
                    if (pendingCredential != null && !onboarding)
                    {
                        pendingCredential.Commit();
                        ClearPendingCredential();
                    }
                    credentialRejected = false;
                });
                RequireCurrent(expectedGeneration);
                link.WaitForAgent(child, AgentConnectTimeoutMs);
                RequireCurrent(expectedGeneration);
                var desktopWait = Stopwatch.StartNew();
                for (;;)
                {
                    RequireCurrent(expectedGeneration);
                    try { ProbeFrame(link, child); break; }
                    catch (HostFault desktopFault)
                    {
                        if (desktopFault.Code != HostErrorCodes.AuthRequired || desktopWait.ElapsedMilliseconds >= 30000) throw;
                        Thread.Sleep(500);
                    }
                }
                SetPhaseFor(expectedGeneration, "ready", null, null);
                HostLog.Info("child session " + child.ToString(CultureInfo.InvariantCulture) + " is ready");
            }
            catch (HostFault fault)
            {
                if (fault.Code == HostErrorCodes.AuthRequired)
                {
                    // The agent is connected but its desktop is locked or still signing in; a later frame
                    // recovers once the user unlocks the child session.
                    HostLog.Warn("child session is not usable yet: " + fault.Message);
                    SetPhaseFor(expectedGeneration, "authentication-required", fault.Code, fault.Message);
                    return;
                }
                FailStart(expectedGeneration, fault.Code, fault.Message, link);
            }
            catch (Exception ex)
            {
                FailStart(expectedGeneration, HostErrorCodes.BackendFailed, ex.GetType().Name + ": " + ex.Message, link);
            }
        }

        private void FailStart(int expectedGeneration, string code, string message, AgentLink link)
        {
            if (!IsCurrent(expectedGeneration)) return;
            RunOnUi(ClearPendingCredential);
            HostLog.Warn("child session start failed: " + code + ": " + message);
            if (link != null)
            {
                AgentLink current;
                lock (stateLock)
                {
                    current = agent;
                }
                if (object.ReferenceEquals(current, link)) AbortAgent();
            }
            SetPhaseFor(expectedGeneration, "error", code, message);
        }

        private void ProbeFrame(AgentLink link, int child)
        {
            var limits = new Dictionary<string, object>();
            limits["maxWidth"] = AgentCaptureLimits.MinDimension;
            limits["maxHeight"] = AgentCaptureLimits.MinDimension;
            limits["maxBytes"] = AgentCaptureLimits.DefaultMaxBytes;
            var parameters = new Dictionary<string, object>();
            parameters["sessionId"] = child;
            parameters["limits"] = limits;
            Dictionary<string, object> frame;
            try
            {
                frame = link.Call("frame", parameters, RelayTimeoutMs, null);
            }
            catch (HostFault fault)
            {
                // A locked or still signing-in desktop is an authentication state, not a broken session.
                if (fault.Code == HostErrorCodes.NotReady) throw new HostFault(HostErrorCodes.AuthRequired, fault.Message);
                throw;
            }
            CacheSourceSize(frame);
            int width;
            int height;
            lock (stateLock)
            {
                width = sourceWidth;
                height = sourceHeight;
            }
            HostLog.Info("agent desktop is " + width.ToString(CultureInfo.InvariantCulture) + "x" + height.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>The child session appears with the logon and may lag the OnLoginComplete event briefly.</summary>
        private static int WaitForChildSession()
        {
            for (int attempt = 0; attempt < 20; attempt++)
            {
                int child = HostNative.ChildSessionId();
                if (child > 0) return child;
                if (child == HostNative.UnsupportedChildSessions) return 0;
                Thread.Sleep(500);
            }
            return 0;
        }

        private void VerifyChildSessionUser(int child)
        {
            string childUser = HostNative.QuerySessionUser(child);
            string parentUser = HostNative.QuerySessionUser(parentSessionId);
            if (childUser == null || parentUser == null)
            {
                HostLog.Warn("cannot read the child session user; continuing with the parent session identity");
                return;
            }
            if (!string.Equals(childUser, parentUser, StringComparison.OrdinalIgnoreCase))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "child session " + child.ToString(CultureInfo.InvariantCulture) + " belongs to " + childUser + ", not " + parentUser);
            }
        }

        private static int OptionDimension(Dictionary<string, object> options, string name)
        {
            object raw = WireJson.Get(options, name);
            if (raw == null) return 0;
            int? value = WireJson.Int(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinDimension || value.Value > AgentCaptureLimits.MaxDimension)
            {
                throw new HostFault(
                    HostErrorCodes.InvalidArgument,
                    "options." + name + " must be " + AgentCaptureLimits.MinDimension.ToString(CultureInfo.InvariantCulture) + ".." + AgentCaptureLimits.MaxDimension.ToString(CultureInfo.InvariantCulture));
            }
            return value.Value;
        }

        private void RunBounded(string label, Action action, int timeoutMs)
        {
            Exception failure = null;
            var thread = new Thread(delegate()
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            });
            thread.IsBackground = true;
            thread.Name = "shower-host-" + label;
            thread.Start();
            if (!thread.Join(timeoutMs))
            {
                throw new HostFault(HostErrorCodes.BackendFailed, label + " did not finish within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + " ms");
            }
            if (failure is HostFault) throw (HostFault)failure;
            if (failure != null)
            {
                throw new HostFault(HostErrorCodes.PermissionRequired, label + " failed: " + failure.Message);
            }
        }

        // ---------------------------------------------------------------------------------- RDP client (STA)

        private void ConnectRdp(int width, int height)
        {
            RunOnUi(delegate
            {
                if (ui == null) throw new HostFault(HostErrorCodes.Unavailable, "the rdp window is not available");
                // Recreating an AxHost while its parent is hidden leaves GetOcx() uninitialized.
                ApplyPreview("offscreen");
                if (client != null)
                {
                    // Reuse the initialized ActiveX control across child sessions.
                    client.DesktopWidth = width > 0 ? width : DefaultDesktopWidth;
                    client.DesktopHeight = height > 0 ? height : DefaultDesktopHeight;
                    lock (stateLock) { loginFault = null; }
                    PrepareCredentials(control.Ocx);
                    rdpDisconnected.Reset();
                    client.Connect();
                    return;
                }
                control = new RdpControl();
                control.BeginInit();
                control.Dock = DockStyle.Fill;
                ui.Controls.Add(control);
                control.EndInit();
                control.CreateControl();
                object ocx = control.Ocx;
                IMsRdpClient9 rdp = (IMsRdpClient9)ocx;
                IMsTscAxEvents_Event events = (IMsTscAxEvents_Event)ocx;
                client = rdp;
                events.OnLoginComplete += delegate { HandleLoginComplete(); };
                events.OnDisconnected += delegate(int reason) { HandleDisconnected(reason); };
                events.OnFatalError += delegate(int code) { HandleFatal(code); };
                string accountUser;
                string accountDomain;
                HostNative.CurrentAccountHint(out accountUser, out accountDomain);
                rdp.UserName = accountUser;
                rdp.Domain = accountDomain;
                rdp.Server = "localhost";
                rdp.DesktopWidth = width > 0 ? width : DefaultDesktopWidth;
                rdp.DesktopHeight = height > 0 ? height : DefaultDesktopHeight;
                rdp.ColorDepth = 32;
                rdp.AdvancedSettings7.EnableCredSspSupport = true;
                rdp.AdvancedSettings7.AuthenticationLevel = 0;
                rdp.AdvancedSettings7.EnableAutoReconnect = false;
                rdp.AdvancedSettings7.RedirectClipboard = false;
                // The native credential setup replaces RDP's non-persistent fallback prompt.
                ((IMsRdpClientNonScriptable5)ocx).AllowPromptingForCredentials = false;
                ((IMsRdpClientNonScriptable3)ocx).PromptForCredentials = false;
                ((IMsRdpClientNonScriptable4)ocx).AllowCredentialSaving = false;
                object connectToChild = true;
                ((IMsRdpExtendedSettings)ocx).set_Property("ConnectToChildSession", ref connectToChild);
                lock (stateLock)
                {
                    loginFault = null;
                }
                PrepareCredentials(ocx);
                rdpDisconnected.Reset();
                rdp.Connect();
                HostLog.Info("rdp connect requested against localhost with ConnectToChildSession");
            });
        }

        private void ClearPendingCredential()
        {
            if (pendingCredential == null) return;
            pendingCredential.Dispose();
            pendingCredential = null;
        }

        private void PrepareCredentials(object ocx)
        {
            ClearPendingCredential();
            string user, domain;
            HostNative.CurrentAccountHint(out user, out domain);
            string account = string.IsNullOrEmpty(domain) ? user : domain + "\\" + user;
            client.UserName = user;
            client.Domain = domain;
            if (onboarding)
            {
                // 仅显式本地引导允许弹凭据框：先把离屏宿主窗口带回屏内作为父窗口，结束后恢复。
                ApplyPreview("visible");
                try
                {
                    pendingCredential = ShowerCredentials.Prompt(ui.Handle, account, credentialRejected);
                }
                finally
                {
                    ApplyPreview("offscreen");
                }
            }
            else
            {
                pendingCredential = ShowerCredentials.Read(account);
                if (pendingCredential == null)
                {
                    throw new HostFault(HostErrorCodes.AuthRequired,
                        "请在 Windows 凭据管理器中配置或更新普通凭据 e-launcher/Shower/localhost，账户为 " + account);
                }
            }
            pendingCredential.Apply(ocx);
        }

        private void HandleLoginComplete()
        {
            if (control == null) return;
            HostLog.Info("rdp logon complete");
            loginComplete.Set();
        }

        private void HandleDisconnected(int reason)
        {
            if (control == null) return;
            if (reason == 2055 || reason == 2567 || reason == 3847 || reason == 4615) credentialRejected = true;
            string description = null;
            try
            {
                IMsRdpClient9 rdp = client;
                if (rdp != null) description = rdp.GetErrorDescription((uint)reason, (uint)rdp.ExtendedDisconnectReason);
            }
            catch (Exception)
            {
            }
            string message = "rdp connection closed (reason " + reason.ToString(CultureInfo.InvariantCulture) + ")" + (description == null ? string.Empty : ": " + description);
            HostLog.Warn(message);
            bool report;
            lock (stateLock)
            {
                loginFault = message;
                // A pending start worker reports this itself; a finished session is already closed.
                report = sessionId != null
                    && !string.Equals(phase, "starting", StringComparison.Ordinal)
                    && !string.Equals(phase, "authentication-required", StringComparison.Ordinal);
            }
            loginComplete.Set();
            if (report)
            {
                AbortAgent();
                SetPhase("error", HostErrorCodes.BackendFailed, message);
            }
            rdpDisconnected.Set();
        }

        private void HandleFatal(int code)
        {
            if (control == null) return;
            string message = "rdp fatal error " + code.ToString(CultureInfo.InvariantCulture);
            HostLog.Warn(message);
            bool report;
            lock (stateLock)
            {
                loginFault = message;
                report = sessionId != null
                    && !string.Equals(phase, "starting", StringComparison.Ordinal)
                    && !string.Equals(phase, "authentication-required", StringComparison.Ordinal);
            }
            loginComplete.Set();
            if (!report) return;
            AbortAgent();
            SetPhase("error", HostErrorCodes.BackendFailed, message);
        }

        private void ApplyPreview(string mode)
        {
            try
            {
                RunOnUi(delegate
                {
                    if (ui == null) return;
                    switch (mode)
                    {
                        case "visible":
                            ui.SetBackground(false);
                            ui.ShowInTaskbar = true;
                            ui.WindowState = FormWindowState.Normal;
                            ui.Location = new Point(PreviewOrigin, PreviewOrigin);
                            ui.Visible = true;
                            ui.Activate();
                            break;
                        case "minimized":
                            // RDP 原生最小化会暂停输入；缩起预览统一隐藏宿主并保持连接。
                            ui.Visible = false;
                            ui.ShowInTaskbar = false;
                            break;
                        case "offscreen":
                            ui.SetBackground(true);
                            ui.ShowInTaskbar = false;
                            ui.WindowState = FormWindowState.Normal;
                            ui.Location = new Point(-32000, -32000);
                            ui.Visible = true;
                            break;
                        default:
                            ui.Visible = false;
                            ui.ShowInTaskbar = false;
                            break;
                    }
                });
            }
            catch (HostFault)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new HostFault(HostErrorCodes.BackendFailed, "preview " + mode + " failed: " + ex.Message);
            }
        }

        private void DisconnectRdp()
        {
            bool waiting = false;
            RunOnUi(delegate
            {
                ClearPendingCredential();
                if (client != null && client.Connected != 0)
                {
                    waiting = true;
                    rdpDisconnected.Reset();
                    client.Disconnect();
                }
            });
            // The previous disconnect callback must finish before a new connection can reuse the control.
            if (waiting && !rdpDisconnected.Wait(UiStopTimeoutMs))
                throw new HostFault(HostErrorCodes.BackendFailed, "RDP disconnect did not complete");
        }

        // ---------------------------------------------------------------------------------- frame and input

        private object Frame(Dictionary<string, object> parameters, WireRelay relay)
        {
            CheckFields(parameters, FrameFields, "frame");
            string requested = RequireSession(parameters);
            Dictionary<string, object> limits = BuildFrameLimits(WireJson.GetObject(parameters, "limits"));
            AgentLink link;
            int child;
            lock (stateLock)
            {
                link = agent;
                child = childSession;
            }
            if (link == null) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
            if (child <= 0) throw new HostFault(HostErrorCodes.NotReady, "the child session is still starting");
            ThrowIfCancelled(relay);
            var forwarded = new Dictionary<string, object>();
            forwarded["sessionId"] = child;
            forwarded["limits"] = limits;
            Dictionary<string, object> frame = link.Call("frame", forwarded, RelayTimeoutMs, relay);
            if (frame == null) throw new HostFault(HostErrorCodes.BackendFailed, "the child session agent returned no frame");
            string owner = WireJson.GetString(frame, "sessionId");
            if (owner != null && !string.Equals(owner, requested, StringComparison.Ordinal))
            {
                throw new HostFault(HostErrorCodes.SessionMismatch, "the agent frame belongs to another session");
            }
            string encoded = WireJson.GetString(frame, "data");
            if (string.IsNullOrEmpty(encoded)) throw new HostFault(HostErrorCodes.BackendFailed, "the child session frame has no image data");
            long maxBytes = WireJson.Long(WireJson.Get(limits, "maxBytes")) ?? AgentCaptureLimits.DefaultMaxBytes;
            if (encoded.Length > maxBytes)
            {
                throw new HostFault(HostErrorCodes.FrameTooLarge, "the frame needs " + encoded.Length.ToString(CultureInfo.InvariantCulture) + " base64 bytes, the limit is " + maxBytes.ToString(CultureInfo.InvariantCulture));
            }
            if (encoded.Length > WireFrameCapBytes)
            {
                throw new HostFault(HostErrorCodes.FrameTooLarge, "the frame exceeds the " + WireFrameCapBytes.ToString(CultureInfo.InvariantCulture) + " byte native wire cap");
            }
            CacheSourceSize(frame);
            string frameId;
            lock (stateLock)
            {
                frameSerial++;
                frameId = "windows-" + frameSerial.ToString(CultureInfo.InvariantCulture);
            }
            var result = new Dictionary<string, object>(frame);
            result["sessionId"] = requested;
            result["frameId"] = frameId;
            MarkReady();
            return result;
        }

        private object Forward(Dictionary<string, object> parameters, WireRelay relay, bool launch)
        {
            CheckFields(parameters, launch ? LaunchFields : InputFields, launch ? "launch" : "input");
            string requested = RequireSession(parameters);
            string field = launch ? "launch" : "input";
            Dictionary<string, object> payload = WireJson.GetObject(parameters, field);
            if (payload == null) throw new HostFault(HostErrorCodes.InvalidArgument, "params." + field + " must be an object");
            RequireReady();
            AgentLink link;
            int child;
            lock (stateLock)
            {
                link = agent;
                child = childSession;
            }
            if (link == null || child <= 0) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
            ThrowIfCancelled(relay);
            var forwarded = new Dictionary<string, object>();
            forwarded["sessionId"] = child;
            forwarded[field] = payload;
            string source = WireJson.GetString(parameters, "source");
            if (source != null) forwarded["source"] = source;
            string taskId = WireJson.GetString(parameters, "taskId");
            if (taskId != null) forwarded["taskId"] = taskId;
            Dictionary<string, object> result = link.Call(field, forwarded, RelayTimeoutMs, relay);
            if (result == null) result = new Dictionary<string, object>();
            return result;
        }

        /// <summary>
        /// Relays one bounded Cua MCP request to the session agent. The driver path is the trusted absolute
        /// path the Node backend resolved and pinned; the agent runs it inside the child session, so the
        /// driver only ever sees that session's desktop.
        /// </summary>
        private object Cua(Dictionary<string, object> parameters, WireRelay relay)
        {
            CheckFields(parameters, CuaFields, "cua");
            RequireSession(parameters);
            string driverPath = WireJson.GetString(parameters, "driverPath");
            if (string.IsNullOrEmpty(driverPath) || driverPath.Length > MaxCuaDriverPathChars)
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "params.driverPath must be a non-empty string");
            }
            Dictionary<string, object> cuaRequest = WireJson.GetObject(parameters, "request");
            if (cuaRequest == null) throw new HostFault(HostErrorCodes.InvalidArgument, "params.request must be an object");
            string unknown;
            if (WireJson.HasUnexpectedField(cuaRequest, CuaRequestFields, out unknown))
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "unknown cua request field: " + unknown);
            }
            string mcpMethod = WireJson.GetString(cuaRequest, "method");
            if (mcpMethod != "tools/list" && mcpMethod != "tools/call")
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "cua request.method must be tools/list or tools/call");
            }
            if (mcpMethod == "tools/call")
            {
                Dictionary<string, object> mcpParams = WireJson.GetObject(cuaRequest, "params");
                if (mcpParams == null || string.IsNullOrEmpty(WireJson.GetString(mcpParams, "name")))
                {
                    throw new HostFault(HostErrorCodes.InvalidArgument, "tools/call params.name must be a non-empty string");
                }
                if (WireJson.HasUnexpectedField(mcpParams, CuaParamFields, out unknown))
                {
                    throw new HostFault(HostErrorCodes.InvalidArgument, "unknown tools/call params field: " + unknown);
                }
                object rawArguments = WireJson.Get(mcpParams, "arguments");
                if (rawArguments != null && !(rawArguments is Dictionary<string, object>))
                {
                    throw new HostFault(HostErrorCodes.InvalidArgument, "tools/call params.arguments must be an object");
                }
            }
            RequireReady();
            AgentLink link;
            int child;
            lock (stateLock)
            {
                link = agent;
                child = childSession;
            }
            if (link == null || child <= 0) throw new HostFault(HostErrorCodes.NotReady, "the child session agent is not connected");
            ThrowIfCancelled(relay);
            var forwarded = new Dictionary<string, object>();
            forwarded["sessionId"] = child;
            forwarded["driverPath"] = driverPath;
            forwarded["request"] = cuaRequest;
            string source = WireJson.GetString(parameters, "source");
            if (source != null) forwarded["source"] = source;
            string taskId = WireJson.GetString(parameters, "taskId");
            if (taskId != null) forwarded["taskId"] = taskId;
            // A cancelled or timed-out call kills the driver in the agent; the result stays unconfirmed and
            // nothing is replayed. The agent response is already the raw MCP result object.
            Dictionary<string, object> result = link.Call("cua", forwarded, CuaRelayTimeoutMs, relay, CuaCancelSettleMs);
            if (result == null) throw new HostFault(HostErrorCodes.BackendFailed, "the child session agent returned no cua result");
            Dictionary<string, object> mcpResult = WireJson.GetObject(result, "result");
            if (mcpResult == null) throw new HostFault(HostErrorCodes.BackendFailed, "the child session agent returned an invalid cua result");
            return mcpResult;
        }

        private static void ThrowIfCancelled(WireRelay relay)
        {
            if (relay != null && relay.Cancelled)
            {
                throw new HostFault(HostErrorCodes.Cancelled, "the request was cancelled before it reached the child session", "not-sent");
            }
        }

        private static Dictionary<string, object> BuildFrameLimits(Dictionary<string, object> limits)
        {
            CheckFields(limits, FrameLimitFields, "limits");
            var result = new Dictionary<string, object>();
            result["maxWidth"] = DimensionLimit(limits, "maxWidth", AgentCaptureLimits.DefaultMaxWidth);
            result["maxHeight"] = DimensionLimit(limits, "maxHeight", AgentCaptureLimits.DefaultMaxHeight);
            result["maxBytes"] = ByteLimit(limits, "maxBytes", AgentCaptureLimits.DefaultMaxBytes);
            return result;
        }

        private static int DimensionLimit(Dictionary<string, object> limits, string name, int fallback)
        {
            object raw = WireJson.Get(limits, name);
            if (raw == null) return fallback;
            int? value = WireJson.Int(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinDimension || value.Value > AgentCaptureLimits.MaxDimension)
            {
                throw new HostFault(
                    HostErrorCodes.InvalidArgument,
                    "frame.limits." + name + " must be " + AgentCaptureLimits.MinDimension.ToString(CultureInfo.InvariantCulture) + ".." + AgentCaptureLimits.MaxDimension.ToString(CultureInfo.InvariantCulture));
            }
            return value.Value;
        }

        private static long ByteLimit(Dictionary<string, object> limits, string name, int fallback)
        {
            object raw = WireJson.Get(limits, name);
            if (raw == null) return fallback;
            long? value = WireJson.Long(raw);
            if (value == null || value.Value < AgentCaptureLimits.MinLimitBytes)
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "frame.limits.maxBytes must be at least " + AgentCaptureLimits.MinLimitBytes.ToString(CultureInfo.InvariantCulture));
            }
            // The agent cannot encode beyond its own cap; a larger budget is satisfied by a smaller frame.
            return Math.Min(value.Value, (long)AgentCaptureLimits.MaxLimitBytes);
        }

        private void CacheSourceSize(Dictionary<string, object> frame)
        {
            int? width = WireJson.Int(WireJson.Get(frame, "width"));
            int? height = WireJson.Int(WireJson.Get(frame, "height"));
            lock (stateLock)
            {
                if (width != null && width.Value > 0) sourceWidth = width.Value;
                if (height != null && height.Value > 0) sourceHeight = height.Value;
                updatedAt = DateTime.UtcNow;
            }
        }

        // ---------------------------------------------------------------------------------- preview, cancel, release

        private object Preview(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, PreviewFields, "preview");
            string requested = RequireSession(parameters);
            string mode = WireJson.GetString(parameters, "preview");
            if (mode == null) mode = WireJson.GetString(parameters, "mode");
            if (string.IsNullOrEmpty(mode))
            {
                throw new HostFault(HostErrorCodes.InvalidArgument, "params.preview must be visible, minimized, offscreen or hidden");
            }
            mode = mode.ToLowerInvariant();
            if (mode != "visible" && mode != "minimized" && mode != "offscreen" && mode != "hidden")
            {
                throw new HostFault(HostErrorCodes.Unsupported, "preview mode " + mode + " is not supported; expected visible, minimized, offscreen or hidden");
            }
            ApplyPreview(mode);
            var result = new Dictionary<string, object>();
            result["sessionId"] = requested;
            result["preview"] = mode == "minimized" ? "hidden" : mode;
            return result;
        }

        private object Cancel(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, CancelFields, "cancel");
            string requestId = WireJson.GetString(parameters, "requestId");
            if (string.IsNullOrEmpty(requestId)) throw new HostFault(HostErrorCodes.InvalidArgument, "params.requestId is required");
            WireRelay relay;
            AgentLink link;
            lock (stateLock)
            {
                relays.TryGetValue(requestId, out relay);
                link = agent;
            }
            bool cancelled = false;
            if (relay != null)
            {
                relay.Cancel();
                cancelled = true;
                string agentRequestId = relay.AgentRequestId;
                // Cancellation must never replay input; the agent stops the operation in flight.
                if (agentRequestId != null && link != null) link.CancelRemote(agentRequestId);
            }
            var result = new Dictionary<string, object>();
            result["requestId"] = requestId;
            result["cancelled"] = cancelled;
            return result;
        }

        private object Release(Dictionary<string, object> parameters)
        {
            CheckFields(parameters, ReleaseFields, "release");
            string requested = WireJson.GetString(parameters, "sessionId");
            string owned;
            lock (stateLock)
            {
                if (sessionId == null) return Released(null);
                if (!string.IsNullOrEmpty(requested) && !string.Equals(requested, sessionId, StringComparison.Ordinal))
                {
                    throw new HostFault(HostErrorCodes.SessionMismatch, "session " + requested + " is not owned by this host");
                }
                owned = sessionId;
            }
            Cleanup(owned, "release");
            HostLog.Info("released session " + owned);
            return Released(owned);
        }

        private static Dictionary<string, object> Released(string owned)
        {
            var result = new Dictionary<string, object>();
            result["released"] = true;
            result["sessionId"] = owned;
            result["phase"] = "closed";
            return result;
        }

        private void Cleanup(string owned, string reason)
        {
            lock (cleanupLock)
            {
                int child;
                bool ownedChild;
                lock (stateLock)
                {
                    if (sessionId != null && owned != null && !string.Equals(sessionId, owned, StringComparison.Ordinal)) return;
                    // Invalidate any start worker still running for the previous session.
                    generation++;
                    child = childSession;
                    ownedChild = ownsChild;
                    sessionId = null;
                    childSession = 0;
                    ownsChild = false;
                    sourceWidth = 0;
                    sourceHeight = 0;
                    frameSerial = 0;
                    loginFault = null;
                    updatedAt = DateTime.UtcNow;
                }
                AbortAgent();
                try
                {
                    ApplyPreview("hidden");
                }
                catch (Exception ex)
                {
                    HostLog.Warn("preview cleanup failed: " + ex.Message);
                }
                DisconnectRdp();
                LogOffChild(child, ownedChild);
                // Unblocks a start worker waiting for logon so it can observe the stale generation.
                loginComplete.Set();
                SetPhase("closed", null, null);
                HostLog.Info("session " + (owned ?? "none") + " cleaned up (" + reason + ")");
            }
        }

        private void AbortAgent()
        {
            AgentLink link;
            lock (stateLock)
            {
                link = agent;
                agent = null;
            }
            if (link == null) return;
            try
            {
                link.ReleaseAndClose(SessionCloseTimeoutMs);
            }
            catch (Exception ex)
            {
                HostLog.Warn("agent cleanup failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Only a child session this host created is logged off; a pre-existing one is left alone.
        /// Logoff is fire-and-forget (wait:false does not wait for the system logoff); release is
        /// confirmed only after the child id is no longer reported AND the session left the
        /// logged-on state, within a bounded poll. A refused send or a timed-out child is a
        /// failure, never a released report.
        /// </summary>
        private void LogOffChild(int child, bool owned)
        {
            if (!owned || child <= 0 || child == parentSessionId) return;
            HostLog.Info("logging off the owned child session " + child.ToString(CultureInfo.InvariantCulture));
            if (!HostNative.LogoffSession(child))
            {
                throw new HostFault(HostErrorCodes.BackendFailed, "logoff of child session " + child.ToString(CultureInfo.InvariantCulture) + " was refused");
            }
            var deadline = Stopwatch.StartNew();
            while (deadline.ElapsedMilliseconds < LogoffVerifyTimeoutMs)
            {
                int current = HostNative.ChildSessionId();
                bool idGone = current != HostNative.UnsupportedChildSessions && current != child;
                bool loggedOff = !BootstrapNative.SessionLoggedOn((uint)child);
                if (idGone && loggedOff) return;
                Thread.Sleep(250);
            }
            HostLog.Warn("child session " + child.ToString(CultureInfo.InvariantCulture) + " was still logged on after the logoff request");
            throw new HostFault(HostErrorCodes.BackendFailed, "child session " + child.ToString(CultureInfo.InvariantCulture) + " did not finish logging off within " + LogoffVerifyTimeoutMs.ToString(CultureInfo.InvariantCulture) + " ms");
        }

        // ---------------------------------------------------------------------------------- onboarding

        /// <summary>
        /// 显式本地一次性凭据引导（shower-setup）：prepare 授权 → 弹 Windows 凭据框（预填当前账户，明示非 PIN）→
        /// 建临时子会话，登录并等到虚拟屏 ready 作为账户与密码验证 → 验证通过才写入本用户凭据管理器 →
        /// finally 注销临时会话；guardian 随本进程退出恢复子会话开关与 TermService。
        /// stdout 最后一行是 {"configured":true,"verified":true} 或 {"error":{"code","message"}}（非零退出）。
        /// </summary>
        internal static int RunOnboarding(string[] args)
        {
            string stateDir = null;
            bool invalid = args == null;
            for (int i = 0; !invalid && i < args.Length; i++)
            {
                if (stateDir == null
                    && string.Equals(args[i], "--state-dir", StringComparison.OrdinalIgnoreCase)
                    && i + 1 < args.Length
                    && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    stateDir = args[++i];
                }
                else
                {
                    invalid = true;
                }
            }
            if (invalid || string.IsNullOrEmpty(stateDir) || !Path.IsPathRooted(stateDir))
            {
                return ReportOnboarding(HostErrorCodes.InvalidArgument, "setup requires exactly --state-dir <absolute directory>", 2);
            }
            string resolved;
            try
            {
                resolved = Path.GetFullPath(stateDir);
                Directory.CreateDirectory(resolved);
            }
            catch (Exception ex)
            {
                return ReportOnboarding(HostErrorCodes.InvalidArgument, "state dir is unusable: " + ex.Message, 2);
            }
            return new RdpHost(resolved).ExecuteOnboarding();
        }

        private int ExecuteOnboarding()
        {
            // 已有别的 child/session 时明确 busy，先失败再接管的顺序不变。
            int existing = HostNative.ChildSessionId();
            if (existing == HostNative.UnsupportedChildSessions)
            {
                return ReportOnboarding(HostErrorCodes.Unavailable, "this Windows build does not support child sessions", 1);
            }
            if (existing > 0)
            {
                return ReportOnboarding(HostErrorCodes.Busy, "another child session already exists; it will not be adopted", 1);
            }
            var budget = Stopwatch.StartNew();
            StartUiThread();
            if (!uiReady.Wait(UiStartTimeoutMs) || uiFault != null)
            {
                HostLog.Warn("rdp window failed: " + (uiFault ?? "it did not start in time"));
                ShutdownUi();
                return ReportOnboarding(HostErrorCodes.Unavailable, "the rdp window is not available: " + (uiFault ?? "it did not start in time"), 1);
            }
            // 进程私有开关：只有这条显式命令允许 PrepareCredentials 弹凭据框。
            onboarding = true;
            string onboardingSession = "credential-setup-" + Guid.NewGuid().ToString("N");
            HostFault failure = null;
            Exception cleanupFault = null;
            bool verified = false;
            bool saved = false;
            try
            {
                Prepare(new Dictionary<string, object>());
                for (int attempt = 1; attempt <= OnboardingMaxAttempts && !verified; attempt++)
                {
                    var parameters = new Dictionary<string, object>();
                    parameters["sessionId"] = onboardingSession;
                    Ensure(parameters);
                    failure = WaitForOnboardingOutcome(budget, out verified);
                    if (verified)
                    {
                        RunOnUi(delegate { saved = CommitPendingCredential(); });
                        break;
                    }
                    string owned = CurrentSession();
                    if (owned != null)
                    {
                        try
                        {
                            Cleanup(owned, "onboarding-retry");
                        }
                        catch (Exception ex)
                        {
                            cleanupFault = ex;
                            HostLog.Warn("onboarding cleanup failed: " + ex.Message);
                            break;
                        }
                    }
                    if (failure == null || !IsRetryableOnboarding(failure.Code)) break;
                }
            }
            catch (HostFault fault)
            {
                failure = fault;
            }
            catch (Exception ex)
            {
                failure = new HostFault(HostErrorCodes.BackendFailed, ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                try
                {
                    string owned = CurrentSession();
                    if (owned != null) Cleanup(owned, "onboarding");
                }
                catch (Exception ex)
                {
                    cleanupFault = ex;
                    HostLog.Warn("onboarding cleanup failed: " + ex.Message);
                }
                ShutdownUi();
            }
            if (!verified)
            {
                if (failure == null) failure = new HostFault(HostErrorCodes.BackendFailed, "credential verification did not finish");
                return ReportOnboarding(failure.Code, failure.Message, 1);
            }
            if (!saved)
            {
                return ReportOnboarding(HostErrorCodes.BackendFailed, "the verified credential was not committed", 1);
            }
            if (cleanupFault != null)
            {
                // 凭据已保存但临时会话释放失败：绝不报 configured；父 launcher 外层清理兜底。
                return ReportOnboarding(
                    HostErrorCodes.BackendFailed,
                    "the credential was saved but the verification session could not be released: " + cleanupFault.Message,
                    1);
            }
            var done = new Dictionary<string, object>();
            done["configured"] = true;
            done["verified"] = true;
            WriteOnboardingLine(done);
            return 0;
        }

        /// <summary>轮询会话状态机直到 ready / authentication-required / error，或预算耗尽；只有 ready 才视为凭据已验证。</summary>
        private HostFault WaitForOnboardingOutcome(Stopwatch budget, out bool verified)
        {
            verified = false;
            for (;;)
            {
                if (budget.ElapsedMilliseconds >= OnboardingBudgetMs)
                {
                    return new HostFault(HostErrorCodes.BackendFailed, "credential verification did not finish within " + OnboardingBudgetMs.ToString(CultureInfo.InvariantCulture) + " ms");
                }
                string current;
                string code;
                string message;
                string owned;
                lock (stateLock)
                {
                    current = phase;
                    code = phaseCode;
                    message = phaseMessage;
                    owned = sessionId;
                }
                if (owned == null || string.Equals(current, "closed", StringComparison.Ordinal))
                {
                    return new HostFault(HostErrorCodes.Unavailable, "the verification session ended before it was ready");
                }
                if (string.Equals(current, "ready", StringComparison.Ordinal))
                {
                    verified = true;
                    return null;
                }
                if (string.Equals(current, "authentication-required", StringComparison.Ordinal))
                {
                    // 未达 ready：登录被拒或桌面仍在解锁，都不构成凭据已验证；不写新凭据，允许有限重试。
                    return new HostFault(HostErrorCodes.AuthRequired, message ?? "the verification session did not reach ready");
                }
                if (string.Equals(current, "error", StringComparison.Ordinal))
                {
                    return new HostFault(code ?? HostErrorCodes.BackendFailed, message ?? "credential verification failed");
                }
                Thread.Sleep(200);
            }
        }

        /// <summary>密码被拒或账户格式输入错误可以重试；取消与其他失败直接返回。</summary>
        private static bool IsRetryableOnboarding(string code)
        {
            return string.Equals(code, HostErrorCodes.AuthRequired, StringComparison.Ordinal)
                || string.Equals(code, HostErrorCodes.InvalidArgument, StringComparison.Ordinal);
        }

        /// <summary>UI 线程上把已验证的凭据写入本用户凭据管理器；返回是否真正落盘。</summary>
        private bool CommitPendingCredential()
        {
            if (pendingCredential == null) return false;
            pendingCredential.Commit();
            ClearPendingCredential();
            return true;
        }

        private static int ReportOnboarding(string code, string message, int exitCode)
        {
            var error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message ?? string.Empty;
            var envelope = new Dictionary<string, object>();
            envelope["error"] = error;
            WriteOnboardingLine(envelope);
            return exitCode;
        }

        private static void WriteOnboardingLine(Dictionary<string, object> payload)
        {
            try
            {
                Console.Out.WriteLine(WireJson.Serialize(payload));
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                HostLog.Warn("cannot write the onboarding result: " + ex.Message);
            }
        }
    }
}
