// Brings a window to the front: `focus --hwnd <n>`. A best effort - Windows decides
// who may take the foreground - and it never fakes key presses or mouse input to
// get its way.
using System;
using System.Text;
using System.Threading;

namespace Lumen.CaptureHelper
{
    internal static class Focus
    {
        private static int answered; // the answer is printed once, by Run or by the watchdog

        internal static int Run(IntPtr hwnd)
        {
            if (!Native.IsWindow(hwnd))
            {
                throw new HelperException("no-process", Program.ExitNoProcess, "There is no window with handle " + hwnd.ToInt64() + ".");
            }

            // Nothing below should block, but it talks to other apps' windows. If it
            // ever does, answer "not focused" rather than hang the caller.
            Thread watchdog = new Thread(delegate()
            {
                Thread.Sleep(3000);
                Answer(hwnd, false);
                Environment.Exit(Program.ExitOk);
            });
            watchdog.IsBackground = true;
            watchdog.Start();

            if (Native.IsIconic(hwnd))
            {
                // The Async form posts the request, so a hung app cannot hang us.
                Native.ShowWindowAsync(hwnd, Native.SW_RESTORE);
                for (int i = 0; i < 50 && Native.IsIconic(hwnd); i++) Thread.Sleep(10);
            }

            // Windows lets a process take the foreground when it was started by the
            // foreground process, which is how Lumen runs this. When that is not
            // enough, joining the input queue of the thread that owns the foreground
            // window makes the request count as coming from it.
            bool focused = IsInFront(hwnd) || Take(hwnd, false) || Take(hwnd, true);

            Answer(hwnd, focused);
            return Program.ExitOk;
        }

        private static bool Take(IntPtr hwnd, bool joinForegroundThread)
        {
            uint me = 0, other = 0;
            bool attached = false;
            if (joinForegroundThread)
            {
                IntPtr front = Native.GetForegroundWindow();
                if (front == IntPtr.Zero || Native.IsHungAppWindow(front)) return false;
                uint unused;
                other = Native.GetWindowThreadProcessId(front, out unused);
                Thread.BeginThreadAffinity();
                me = Native.GetCurrentThreadId();
                if (other == 0 || other == me)
                {
                    Thread.EndThreadAffinity();
                    return false;
                }
                // AttachThreadInput needs both threads to have a message queue; asking
                // for a message gives this one its queue.
                MSG message;
                Native.PeekMessageW(out message, IntPtr.Zero, 0, 0, 0);
                attached = Native.AttachThreadInput(me, other, true);
                if (!attached)
                {
                    Thread.EndThreadAffinity();
                    return false; // refused, for instance by an app running as administrator
                }
            }
            bool accepted;
            try
            {
                if (attached) Native.BringWindowToTop(hwnd);
                accepted = Native.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached)
                {
                    Native.AttachThreadInput(me, other, false);
                    Thread.EndThreadAffinity();
                }
            }

            // When Windows accepts, the change is not always visible the instant the
            // call returns; when it refuses, there is nothing to wait for.
            for (int i = 0; i < (accepted ? 25 : 3); i++)
            {
                if (IsInFront(hwnd)) return true;
                Thread.Sleep(10);
            }
            return IsInFront(hwnd);
        }

        // In front: it is the foreground window, or a window it owns is (a dialog of the app).
        private static bool IsInFront(IntPtr hwnd)
        {
            IntPtr front = Native.GetForegroundWindow();
            return front != IntPtr.Zero && (front == hwnd || Native.GetAncestor(front, Native.GA_ROOTOWNER) == hwnd);
        }

        private static void Answer(IntPtr hwnd, bool focused)
        {
            if (Interlocked.Exchange(ref answered, 1) != 0) return;
            StringBuilder sb = new StringBuilder(96);
            sb.Append("{\"focused\":").Append(focused ? "true" : "false");
            sb.Append(",\"foreground\":").Append(Native.GetForegroundWindow().ToInt64());
            sb.Append(",\"hwnd\":").Append(hwnd.ToInt64()).Append('}');
            Out.Line(Out.Stdout, sb);
        }
    }
}
