// lumen-capture-helper: the three things Lumen's screen recorder cannot get from
// Chromium - one app's sound, the cursor as data, and exact window facts - plus
// bringing a window to the front and keeping Lumen's timers fine while it records.
// See README.md for the command line and the stream formats.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;

[assembly: AssemblyTitle("Lumen capture helper")]
[assembly: AssemblyDescription("Per-app audio, cursor and window data for Lumen's screen recorder")]
[assembly: AssemblyProduct("Lumen")]
[assembly: AssemblyCompany("AsyncTech")]
[assembly: AssemblyCopyright("Copyright (c) AsyncTech")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace Lumen.CaptureHelper
{
    // An error the parent should be told about: one JSON line on stderr and an exit code.
    internal sealed class HelperException : Exception
    {
        internal readonly string Code;
        internal readonly int ExitCode;

        internal HelperException(string code, int exitCode, string message) : base(message)
        {
            Code = code;
            ExitCode = exitCode;
        }
    }

    internal static class Program
    {
        internal const string Version = "1.0.0";

        internal const int ExitOk = 0;
        internal const int ExitFailed = 1;
        internal const int ExitNoProcess = 2;
        internal const int ExitUnsupported = 3;
        internal const int ExitUsage = 64;

        // Process loopback (the sound of one app) arrived in Windows build 20348.
        internal const int ProcessLoopbackBuild = 20348;

        private const string Usage =
            "Use: windows | window --hwnd <n> | focus --hwnd <n> | audio (--pid <n> | --hwnd <n>) [--exclude] | cursor [--hz <30..240>] [--hwnd <n>] | timers --pid <n> [--pid <n> ...] [--release] | version.";

        [MTAThread]
        private static int Main(string[] args)
        {
            // No "has stopped working" dialog, whatever happens.
            Native.SetErrorMode(Native.SEM_FAILCRITICALERRORS | Native.SEM_NOGPFAULTERRORBOX | Native.SEM_NOOPENFILEERRORBOX);
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

            int code;
            try
            {
                // The manifest already asks for per-monitor-v2 awareness (then this call
                // is refused, harmlessly); this covers an exe built without it.
                // Coordinates must be physical pixels.
                try
                {
                    Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
                }
                catch (EntryPointNotFoundException)
                {
                }
                code = Run(args);
            }
            catch (HelperException e)
            {
                Out.Error(e.Code, e.Message);
                code = e.ExitCode;
            }
            catch (System.IO.IOException)
            {
                // stdout was closed under us: the reader is gone, there is nobody to tell.
                code = ExitOk;
            }
            catch (Exception e)
            {
                Out.Error("failed", "The capture helper stopped unexpectedly: " + e.GetType().Name + ": " + e.Message);
                code = ExitFailed;
            }
            // Exit, rather than return, so no thread (the stdin reader, a COM callback) can keep us alive.
            Environment.Exit(code);
            return code;
        }

        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            Out.Error("failed", "The capture helper stopped unexpectedly: "
                + (ex != null ? ex.GetType().Name + ": " + ex.Message : "unknown error"));
            Environment.Exit(ExitFailed);
        }

        private static int Run(string[] args)
        {
            if (args.Length == 0) throw BadArguments("No command given.");
            string command = args[0];

            bool hasPid = false, hasHwnd = false, exclude = false, stats = false, hasHz = false, release = false;
            uint pid = 0;
            List<uint> pids = new List<uint>();
            IntPtr hwnd = IntPtr.Zero;
            int hz = 120;

            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--pid")
                {
                    long v = Number(args, ++i, a);
                    if (v < 0 || v > uint.MaxValue) throw BadArguments("--pid needs a process id.");
                    pid = (uint)v;
                    pids.Add(pid);
                    hasPid = true;
                }
                else if (a == "--hwnd")
                {
                    hwnd = new IntPtr(Number(args, ++i, a));
                    hasHwnd = true;
                }
                else if (a == "--hz")
                {
                    long v = Number(args, ++i, a);
                    if (v < 30 || v > 240) throw BadArguments("--hz must be between 30 and 240.");
                    hz = (int)v;
                    hasHz = true;
                }
                else if (a == "--exclude") exclude = true;
                else if (a == "--stats") stats = true;
                else if (a == "--release") release = true;
                else throw BadArguments("Unknown option \"" + a + "\".");
            }

            // Only `timers` takes more than one process, and only it can release.
            if (command != "timers" && (pids.Count > 1 || release)) throw BadArguments(pids.Count > 1 ? "--pid was given more than once." : "An option was given that \"" + command + "\" does not take.");

            switch (command)
            {
                case "version":
                    Reject(command, hasPid || hasHwnd || hasHz || exclude || stats);
                    return RunVersion();

                case "windows":
                    Reject(command, hasPid || hasHwnd || hasHz || exclude || stats);
                    return Windows.RunList();

                case "window":
                    Reject(command, hasPid || hasHz || exclude || stats);
                    if (!hasHwnd) throw BadArguments("window needs --hwnd <n>.");
                    return Windows.RunOne(hwnd);

                case "focus":
                    Reject(command, hasPid || hasHz || exclude || stats);
                    if (!hasHwnd) throw BadArguments("focus needs --hwnd <n>.");
                    return Focus.Run(hwnd);

                case "audio":
                    Reject(command, hasHz);
                    if (hasPid == hasHwnd) throw BadArguments("audio needs exactly one of --pid <n> or --hwnd <n>.");
                    if (hasHwnd)
                    {
                        if (!Native.IsWindow(hwnd))
                        {
                            throw new HelperException("no-process", ExitNoProcess, "There is no window with handle " + hwnd.ToInt64() + ".");
                        }
                        string unused;
                        pid = Windows.OwnerProcess(hwnd, out unused);
                    }
                    StopSignal.Start();
                    return ProcessLoopback.Run(pid, exclude, stats);

                case "cursor":
                    Reject(command, hasPid || exclude);
                    StopSignal.Start();
                    return CursorTracker.Run(hz, hwnd, hasHwnd, stats);

                case "timers":
                    Reject(command, hasHwnd || hasHz || exclude || stats);
                    if (!hasPid) throw BadArguments("timers needs --pid <n>.");
                    return Timers.Run(pids, release);

                default:
                    throw BadArguments("Unknown command \"" + command + "\".");
            }
        }

        private static int RunVersion()
        {
            int build = OsBuild();
            StringBuilder sb = new StringBuilder(96);
            sb.Append("{\"version\":\"").Append(Version).Append("\",\"build\":").Append(build);
            sb.Append(",\"processLoopback\":").Append(build >= ProcessLoopbackBuild ? "true" : "false").Append('}');
            Out.Line(Out.Stdout, sb);
            return ExitOk;
        }

        // The real Windows build number. RtlGetVersion is not subject to the
        // compatibility shims that make GetVersionEx (Environment.OSVersion) report
        // Windows 8 to a program without the right manifest.
        internal static int OsBuild()
        {
            try
            {
                OSVERSIONINFOEXW info = new OSVERSIONINFOEXW();
                info.dwOSVersionInfoSize = 284;
                if (Native.RtlGetVersion(ref info) == 0 && info.dwBuildNumber > 0) return info.dwBuildNumber;
            }
            catch (Exception)
            {
            }
            return Environment.OSVersion.Version.Build;
        }

        private static long Number(string[] args, int index, string option)
        {
            if (index >= args.Length) throw BadArguments(option + " needs a number.");
            string text = args[index];
            long value;
            bool ok;
            if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                ok = long.TryParse(text.Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out value);
            }
            else
            {
                ok = long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value);
            }
            if (!ok) throw BadArguments(option + " needs a number, not \"" + text + "\".");
            return value;
        }

        private static void Reject(string command, bool hasForeignOption)
        {
            if (hasForeignOption) throw BadArguments("An option was given that \"" + command + "\" does not take.");
        }

        private static HelperException BadArguments(string what)
        {
            return new HelperException("failed", ExitUsage, what + " " + Usage);
        }
    }
}
