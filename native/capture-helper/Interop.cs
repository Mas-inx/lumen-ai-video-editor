// Win32 and COM declarations. Only what the helper calls; x64 layouts.
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Lumen.CaptureHelper
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct OSVERSIONINFOEXW
    {
        public int dwOSVersionInfoSize;
        public int dwMajorVersion;
        public int dwMinorVersion;
        public int dwBuildNumber;
        public int dwPlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;
        public ushort wServicePackMajor;
        public ushort wServicePackMinor;
        public ushort wSuiteMask;
        public byte wProductType;
        public byte wReserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_POWER_THROTTLING_STATE
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    internal delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    internal static class Native
    {
        // ---- kernel32 ----
        internal const uint SEM_FAILCRITICALERRORS = 0x0001;
        internal const uint SEM_NOGPFAULTERRORBOX = 0x0002;
        internal const uint SEM_NOOPENFILEERRORBOX = 0x8000;

        internal const uint SYNCHRONIZE = 0x00100000;
        internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        internal const uint PROCESS_SET_INFORMATION = 0x0200;

        // PROCESS_INFORMATION_CLASS.ProcessPowerThrottling
        internal const int ProcessPowerThrottling = 4;
        internal const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
        internal const uint PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;

        internal const uint WAIT_OBJECT_0 = 0;
        internal const uint WAIT_TIMEOUT = 258;
        internal const uint INFINITE = 0xFFFFFFFF;

        internal const int ERROR_ACCESS_DENIED = 5;
        internal const int ERROR_INVALID_PARAMETER = 87;

        internal const uint CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x00000002;
        internal const uint TIMER_ALL_ACCESS = 0x001F0003;

        [DllImport("kernel32.dll")]
        internal static extern uint SetErrorMode(uint mode);

        [DllImport("kernel32.dll")]
        internal static extern void GetSystemTimePreciseAsFileTime(out long fileTime);

        [DllImport("kernel32.dll")]
        internal static extern bool QueryPerformanceCounter(out long value);

        [DllImport("kernel32.dll")]
        internal static extern bool QueryPerformanceFrequency(out long value);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll")]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll")]
        internal static extern bool SetEvent(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr CreateWaitableTimerExW(IntPtr attributes, string name, uint flags, uint access);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetWaitableTimer(IntPtr timer, ref long dueTime, int period, IntPtr routine, IntPtr arg, bool resume);

        // ---- ntdll ----
        [DllImport("ntdll.dll")]
        internal static extern int RtlGetVersion(ref OSVERSIONINFOEXW info);

        // ---- winmm / avrt ----
        [DllImport("winmm.dll")]
        internal static extern uint timeBeginPeriod(uint milliseconds);

        [DllImport("winmm.dll")]
        internal static extern uint timeEndPeriod(uint milliseconds);

        [DllImport("avrt.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr AvSetMmThreadCharacteristicsW(string taskName, ref uint taskIndex);

        // ---- user32 ----
        internal const int GWL_EXSTYLE = -20;
        internal const long WS_EX_TOOLWINDOW = 0x00000080L;
        internal const uint GA_ROOTOWNER = 3;

        internal const int SM_SWAPBUTTON = 23;
        internal const int SM_XVIRTUALSCREEN = 76;
        internal const int SM_YVIRTUALSCREEN = 77;
        internal const int SM_CXVIRTUALSCREEN = 78;
        internal const int SM_CYVIRTUALSCREEN = 79;

        internal const int VK_LBUTTON = 0x01;
        internal const int VK_RBUTTON = 0x02;
        internal const int VK_MBUTTON = 0x04;

        internal const int CURSOR_SHOWING = 0x00000001;

        [DllImport("user32.dll")]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll")]
        internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int maxCount);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);

        [DllImport("user32.dll")]
        internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        internal static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        internal static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

        internal const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        internal static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool BringWindowToTop(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool ShowWindowAsync(IntPtr hwnd, int command);

        [DllImport("user32.dll")]
        internal static extern bool IsHungAppWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool AttachThreadInput(uint thread, uint attachTo, bool attach);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern bool PeekMessageW(out MSG message, IntPtr hwnd, uint filterMin, uint filterMax, uint remove);

        [DllImport("user32.dll")]
        internal static extern bool GetCursorInfo(ref CURSORINFO info);

        [DllImport("user32.dll")]
        internal static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll", ExactSpelling = true)]
        internal static extern IntPtr LoadCursorW(IntPtr instance, IntPtr name);

        [DllImport("user32.dll")]
        internal static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("user32.dll")]
        internal static extern int GetSystemMetrics(int index);

        // ---- dwmapi ----
        internal const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        internal const int DWMWA_CLOAKED = 14;

        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
        internal static extern int DwmGetWindowRect(IntPtr hwnd, int attribute, out RECT value, int size);

        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
        internal static extern int DwmGetWindowInt(IntPtr hwnd, int attribute, out int value, int size);

        // ---- mmdevapi ----
        [DllImport("Mmdevapi.dll", ExactSpelling = true)]
        internal static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [In] ref Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);
    }

    // ---- COM: Core Audio ----

    [ComImport]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // Marker interface: tells COM the completion handler may be called from any
    // apartment without marshalling. ActivateAudioInterfaceAsync refuses a
    // handler that does not answer for it.
    [ComImport]
    [Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAgileObject
    {
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint bufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long latency);

        [PreserveSig]
        int GetCurrentPadding(out uint paddingFrames);

        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr format);

        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService([In] ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);

        [PreserveSig]
        int ReleaseBuffer(uint frames);

        [PreserveSig]
        int GetNextPacketSize(out uint frames);
    }
}
