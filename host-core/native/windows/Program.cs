using System;
using System.Text;

namespace ELauncher.Shower
{
    /// <summary>
    /// Entry point for shower-windows.exe: host runs in the parent session, agent runs inside the child
    /// session and bootstrap-* commands are handled by SessionBootstrap.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                // JSONL is UTF-8 in both directions; typed text must survive unchanged.
                Console.InputEncoding = new UTF8Encoding(false);
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            catch (Exception ex)
            {
                HostLog.Warn("cannot force utf-8 console encoding: " + ex.Message);
            }
            try
            {
                if (args == null || args.Length == 0)
                {
                    HostLog.Warn("usage: shower-windows host --state-dir <absolute directory> | agent --pipe <name> --session-id <n> | bootstrap-<step>");
                    return 2;
                }
                string command = args[0];
                if (string.Equals(command, "host", StringComparison.Ordinal)) return RdpHost.Run(Tail(args));
                if (string.Equals(command, "agent", StringComparison.Ordinal)) return RunAgent(Tail(args));
                if (command != null && command.StartsWith("bootstrap-", StringComparison.Ordinal)) return SessionBootstrap.Run(args);
                HostLog.Warn("unknown command: " + command);
                return 2;
            }
            catch (Exception ex)
            {
                HostLog.Warn("fatal " + ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        private static int RunAgent(string[] args)
        {
            string pipeName = CommandLine.Value(args, "--pipe");
            int? sessionId = CommandLine.IntValue(args, "--session-id");
            if (string.IsNullOrEmpty(pipeName) || sessionId == null)
            {
                HostLog.Warn("agent requires --pipe <name> and --session-id <n>");
                return 2;
            }
            return SessionAgent.Run(pipeName, sessionId.Value);
        }

        private static string[] Tail(string[] args)
        {
            var rest = new string[args.Length - 1];
            Array.Copy(args, 1, rest, 0, rest.Length);
            return rest;
        }
    }
}
