using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace ELauncher.Shower
{
    /// <summary>Shared shower error codes; the host and the child-session agent agree on these names.</summary>
    internal static class HostErrorCodes
    {
        internal const string Unavailable = "SHOWER_UNAVAILABLE";
        internal const string Unsupported = "SHOWER_UNSUPPORTED";
        internal const string Busy = "SHOWER_BUSY";
        internal const string AuthRequired = "SHOWER_AUTH_REQUIRED";
        internal const string PermissionRequired = "SHOWER_PERMISSION_REQUIRED";
        internal const string SessionNotFound = "SHOWER_SESSION_NOT_FOUND";
        internal const string SessionMismatch = "SHOWER_SESSION_MISMATCH";
        internal const string NotReady = "SHOWER_NOT_READY";
        internal const string InputFailed = "SHOWER_INPUT_FAILED";
        internal const string FrameTooLarge = "SHOWER_FRAME_TOO_LARGE";
        internal const string BackendFailed = "SHOWER_BACKEND_FAILED";
        internal const string InvalidArgument = "INVALID_ARGUMENT";
        internal const string Cancelled = "CANCELLED";
    }

    /// <summary>Bounded failure with a protocol code, optionally carrying not-sent/unconfirmed semantics.</summary>
    internal sealed class HostFault : Exception
    {
        internal HostFault(string code, string message)
            : this(code, message, null)
        {
        }

        internal HostFault(string code, string message, string outcome)
            : base(message)
        {
            Code = code;
            Outcome = outcome;
        }

        internal string Code { get; private set; }

        internal string Outcome { get; private set; }
    }

    /// <summary>Diagnostics only on stderr; request payloads, image data and credentials are never logged.</summary>
    internal static class HostLog
    {
        internal static void Info(string message)
        {
            Write("info", message);
        }

        internal static void Warn(string message)
        {
            Write("warn", message);
        }

        private static void Write(string level, string message)
        {
            try
            {
                Console.Error.WriteLine(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " shower-windows " + level + " " + message);
                Console.Error.Flush();
            }
            catch (Exception)
            {
            }
        }
    }

    /// <summary>One in-flight Node request, so cancel can flag it and reach the matching agent request.</summary>
    internal sealed class WireRelay
    {
        private volatile bool cancelled;
        private volatile string agentRequestId;

        internal bool Cancelled
        {
            get { return cancelled; }
        }

        internal string AgentRequestId
        {
            get { return agentRequestId; }
            set { agentRequestId = value; }
        }

        internal void Cancel()
        {
            cancelled = true;
        }
    }

    internal sealed class WireRequest
    {
        internal WireRequest(string id, string method, Dictionary<string, object> parameters)
        {
            Id = id;
            Method = method;
            Params = parameters;
        }

        internal string Id { get; private set; }

        internal string Method { get; private set; }

        internal Dictionary<string, object> Params { get; private set; }
    }

    /// <summary>JSONL responses on stdout: one line per request, plus optional unsolicited status events.</summary>
    internal sealed class WireWriter
    {
        private readonly object gate = new object();
        private readonly TextWriter output;

        internal WireWriter(TextWriter output)
        {
            this.output = output;
            // JSONL consumers split on \n; a trailing carriage return would corrupt every line.
            if (this.output != null) this.output.NewLine = "\n";
        }

        internal void Result(string id, object result)
        {
            var envelope = new Dictionary<string, object>();
            envelope["id"] = id ?? string.Empty;
            envelope["ok"] = true;
            envelope["result"] = result;
            Write(envelope);
        }

        internal void Failure(string id, string code, string message, string outcome)
        {
            var error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message ?? string.Empty;
            if (!string.IsNullOrEmpty(outcome)) error["outcome"] = outcome;
            var envelope = new Dictionary<string, object>();
            envelope["id"] = id ?? string.Empty;
            envelope["ok"] = false;
            envelope["error"] = error;
            Write(envelope);
        }

        internal void StatusEvent(Dictionary<string, object> status)
        {
            var envelope = new Dictionary<string, object>();
            envelope["event"] = "status";
            envelope["status"] = status;
            Write(envelope);
        }

        private void Write(Dictionary<string, object> envelope)
        {
            string line;
            try
            {
                line = WireJson.Serialize(envelope);
            }
            catch (Exception ex)
            {
                HostLog.Warn("cannot serialize a response: " + ex.Message);
                return;
            }
            lock (gate)
            {
                try
                {
                    output.WriteLine(line);
                    output.Flush();
                }
                catch (Exception ex)
                {
                    HostLog.Warn("cannot write to stdout: " + ex.Message);
                }
            }
        }
    }

    internal static class WireJson
    {
        private const int MaxJsonChars = 16 * 1024 * 1024;

        internal static string Serialize(object value)
        {
            return CreateSerializer().Serialize(value);
        }

        internal static Dictionary<string, object> TryParseObject(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try
            {
                return CreateSerializer().DeserializeObject(text) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static object Get(Dictionary<string, object> values, string name)
        {
            if (values == null) return null;
            object value;
            return values.TryGetValue(name, out value) ? value : null;
        }

        internal static string GetString(Dictionary<string, object> values, string name)
        {
            return Get(values, name) as string;
        }

        internal static Dictionary<string, object> GetObject(Dictionary<string, object> values, string name)
        {
            return Get(values, name) as Dictionary<string, object>;
        }

        internal static int? Int(object value)
        {
            if (value is int) return (int)value;
            if (value is long)
            {
                var wide = (long)value;
                if (wide < int.MinValue || wide > int.MaxValue) return null;
                return (int)wide;
            }
            if (value is decimal)
            {
                var exact = (decimal)value;
                if (exact != decimal.Truncate(exact) || exact < int.MinValue || exact > int.MaxValue) return null;
                return (int)exact;
            }
            if (value is double)
            {
                var real = (double)value;
                if (double.IsNaN(real) || double.IsInfinity(real) || real != Math.Truncate(real)) return null;
                if (real < int.MinValue || real > int.MaxValue) return null;
                return (int)real;
            }
            return null;
        }

        internal static long? Long(object value)
        {
            if (value is long) return (long)value;
            if (value is int) return (int)value;
            if (value is decimal)
            {
                var exact = (decimal)value;
                if (exact != decimal.Truncate(exact)) return null;
                return (long)exact;
            }
            if (value is double)
            {
                var real = (double)value;
                if (double.IsNaN(real) || double.IsInfinity(real) || real != Math.Truncate(real)) return null;
                return (long)real;
            }
            return null;
        }

        /// <summary>Unknown fields are rejected loudly instead of being ignored.</summary>
        internal static bool HasUnexpectedField(Dictionary<string, object> values, string[] allowed, out string unknown)
        {
            unknown = null;
            if (values == null) return false;
            foreach (string key in values.Keys)
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
                    unknown = key;
                    return true;
                }
            }
            return false;
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            var serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaxJsonChars;
            serializer.RecursionLimit = 32;
            return serializer;
        }
    }

    internal static class CommandLine
    {
        internal static string Value(string[] args, string name)
        {
            if (args == null) return null;
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        internal static int? IntValue(string[] args, string name)
        {
            string text = Value(args, name);
            if (text == null) return null;
            int value;
            if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return null;
            return value;
        }
    }
}
