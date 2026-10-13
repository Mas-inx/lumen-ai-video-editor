// Clocks, stdout/stderr as raw byte streams, JSON text, and the stdin watcher.
using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Lumen.CaptureHelper
{
    internal static class Clock
    {
        internal const long TicksPerSecond = 10000000; // one tick = 100 ns

        private static readonly long frequency = ReadFrequency();

        private static long ReadFrequency()
        {
            long f;
            if (!Native.QueryPerformanceFrequency(out f) || f <= 0) return TicksPerSecond;
            return f;
        }

        // The performance counter in 100 ns ticks: the unit WASAPI stamps packets with.
        internal static long Ticks()
        {
            long c;
            Native.QueryPerformanceCounter(out c);
            if (frequency == TicksPerSecond) return c;
            return (c / frequency) * TicksPerSecond + (c % frequency) * TicksPerSecond / frequency;
        }

        // Wall clock, microseconds since 1970-01-01 UTC.
        internal static long EpochMicros()
        {
            long fileTime;
            Native.GetSystemTimePreciseAsFileTime(out fileTime);
            return (fileTime - 116444736000000000L) / 10;
        }
    }

    internal static class Out
    {
        // Console.OpenStandardOutput gives an unbuffered stream: one Write is one WriteFile.
        internal static readonly Stream Stdout = Console.OpenStandardOutput();
        internal static readonly Stream Stderr = Console.OpenStandardError();

        // Writes the builder's text plus a newline. The text is ASCII (see AppendString),
        // which is also valid UTF-8 without a BOM.
        internal static void Line(Stream stream, StringBuilder sb)
        {
            int n = sb.Length;
            byte[] bytes = new byte[n + 1];
            for (int i = 0; i < n; i++) bytes[i] = (byte)sb[i];
            bytes[n] = (byte)'\n';
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        // A JSON string. Everything outside printable ASCII is written as \uXXXX, so the
        // output never depends on a code page and a lone surrogate cannot break it.
        internal static void AppendString(StringBuilder sb, string value)
        {
            sb.Append('"');
            if (value != null)
            {
                for (int i = 0; i < value.Length; i++)
                {
                    char c = value[i];
                    if (c == '"') sb.Append("\\\"");
                    else if (c == '\\') sb.Append("\\\\");
                    else if (c >= 0x20 && c < 0x7F) sb.Append(c);
                    else
                    {
                        sb.Append("\\u");
                        sb.Append(Hex[(c >> 12) & 15]).Append(Hex[(c >> 8) & 15]).Append(Hex[(c >> 4) & 15]).Append(Hex[c & 15]);
                    }
                }
            }
            sb.Append('"');
        }

        private const string Hex = "0123456789abcdef";

        // Epoch milliseconds with three decimals, e.g. 1760356800123.456
        internal static void AppendTime(StringBuilder sb, long epochMicros)
        {
            long ms = epochMicros / 1000;
            int frac = (int)(epochMicros % 1000);
            sb.Append(ms).Append('.');
            sb.Append((char)('0' + frac / 100)).Append((char)('0' + frac / 10 % 10)).Append((char)('0' + frac % 10));
        }

        internal static void AppendRect(StringBuilder sb, RECT r)
        {
            sb.Append("{\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top);
            sb.Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top).Append('}');
        }

        internal static void Error(string code, string message)
        {
            try
            {
                StringBuilder sb = new StringBuilder(160);
                sb.Append("{\"error\":");
                AppendString(sb, message);
                sb.Append(",\"code\":");
                AppendString(sb, code);
                sb.Append('}');
                Line(Stderr, sb);
            }
            catch (Exception)
            {
                // Nobody is listening; the exit code still tells the story.
            }
        }

        internal static void Event(string json)
        {
            try
            {
                Line(Stderr, new StringBuilder(json));
            }
            catch (Exception)
            {
            }
        }
    }

    // One reusable line of ASCII, for the modes that print many lines a second.
    // Nothing here allocates.
    internal sealed class LineBuf
    {
        private readonly byte[] bytes = new byte[1024];
        private int length;

        internal LineBuf S(string text)
        {
            for (int i = 0; i < text.Length; i++) bytes[length++] = (byte)text[i];
            return this;
        }

        internal LineBuf I(long value)
        {
            if (value < 0)
            {
                bytes[length++] = (byte)'-';
                value = -value;
            }
            int start = length;
            do
            {
                bytes[length++] = (byte)('0' + (int)(value % 10));
                value /= 10;
            }
            while (value != 0);
            for (int a = start, b = length - 1; a < b; a++, b--)
            {
                byte swap = bytes[a];
                bytes[a] = bytes[b];
                bytes[b] = swap;
            }
            return this;
        }

        internal LineBuf T(long epochMicros)
        {
            I(epochMicros / 1000);
            int frac = (int)(epochMicros % 1000);
            bytes[length++] = (byte)'.';
            bytes[length++] = (byte)('0' + frac / 100);
            bytes[length++] = (byte)('0' + frac / 10 % 10);
            bytes[length++] = (byte)('0' + frac % 10);
            return this;
        }

        internal LineBuf B(bool value)
        {
            return S(value ? "true" : "false");
        }

        internal LineBuf R(RECT r)
        {
            return S("{\"x\":").I(r.Left).S(",\"y\":").I(r.Top).S(",\"width\":").I(r.Right - r.Left).S(",\"height\":").I(r.Bottom - r.Top).S("}");
        }

        internal void WriteLine(Stream stream)
        {
            bytes[length++] = (byte)'\n';
            int n = length;
            length = 0;
            stream.Write(bytes, 0, n);
        }
    }

    // The parent ends a long-running mode by closing our stdin or by writing "stop".
    // Either one sets Handle, a manual-reset event the capture loops wait on.
    internal static class StopSignal
    {
        internal static IntPtr Handle;

        internal static void Start()
        {
            Handle = Native.CreateEventW(IntPtr.Zero, true, false, null);
            Thread thread = new Thread(ReadLoop);
            thread.IsBackground = true;
            thread.Name = "stdin";
            thread.Start();
        }

        internal static bool IsSet()
        {
            return Native.WaitForSingleObject(Handle, 0) == Native.WAIT_OBJECT_0;
        }

        private static void ReadLoop()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] chunk = new byte[256];
                byte[] line = new byte[8];
                int lineLength = 0;
                bool stop = false;
                while (!stop)
                {
                    int n = input.Read(chunk, 0, chunk.Length);
                    if (n <= 0) break; // end of file: the parent is gone or closed the pipe
                    for (int i = 0; i < n && !stop; i++)
                    {
                        byte b = chunk[i];
                        if (b == (byte)'\n')
                        {
                            stop = IsStop(line, lineLength);
                            lineLength = 0;
                        }
                        else if (b == (byte)'\r' || b == (byte)' ' || b == (byte)'\t')
                        {
                            // ignored, so "stop\r\n" and " stop " both count
                        }
                        else if (lineLength < line.Length)
                        {
                            line[lineLength++] = b;
                        }
                        else
                        {
                            lineLength = line.Length + 1; // too long to be "stop"
                        }
                    }
                }
            }
            catch (Exception)
            {
                // A broken stdin is the same as a closed one.
            }
            Native.SetEvent(Handle);

            // The loops leave within a few milliseconds of the event. Should one be
            // stuck inside a Windows call (the audio ones can block for half a
            // second), do not wait for it: the parent asked us to go.
            Thread.Sleep(ExitGraceMs);
            Environment.Exit(Program.ExitOk);
        }

        private const int ExitGraceMs = 120;

        private static bool IsStop(byte[] line, int length)
        {
            return length == 4
                && (line[0] | 0x20) == 's' && (line[1] | 0x20) == 't'
                && (line[2] | 0x20) == 'o' && (line[3] | 0x20) == 'p';
        }
    }
}
