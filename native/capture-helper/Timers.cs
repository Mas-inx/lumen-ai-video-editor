// Keeps Windows honouring Lumen's timers while its windows are covered:
// `timers --pid <n> [--pid <n> ...] [--release]`.
//
// From Windows 11, a process whose windows are all covered, minimized or otherwise
// out of sight no longer gets the timer resolution it asked for: its timers fall
// back to 15.6 ms ticks. Chromium captures a screen or a window on a timer in
// Lumen's main process, so with a game in front of Lumen a 60 fps recording got a
// frame every second tick, 32 a second. A process can be exempted
// (PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION); Lumen asks for that while it
// records and hands it back afterwards.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Lumen.CaptureHelper
{
    internal static class Timers
    {
        // Windows started doing this in Windows 11; before it there is nothing to undo.
        internal const int FirstBuild = 22000;

        internal static int Run(List<uint> pids, bool release)
        {
            StringBuilder sb = new StringBuilder(128);
            bool needed = Program.OsBuild() >= FirstBuild;
            sb.Append("{\"needed\":").Append(needed ? "true" : "false");
            sb.Append(",\"held\":").Append(needed && !release ? "true" : "false");
            sb.Append(",\"set\":[");
            StringBuilder failed = new StringBuilder();
            bool first = true;
            if (needed)
            {
                foreach (uint pid in pids)
                {
                    int error = Apply(pid, release);
                    if (error == 0)
                    {
                        if (!first) sb.Append(',');
                        sb.Append(pid);
                        first = false;
                    }
                    else
                    {
                        if (failed.Length > 0) failed.Append(',');
                        failed.Append("{\"pid\":").Append(pid).Append(",\"error\":").Append(error).Append('}');
                    }
                }
            }
            sb.Append("],\"failed\":[").Append(failed.ToString()).Append("]}");
            Out.Line(Out.Stdout, sb);
            return Program.ExitOk;
        }

        // 0, or the Windows error code.
        private static int Apply(uint pid, bool release)
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_SET_INFORMATION | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) process = Native.OpenProcess(Native.PROCESS_SET_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
            try
            {
                int size = Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE));
                // Only the timer bit is changed: whatever else the process (Chromium) set stays.
                PROCESS_POWER_THROTTLING_STATE state = new PROCESS_POWER_THROTTLING_STATE();
                state.Version = Native.PROCESS_POWER_THROTTLING_CURRENT_VERSION;
                if (!Native.GetProcessInformation(process, Native.ProcessPowerThrottling, ref state, size))
                {
                    state.ControlMask = 0;
                    state.StateMask = 0;
                }
                state.Version = Native.PROCESS_POWER_THROTTLING_CURRENT_VERSION;
                // Controlled and off: "never ignore this process's timer resolution".
                // Not controlled: Windows decides again.
                if (release) state.ControlMask &= ~Native.PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
                else state.ControlMask |= Native.PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
                state.StateMask &= ~Native.PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
                return Native.SetProcessInformation(process, Native.ProcessPowerThrottling, ref state, size) ? 0 : Marshal.GetLastWin32Error();
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }
    }
}
