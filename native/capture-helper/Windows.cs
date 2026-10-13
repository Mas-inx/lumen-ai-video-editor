// Facts about top-level windows: owner process, title, exact rectangles.
using System;
using System.Collections.Generic;
using System.Text;

namespace Lumen.CaptureHelper
{
    internal sealed class WindowInfo
    {
        internal IntPtr Hwnd;
        internal uint Pid;
        internal string Process = "";
        internal string Title = "";
        internal RECT Rect;   // visible frame, screen coordinates
        internal RECT Client; // client area, screen coordinates
        internal bool Minimized;
    }

    internal static class Windows
    {
        // Rectangles of a window in physical screen pixels. False when it does not exist.
        internal static bool Geometry(IntPtr hwnd, out RECT rect, out RECT client, out bool minimized)
        {
            rect = new RECT();
            client = new RECT();
            minimized = false;
            if (!Native.IsWindow(hwnd)) return false;

            minimized = Native.IsIconic(hwnd);
            rect = Frame(hwnd);
            client = ClientOnScreen(hwnd);
            return true;
        }

        // The frame a person sees. GetWindowRect includes the invisible resize border
        // Windows 10 and 11 put around a window; the DWM frame bounds do not.
        internal static RECT Frame(IntPtr hwnd)
        {
            RECT frame;
            if (Native.DwmGetWindowRect(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, 16) != 0
                || (frame.Right - frame.Left) <= 0 || (frame.Bottom - frame.Top) <= 0)
            {
                if (!Native.GetWindowRect(hwnd, out frame)) frame = new RECT();
            }
            return frame;
        }

        // The client area in screen coordinates (all zero when it cannot be read).
        internal static RECT ClientOnScreen(IntPtr hwnd)
        {
            RECT client = new RECT();
            RECT inner;
            POINT origin = new POINT();
            if (Native.GetClientRect(hwnd, out inner) && Native.ClientToScreen(hwnd, ref origin))
            {
                client.Left = origin.X;
                client.Top = origin.Y;
                client.Right = origin.X + (inner.Right - inner.Left);
                client.Bottom = origin.Y + (inner.Bottom - inner.Top);
            }
            return client;
        }

        internal static WindowInfo Describe(IntPtr hwnd)
        {
            WindowInfo info = new WindowInfo();
            info.Hwnd = hwnd;
            if (!Geometry(hwnd, out info.Rect, out info.Client, out info.Minimized)) return null;
            info.Title = Title(hwnd);
            info.Pid = OwnerProcess(hwnd, out info.Process);
            return info;
        }

        internal static string Title(IntPtr hwnd)
        {
            // For a window of another process this reads the stored caption and
            // sends no message, so a hung app cannot block it.
            StringBuilder sb = new StringBuilder(512);
            int n = Native.GetWindowTextW(hwnd, sb, sb.Capacity);
            return n > 0 ? sb.ToString() : "";
        }

        private static string ClassName(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            int n = Native.GetClassNameW(hwnd, sb, sb.Capacity);
            return n > 0 ? sb.ToString() : "";
        }

        // The process that owns a window. A Store (UWP) app's top-level window
        // belongs to ApplicationFrameHost.exe, which makes no sound and is not the
        // app; the app's own process owns a child CoreWindow, so that one is returned.
        internal static uint OwnerProcess(IntPtr hwnd, out string exeName)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            exeName = ProcessName(pid);
            if (string.Equals(exeName, "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            {
                uint hostPid = pid;
                uint appPid = 0;
                Native.EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused)
                {
                    uint childPid;
                    Native.GetWindowThreadProcessId(child, out childPid);
                    if (childPid != 0 && childPid != hostPid)
                    {
                        appPid = childPid;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                if (appPid != 0)
                {
                    pid = appPid;
                    exeName = ProcessName(pid);
                }
            }
            return pid;
        }

        internal static string ProcessName(uint pid)
        {
            if (pid == 0) return "";
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                if (!Native.QueryFullProcessImageNameW(process, 0, sb, ref size)) return "";
                string path = sb.ToString();
                int slash = path.LastIndexOf('\\');
                return slash >= 0 ? path.Substring(slash + 1) : path;
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }

        // The windows a person could pick to record, front to back.
        internal static List<WindowInfo> List()
        {
            List<WindowInfo> list = new List<WindowInfo>();
            Native.EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
            {
                if (!Native.IsWindowVisible(hwnd)) return true;
                long exStyle = Native.GetWindowLongPtrW(hwnd, Native.GWL_EXSTYLE).ToInt64();
                if ((exStyle & Native.WS_EX_TOOLWINDOW) != 0) return true;
                int cloaked;
                if (Native.DwmGetWindowInt(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                string title = Title(hwnd);
                if (title.Trim().Length == 0) return true;
                // The desktop itself is a titled, visible window ("Program Manager").
                string className = ClassName(hwnd);
                if (className == "Progman" || className == "WorkerW") return true;

                WindowInfo info = new WindowInfo();
                info.Hwnd = hwnd;
                if (!Geometry(hwnd, out info.Rect, out info.Client, out info.Minimized)) return true;
                if (!info.Minimized
                    && ((info.Rect.Right - info.Rect.Left) <= 0 || (info.Rect.Bottom - info.Rect.Top) <= 0)) return true;
                info.Title = title;
                info.Pid = OwnerProcess(hwnd, out info.Process);
                list.Add(info);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        internal static void AppendJson(StringBuilder sb, WindowInfo w)
        {
            sb.Append("{\"hwnd\":").Append(w.Hwnd.ToInt64());
            sb.Append(",\"pid\":").Append(w.Pid);
            sb.Append(",\"process\":");
            Out.AppendString(sb, w.Process);
            sb.Append(",\"title\":");
            Out.AppendString(sb, w.Title);
            sb.Append(",\"rect\":");
            Out.AppendRect(sb, w.Rect);
            sb.Append(",\"client\":");
            Out.AppendRect(sb, w.Client);
            sb.Append(",\"minimized\":").Append(w.Minimized ? "true" : "false").Append('}');
        }

        internal static int RunList()
        {
            List<WindowInfo> list = List();
            StringBuilder sb = new StringBuilder(4096);
            sb.Append('[');
            for (int i = 0; i < list.Count; i++)
            {
                if (i > 0) sb.Append(',');
                AppendJson(sb, list[i]);
            }
            sb.Append(']');
            Out.Line(Out.Stdout, sb);
            return Program.ExitOk;
        }

        internal static int RunOne(IntPtr hwnd)
        {
            WindowInfo info = Describe(hwnd);
            if (info == null)
            {
                throw new HelperException("no-process", Program.ExitNoProcess, "There is no window with handle " + hwnd.ToInt64() + ".");
            }
            StringBuilder sb = new StringBuilder(512);
            AppendJson(sb, info);
            Out.Line(Out.Stdout, sb);
            return Program.ExitOk;
        }
    }
}
