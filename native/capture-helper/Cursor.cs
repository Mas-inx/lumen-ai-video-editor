// The mouse cursor as data: position, buttons, shape, and (optionally) where one
// window is. Polled on a high-resolution timer; no hooks are installed.
using System;
using System.IO;
using System.Threading;

namespace Lumen.CaptureHelper
{
    internal static class CursorTracker
    {
        // Standard cursors, by resource id. A system cursor has the same handle in
        // every process, so comparing handles tells which one an app is showing.
        private static readonly int[] ShapeIds =
        {
            32512, // IDC_ARROW
            32513, // IDC_IBEAM
            32649, // IDC_HAND
            32514, // IDC_WAIT
            32650, // IDC_APPSTARTING (arrow with a busy ring)
            32515, // IDC_CROSS
            32642, // IDC_SIZENWSE
            32643, // IDC_SIZENESW
            32644, // IDC_SIZEWE
            32645, // IDC_SIZENS
            32646, // IDC_SIZEALL
            32648  // IDC_NO
        };

        private static readonly string[] ShapeNames =
        {
            "arrow", "ibeam", "hand", "wait", "wait", "cross", "size", "size", "size", "size", "size", "no"
        };

        private static readonly string[] ButtonNames = { "left", "right", "middle" };

        internal static int Run(int hz, IntPtr hwnd, bool trackWindow, bool stats)
        {
            Stream stdout = Out.Stdout;
            LineBuf line = new LineBuf();

            IntPtr[] shapeHandles = new IntPtr[ShapeIds.Length];
            for (int i = 0; i < ShapeIds.Length; i++)
            {
                shapeHandles[i] = Native.LoadCursorW(IntPtr.Zero, new IntPtr(ShapeIds[i]));
            }

            // A high-resolution waitable timer (Windows 10 1803 and later) is accurate to
            // well under a millisecond without raising the system timer rate. Older
            // systems get a normal timer with the 1 ms period.
            bool raisedPeriod = false;
            IntPtr timer = Native.CreateWaitableTimerExW(IntPtr.Zero, null, Native.CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, Native.TIMER_ALL_ACCESS);
            if (timer == IntPtr.Zero)
            {
                Native.timeBeginPeriod(1);
                raisedPeriod = true;
                timer = Native.CreateWaitableTimerExW(IntPtr.Zero, null, 0, Native.TIMER_ALL_ACCESS);
            }
            IntPtr[] waits = new IntPtr[] { StopSignal.Handle, timer };

            try
            {
                Thread.CurrentThread.Priority = ThreadPriority.AboveNormal;
            }
            catch (Exception)
            {
            }

            long period = Clock.TicksPerSecond / hz;
            int slowEvery = Math.Max(1, hz / 10); // window and settings checks: about 10 a second

            int[] buttonKeys = new int[3];
            bool[] buttonDown = new bool[3];
            ReadButtonMapping(buttonKeys);
            for (int b = 0; b < 3; b++)
            {
                // Sets the starting state and clears the "pressed since last asked" bit.
                buttonDown[b] = (Native.GetAsyncKeyState(buttonKeys[b]) & 0x8000) != 0;
            }

            bool havePosition = false;
            int lastX = 0, lastY = 0;
            bool haveShape = false;
            IntPtr lastCursor = IntPtr.Zero;
            bool lastVisible = false;
            string lastShape = "arrow";

            bool haveWindow = false, windowGone = false;
            RECT lastRect = new RECT(), lastClient = new RECT(), lastOuter = new RECT();
            bool lastMinimized = false, lastForeground = false;

            long samples = 0;
            long maxInterval = 0;
            long firstSample = 0, lastSample = 0;

            try
            {
                // First line: when we started, at what rate, and the virtual screen.
                RECT screen = new RECT();
                screen.Left = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
                screen.Top = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
                screen.Right = screen.Left + Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
                screen.Bottom = screen.Top + Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
                line.S("{\"e\":\"start\",\"t\":").T(Clock.EpochMicros()).S(",\"hz\":").I(hz).S(",\"screen\":").R(screen).S("}").WriteLine(stdout);

                long next = Clock.Ticks();
                while (true)
                {
                    // ---- one sample ----
                    CURSORINFO info = new CURSORINFO();
                    info.cbSize = 24;
                    bool gotInfo = Native.GetCursorInfo(ref info);
                    long t = Clock.EpochMicros();
                    long nowTicks = Clock.Ticks();

                    if (samples == 0) firstSample = nowTicks;
                    else if (nowTicks - lastSample > maxInterval) maxInterval = nowTicks - lastSample;
                    lastSample = nowTicks;

                    bool gotPosition = gotInfo;
                    int x = info.ptScreenPos.X, y = info.ptScreenPos.Y;
                    if (!gotInfo)
                    {
                        // GetCursorInfo fails on the secure desktop (UAC prompt, lock screen).
                        POINT p;
                        if (Native.GetCursorPos(out p))
                        {
                            x = p.X;
                            y = p.Y;
                            gotPosition = true;
                        }
                    }

                    if (gotInfo)
                    {
                        bool visible = (info.flags & Native.CURSOR_SHOWING) != 0;
                        if (!haveShape || info.hCursor != lastCursor || visible != lastVisible)
                        {
                            string shape = lastShape;
                            if (info.hCursor != IntPtr.Zero)
                            {
                                shape = "other";
                                for (int i = 0; i < shapeHandles.Length; i++)
                                {
                                    if (shapeHandles[i] == info.hCursor)
                                    {
                                        shape = ShapeNames[i];
                                        break;
                                    }
                                }
                            }
                            // Two different handles can be the same shape (the five resize
                            // cursors); only say so when something a reader sees changed.
                            if (!haveShape || visible != lastVisible || shape != lastShape)
                            {
                                line.S("{\"e\":\"shape\",\"t\":").T(t).S(",\"shape\":\"").S(shape).S("\",\"visible\":").B(visible).S("}").WriteLine(stdout);
                            }
                            haveShape = true;
                            lastCursor = info.hCursor;
                            lastVisible = visible;
                            lastShape = shape;
                        }
                    }

                    if (samples % slowEvery == 0)
                    {
                        if (trackWindow)
                        {
                            RECT outer;
                            if (Native.IsWindow(hwnd) && Native.GetWindowRect(hwnd, out outer))
                            {
                                bool minimized = Native.IsIconic(hwnd);
                                RECT client = Windows.ClientOnScreen(hwnd);
                                // The visible frame comes from the window manager, which costs
                                // far more than the calls above: ask only when something moved.
                                RECT rect = lastRect;
                                if (!haveWindow || windowGone || minimized != lastMinimized
                                    || !Same(outer, lastOuter) || !Same(client, lastClient))
                                {
                                    rect = Windows.Frame(hwnd);
                                }
                                lastOuter = outer;
                                IntPtr front = Native.GetForegroundWindow();
                                bool foreground = front != IntPtr.Zero
                                    && (front == hwnd || Native.GetAncestor(front, Native.GA_ROOTOWNER) == hwnd);
                                if (!haveWindow || windowGone || minimized != lastMinimized || foreground != lastForeground
                                    || !Same(rect, lastRect) || !Same(client, lastClient))
                                {
                                    line.S("{\"e\":\"window\",\"t\":").T(t).S(",\"rect\":").R(rect).S(",\"client\":").R(client);
                                    line.S(",\"minimized\":").B(minimized).S(",\"foreground\":").B(foreground).S("}").WriteLine(stdout);
                                }
                                haveWindow = true;
                                windowGone = false;
                                lastRect = rect;
                                lastClient = client;
                                lastMinimized = minimized;
                                lastForeground = foreground;
                            }
                            else if (!windowGone)
                            {
                                line.S("{\"e\":\"window\",\"t\":").T(t).S(",\"gone\":true}").WriteLine(stdout);
                                windowGone = true;
                            }
                        }
                        ReadButtonMapping(buttonKeys);
                    }

                    if (gotPosition && (!havePosition || x != lastX || y != lastY))
                    {
                        line.S("{\"e\":\"move\",\"t\":").T(t).S(",\"x\":").I(x).S(",\"y\":").I(y).S("}").WriteLine(stdout);
                        havePosition = true;
                        lastX = x;
                        lastY = y;
                    }

                    for (int b = 0; b < 3; b++)
                    {
                        short state = Native.GetAsyncKeyState(buttonKeys[b]);
                        bool down = (state & 0x8000) != 0;
                        if (down != buttonDown[b])
                        {
                            Button(line, stdout, down ? "down" : "up", t, havePosition, lastX, lastY, b);
                            buttonDown[b] = down;
                        }
                        else if (!down && (state & 1) != 0)
                        {
                            // Pressed and released between two samples.
                            Button(line, stdout, "down", t, havePosition, lastX, lastY, b);
                            Button(line, stdout, "up", t, havePosition, lastX, lastY, b);
                        }
                    }

                    samples++;

                    // ---- sleep until the next sample is due ----
                    next += period;
                    long now = Clock.Ticks();
                    if (next <= now)
                    {
                        // Fell behind (the reader stalled, the PC slept): do not burst to catch up.
                        if (now - next > period * 4) next = now;
                        if (StopSignal.IsSet()) break;
                        continue;
                    }
                    uint woke;
                    if (timer != IntPtr.Zero)
                    {
                        long due = -(next - now);
                        Native.SetWaitableTimer(timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false);
                        woke = Native.WaitForMultipleObjects(2, waits, false, Native.INFINITE);
                    }
                    else
                    {
                        woke = Native.WaitForSingleObject(StopSignal.Handle, (uint)Math.Max(1, (next - now) / 10000));
                    }
                    if (woke == Native.WAIT_OBJECT_0) break; // stop
                    if (woke != Native.WAIT_OBJECT_0 + 1 && woke != Native.WAIT_TIMEOUT)
                    {
                        // The wait itself failed; do not spin.
                        Thread.Sleep(1);
                    }
                }
            }
            catch (IOException)
            {
                // The reader went away.
            }
            finally
            {
                if (raisedPeriod) Native.timeEndPeriod(1);
            }

            if (stats && samples > 1)
            {
                long span = lastSample - firstSample;
                Out.Event("{\"event\":\"stats\",\"samples\":" + samples
                    + ",\"ms\":" + Milli(span / 10)
                    + ",\"avgIntervalMs\":" + Milli(span / (samples - 1) / 10)
                    + ",\"maxIntervalMs\":" + Milli(maxInterval / 10) + "}");
            }
            return Program.ExitOk;
        }

        private static void Button(LineBuf line, Stream stdout, string what, long t, bool havePosition, int x, int y, int button)
        {
            line.S("{\"e\":\"").S(what).S("\",\"t\":").T(t);
            line.S(",\"x\":").I(havePosition ? x : 0).S(",\"y\":").I(havePosition ? y : 0);
            line.S(",\"button\":\"").S(ButtonNames[button]).S("\"}").WriteLine(stdout);
        }

        // GetAsyncKeyState reports the physical buttons. With "switch primary and
        // secondary buttons" on, the physical right button is the one that left-clicks.
        private static void ReadButtonMapping(int[] keys)
        {
            bool swapped = Native.GetSystemMetrics(Native.SM_SWAPBUTTON) != 0;
            keys[0] = swapped ? Native.VK_RBUTTON : Native.VK_LBUTTON;
            keys[1] = swapped ? Native.VK_LBUTTON : Native.VK_RBUTTON;
            keys[2] = Native.VK_MBUTTON;
        }

        private static bool Same(RECT a, RECT b)
        {
            return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
        }

        // Microseconds as milliseconds with three decimals.
        private static string Milli(long micros)
        {
            long whole = micros / 1000;
            long frac = Math.Abs(micros % 1000);
            return whole + "." + (frac / 100) + (frac / 10 % 10) + (frac % 10);
        }
    }
}
