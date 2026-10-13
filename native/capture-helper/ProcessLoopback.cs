// The sound of one application (and its child processes), or of everything except
// it, through WASAPI process loopback. Written to stdout as a stream that is
// continuous in time: silence is filled in wherever Windows delivers nothing.
//
// Two threads share the work, because Windows keeps only about 30 ms of this audio
// for a reader that falls behind (measured on build 26200; later packets arrive
// as silence), and because its own calls can block for half a second when the
// target opens a stream:
//   - the capture thread (Main) takes packets from Windows the moment they are
//     ready, decides where each belongs on the timeline, and queues it;
//   - the writer thread sends the queue to stdout, and fills the timeline with
//     silence whenever nothing has been queued for a while.
// Neither a slow reader nor a blocked Windows call can therefore stop the other.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Lumen.CaptureHelper
{
    // Receives the result of ActivateAudioInterfaceAsync on a worker thread.
    // IAgileObject marks it free-threaded, which that function insists on.
    internal sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        internal readonly ManualResetEvent Done = new ManualResetEvent(false);
        internal int Result = unchecked((int)0x80004005); // E_FAIL until told otherwise
        internal object Client;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            try
            {
                int activateResult;
                object client;
                int hr = activateOperation.GetActivateResult(out activateResult, out client);
                Result = hr < 0 ? hr : activateResult;
                Client = client;
            }
            catch (Exception e)
            {
                Result = Marshal.GetHRForException(e);
            }
            Done.Set();
            return 0;
        }
    }

    internal static unsafe class ProcessLoopback
    {
        private const int Rate = 48000;
        private const int Channels = 2;
        private const int FrameBytes = Channels * 4; // 32-bit float

        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        private const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        private const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;

        private const uint AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY = 1;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 2;
        private const uint AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR = 4;

        private const int AUDCLNT_S_BUFFER_EMPTY = 0x08890001;
        private const int AUDCLNT_E_DEVICE_INVALIDATED = unchecked((int)0x88890004);

        private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        private static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

        // ---- tuning (100 ns ticks unless said otherwise) ----

        // Asked of Windows as the stream's buffer. The process-loopback device
        // ignores it (it reports 480 frames whatever is asked), so nothing relies on it.
        private const long BufferTicks = 2 * Clock.TicksPerSecond;

        // The capture loop looks for packets at least this often even without the
        // stream's event; the writer writes silence this often when there are none.
        private const uint WakeMs = 10;

        // While no packets arrive, silence is written up to "now minus this". A
        // packet reaches us about 10 ms after the time it is stamped with; the margin
        // keeps the silence from running past the place a late packet belongs.
        private const long FillMarginTicks = 30 * 10000;

        // Stamps of packets in one unbroken run of sound follow each other exactly.
        // A step larger than this is a break in the stream.
        private const long ContiguousTicks = 3 * 10000;

        // How far (in frames) the stream may sit from where the clock says it should
        // be before sound is padded or cut to correct it. Silent packets are corrected
        // exactly and quiet ones beyond QuietSnapFrames, where nobody can hear it.
        private const int HardSnapFrames = Rate * 60 / 1000;
        private const int QuietSnapFrames = Rate * 5 / 1000;
        private const float QuietPeak = 0.002f; // about -54 dBFS

        // Audio waiting for a reader that has stopped reading. Past this (20 s), new
        // packets are dropped and the time they covered comes out as silence.
        private const int MaxQueueBytes = 20 * Rate * FrameBytes;

        // ---- state ----

        private static Stream stdout;
        private static IAudioClient client;
        private static IAudioCaptureClient capture;
        private static IntPtr audioEvent;   // Windows: a packet is ready
        private static IntPtr dataReady;    // capture thread: something is queued

        private static readonly object gate = new object(); // guards everything below, up to the counters
        private static long origin;          // tick of sample 0
        private static long written;         // frames placed on the timeline so far (queued, or sent)
        private static long lastEnd;         // tick where the previous packet ended
        private static bool havePacket;
        private static byte[] queue = new byte[32 * 1024];
        private static int queued;

        private static byte[] sending = new byte[32 * 1024];                    // writer thread only
        private static byte[] packet = new byte[Rate / 10 * FrameBytes];        // capture thread only
        private static readonly byte[] zeros = new byte[Rate / 10 * FrameBytes];

        private static volatile bool quitting;
        private static volatile bool readerGone;

        // counters for --stats
        private static long statPackets, statPacketFrames, statSilentPackets, statDiscontinuities, statBadStamps;
        private static long statZeroFrames, statDroppedFrames, statGaps, statReopens;
        private static long statLagMin = long.MaxValue, statLagMax = long.MinValue, statLagSum;
        private static long statRecentLagMin = long.MaxValue;
        private static long statStepMax;     // largest |stamp - end of previous packet| inside a run
        private static long statErrorMin = long.MaxValue, statErrorMax = long.MinValue;
        private static long statWriteGapMax, statLastWrite, statCallMax, statQueueMax;
        private static uint statBufferFrames;

        internal static int Run(uint pid, bool exclude, bool stats)
        {
            int build = Program.OsBuild();
            if (build < Program.ProcessLoopbackBuild)
            {
                throw new HelperException("unsupported", Program.ExitUnsupported,
                    "Recording the sound of a single app needs Windows 11, or Windows 10 build "
                    + Program.ProcessLoopbackBuild + " or later. This PC runs build " + build + ".");
            }

            // Hold the target open so we notice when it exits.
            bool canWait = true;
            IntPtr process = Native.OpenProcess(Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_ACCESS_DENIED || !Exists(pid))
                {
                    throw new HelperException("no-process", Program.ExitNoProcess, "No process with id " + pid + " is running.");
                }
                canWait = false; // a protected process: poll for its exit instead
            }
            else if (Native.WaitForSingleObject(process, 0) == Native.WAIT_OBJECT_0)
            {
                throw new HelperException("no-process", Program.ExitNoProcess, "The process with id " + pid + " has already exited.");
            }

            stdout = Out.Stdout;
            audioEvent = Native.CreateEventW(IntPtr.Zero, false, false, null);
            dataReady = Native.CreateEventW(IntPtr.Zero, false, false, null);
            if (audioEvent == IntPtr.Zero || dataReady == IntPtr.Zero || StopSignal.Handle == IntPtr.Zero)
            {
                throw new HelperException("failed", Program.ExitFailed, "Windows could not create an event to wait on.");
            }

            Open(pid, exclude);

            // Sample 0 is "now". Read both clocks together: the performance counter
            // places every later sample, the wall clock is what we tell the parent.
            origin = Clock.Ticks();
            long startedMicros = Clock.EpochMicros();

            StringBuilder header = new StringBuilder(128);
            header.Append("{\"sampleRate\":").Append(Rate).Append(",\"channels\":").Append(Channels);
            header.Append(",\"format\":\"f32le\",\"pid\":").Append(pid).Append(",\"t\":");
            Out.AppendTime(header, startedMicros);
            header.Append('}');
            Out.Line(stdout, header);

            Thread writer = new Thread(WriterLoop);
            writer.IsBackground = true;
            writer.Name = "writer";
            writer.Start();
            Prioritise();

            IntPtr[] waits = canWait
                ? new IntPtr[] { StopSignal.Handle, audioEvent, process }
                : new IntPtr[] { StopSignal.Handle, audioEvent };
            bool processExited = false;
            long nextStats = origin + Clock.TicksPerSecond;
            long nextExistsCheck = origin + Clock.TicksPerSecond;
            int failures = 0;

            try
            {
                while (true)
                {
                    uint woke = Native.WaitForMultipleObjects((uint)waits.Length, waits, false, WakeMs);
                    if (woke == Native.WAIT_OBJECT_0 || readerGone) break; // told to stop, or nobody is reading
                    if (woke == Native.WAIT_OBJECT_0 + 2) processExited = true;
                    else if (woke != Native.WAIT_OBJECT_0 + 1 && woke != Native.WAIT_TIMEOUT) Thread.Sleep(1); // the wait failed; do not spin

                    int hr = capture != null ? Drain() : AUDCLNT_E_DEVICE_INVALIDATED;
                    long now = Clock.Ticks();

                    if (hr < 0 && !processExited)
                    {
                        // The stream broke (for instance the audio service restarted). The
                        // timeline is our own clock, so a new stream carries straight on;
                        // until one opens, the writer fills the time with silence.
                        Close();
                        failures++;
                        try
                        {
                            Open(pid, exclude);
                            failures = 0;
                            statReopens++;
                            lock (gate)
                            {
                                havePacket = false;
                            }
                            Out.Event("{\"event\":\"reopened\"}");
                        }
                        catch (HelperException e)
                        {
                            if (failures >= 5)
                            {
                                throw new HelperException("failed", Program.ExitFailed, "The audio stream stopped and could not be started again. " + e.Message);
                            }
                            if (Native.WaitForSingleObject(StopSignal.Handle, 200) == Native.WAIT_OBJECT_0) break;
                        }
                    }

                    if (processExited) break;
                    if (!canWait && now >= nextExistsCheck)
                    {
                        nextExistsCheck = now + Clock.TicksPerSecond;
                        if (!Exists(pid))
                        {
                            processExited = true;
                            break;
                        }
                    }
                    if (stats && now >= nextStats)
                    {
                        nextStats += Clock.TicksPerSecond;
                        PrintStats(now);
                    }
                }
            }
            finally
            {
                // Let the writer send what is queued, briefly, then go.
                quitting = true;
                Native.SetEvent(dataReady);
                writer.Join(150);
                Close();
            }

            if (stats) PrintStats(Clock.Ticks());
            if (processExited) Out.Event("{\"event\":\"ended\",\"reason\":\"process-exited\"}");
            return Program.ExitOk;
        }

        private static bool Exists(uint pid)
        {
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h != IntPtr.Zero)
            {
                Native.CloseHandle(h);
                return true;
            }
            // "Access denied" still means there is such a process.
            return Marshal.GetLastWin32Error() == Native.ERROR_ACCESS_DENIED;
        }

        // The scheduling class Windows keeps for audio threads; failing that, a raised priority.
        private static void Prioritise()
        {
            try
            {
                uint taskIndex = 0;
                if (Native.AvSetMmThreadCharacteristicsW("Pro Audio", ref taskIndex) != IntPtr.Zero) return;
            }
            catch (Exception)
            {
            }
            try
            {
                Thread.CurrentThread.Priority = ThreadPriority.Highest;
            }
            catch (Exception)
            {
            }
        }

        // ---- opening the stream ----

        private static void Open(uint pid, bool exclude)
        {
            IntPtr format = Marshal.AllocHGlobal(40);
            IAudioClient c = null;
            try
            {
                // The process-loopback device has no mix format of its own: we name the
                // format and Windows converts to it. Plain WAVEFORMATEX first, then the
                // extensible form of the same thing.
                uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                int hr = 0;
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    c = Activate(pid, exclude);
                    WriteFormat(format, attempt == 1);
                    hr = c.Initialize(0 /* shared */, flags, BufferTicks, 0, format, IntPtr.Zero);
                    if (hr >= 0) break;
                    Marshal.ReleaseComObject(c);
                    c = null;
                }
                if (c == null) throw Failed("could not open the stream in 48 kHz stereo float", hr);

                uint bufferFrames;
                if (c.GetBufferSize(out bufferFrames) >= 0) statBufferFrames = bufferFrames;

                hr = c.SetEventHandle(audioEvent);
                if (hr < 0) throw Failed("could not set the stream's event", hr);

                Guid iid = IID_IAudioCaptureClient;
                object service;
                hr = c.GetService(ref iid, out service);
                if (hr < 0 || service == null) throw Failed("could not get the capture service", hr);
                IAudioCaptureClient cap = (IAudioCaptureClient)service;

                hr = c.Start();
                if (hr < 0) throw Failed("could not start the stream", hr);

                client = c;
                capture = cap;
                c = null;
            }
            finally
            {
                Marshal.FreeHGlobal(format);
                if (c != null) Marshal.ReleaseComObject(c);
            }
        }

        private static void Close()
        {
            try
            {
                if (client != null) client.Stop();
            }
            catch (Exception)
            {
            }
            try
            {
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
            }
            catch (Exception)
            {
            }
            capture = null;
            client = null;
        }

        private static IAudioClient Activate(uint pid, bool exclude)
        {
            // PROPVARIANT { vt = VT_BLOB, blob = { 12, -> AUDIOCLIENT_ACTIVATION_PARAMS } },
            // with the params in the same allocation, straight after the 24-byte variant.
            IntPtr variant = Marshal.AllocHGlobal(24 + 12);
            try
            {
                for (int i = 0; i < 36; i += 4) Marshal.WriteInt32(variant, i, 0);
                IntPtr blob = new IntPtr(variant.ToInt64() + 24);
                Marshal.WriteInt32(blob, 0, 1);                       // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(blob, 4, unchecked((int)pid));     // TargetProcessId
                Marshal.WriteInt32(blob, 8, exclude ? 1 : 0);         // PROCESS_LOOPBACK_MODE_(IN|EX)CLUDE_TARGET_PROCESS_TREE
                Marshal.WriteInt16(variant, 0, 65);                   // VT_BLOB
                Marshal.WriteInt32(variant, 8, 12);                   // blob.cbSize
                Marshal.WriteIntPtr(variant, 16, blob);               // blob.pBlobData

                ActivationHandler handler = new ActivationHandler();
                Guid iid = IID_IAudioClient;
                IActivateAudioInterfaceAsyncOperation operation;
                int hr = Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, variant, handler, out operation);
                if (hr < 0) throw Failed("could not ask for the app's audio", hr);
                if (!handler.Done.WaitOne(10000))
                {
                    throw new HelperException("failed", Program.ExitFailed, "Windows did not answer the request for the app's audio within 10 seconds.");
                }
                GC.KeepAlive(operation);
                if (handler.Result < 0 || handler.Client == null) throw Failed("refused the request for the app's audio", handler.Result);
                return (IAudioClient)handler.Client;
            }
            finally
            {
                Marshal.FreeHGlobal(variant);
            }
        }

        private static void WriteFormat(IntPtr p, bool extensible)
        {
            for (int i = 0; i < 40; i += 4) Marshal.WriteInt32(p, i, 0);
            Marshal.WriteInt16(p, 0, unchecked((short)(extensible ? 0xFFFE : 3))); // WAVE_FORMAT_EXTENSIBLE : WAVE_FORMAT_IEEE_FLOAT
            Marshal.WriteInt16(p, 2, Channels);
            Marshal.WriteInt32(p, 4, Rate);
            Marshal.WriteInt32(p, 8, Rate * FrameBytes);              // nAvgBytesPerSec
            Marshal.WriteInt16(p, 12, FrameBytes);                    // nBlockAlign
            Marshal.WriteInt16(p, 14, 32);                            // wBitsPerSample
            if (extensible)
            {
                Marshal.WriteInt16(p, 16, 22);                        // cbSize
                Marshal.WriteInt16(p, 18, 32);                        // wValidBitsPerSample
                Marshal.WriteInt32(p, 20, 3);                         // front left | front right
                byte[] subFormat = new Guid("00000003-0000-0010-8000-00AA00389B71").ToByteArray(); // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                Marshal.Copy(subFormat, 0, new IntPtr(p.ToInt64() + 24), 16);
            }
        }

        private static HelperException Failed(string what, int hr)
        {
            string hint = "";
            switch (unchecked((uint)hr))
            {
                case 0x80070005: hint = " Access was denied."; break;
                case 0x80070490: hint = " No audio device was found."; break;
                case 0x88890004: hint = " The audio device was removed or changed."; break;
                case 0x88890008: hint = " The format is not supported."; break;
                case 0x88890010: hint = " The Windows Audio service is not running."; break;
            }
            return new HelperException("failed", Program.ExitFailed,
                "Windows " + what + " (error 0x" + unchecked((uint)hr).ToString("X8") + ")." + hint);
        }

        // ---- the capture thread ----

        private static long FrameAt(long tick)
        {
            // (tick - origin) * 48000 / 10000000, reduced.
            return (tick - origin) * 3 / 625;
        }

        // Takes every packet Windows has ready. Returns a failure HRESULT when the stream broke.
        private static int Drain()
        {
            bool any = false;
            int result = 0;
            while (true)
            {
                long before = Clock.Ticks();
                uint pending;
                int hr = capture.GetNextPacketSize(out pending);
                Timed(ref before);
                if (hr < 0)
                {
                    result = hr;
                    break;
                }
                if (pending == 0) break;

                IntPtr data;
                uint frames, flags;
                ulong devicePosition, stamp; // the device position is always 0 on this device
                hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out stamp);
                Timed(ref before);
                if (hr < 0)
                {
                    result = hr;
                    break;
                }
                if (hr == AUDCLNT_S_BUFFER_EMPTY || frames == 0)
                {
                    capture.ReleaseBuffer(0);
                    break;
                }

                // Copy and hand the buffer straight back; Windows must never wait on us.
                int count = (int)frames;
                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero;
                float peak = 0f;
                if (!silent)
                {
                    int bytes = count * FrameBytes;
                    if (packet.Length < bytes) packet = new byte[bytes];
                    Marshal.Copy(data, packet, 0, bytes);
                }
                before = Clock.Ticks();
                capture.ReleaseBuffer(frames);
                long now = Timed(ref before);

                if (!silent)
                {
                    fixed (byte* p = packet)
                    {
                        float* f = (float*)p;
                        int samples = count * Channels;
                        for (int i = 0; i < samples; i++)
                        {
                            float v = f[i];
                            if (v < 0f) v = -v;
                            if (v > peak) peak = v;
                        }
                    }
                    if (peak == 0f) silent = true;
                }

                lock (gate)
                {
                    Place(count, flags, unchecked((long)stamp), now, silent, peak);
                }
                any = true;
            }
            if (any) Native.SetEvent(dataReady);
            return result;
        }

        // Notes how long a call into Windows took (they can block), and returns the time now.
        private static long Timed(ref long since)
        {
            long now = Clock.Ticks();
            if (now - since > statCallMax) statCallMax = now - since;
            since = now;
            return now;
        }

        // Decides where a packet belongs on the timeline and queues it. Caller holds the gate.
        private static void Place(int frames, uint flags, long stamp, long now, bool silent, float peak)
        {
            long duration = (long)frames * Clock.TicksPerSecond / Rate;

            // When the first frame of this packet was captured. Windows stamps packets
            // on the performance counter's scale; if a stamp is missing or absurd, fall
            // back to "it just finished arriving".
            bool stampOk = stamp != 0 && (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0
                && stamp <= now + Clock.TicksPerSecond / 10 && stamp >= now - 10 * Clock.TicksPerSecond;
            long start;
            long tolerance;
            if (stampOk)
            {
                start = stamp;
                tolerance = ContiguousTicks;
            }
            else
            {
                statBadStamps++;
                start = now - duration;
                tolerance = 30 * 10000;
                if (havePacket && start - lastEnd < tolerance && start - lastEnd > -10 * Clock.TicksPerSecond) start = lastEnd;
            }

            bool gap = !havePacket || (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0 || start - lastEnd > tolerance;
            if (havePacket && !gap)
            {
                long step = Math.Abs(start - lastEnd);
                if (step > statStepMax) statStepMax = step;
            }
            lastEnd = start + duration;
            havePacket = true;

            long lag = now - start;
            if (lag < statLagMin) statLagMin = lag;
            if (lag < statRecentLagMin) statRecentLagMin = lag;
            if (lag > statLagMax) statLagMax = lag;
            statLagSum += lag;
            statPackets++;
            statPacketFrames += frames;
            if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) statDiscontinuities++;
            if (gap) statGaps++;

            // How far the stream is from where this packet belongs: positive when the
            // packet starts later than everything placed so far (silence is missing),
            // negative when the timeline has already passed its start.
            long error = FrameAt(start) - written;
            if (error < statErrorMin) statErrorMin = error;
            if (error > statErrorMax) statErrorMax = error;

            long lead = 0;  // frames of silence to put in front
            int skip = 0;   // frames to cut from the front
            int keep = frames;
            if (silent)
            {
                // Silence can be stretched or shortened freely: end exactly where the
                // clock says this packet ends.
                statSilentPackets++;
                lead = Math.Max(0L, frames + error);
                keep = 0;
                skip = frames;
            }
            else
            {
                if (error > 0)
                {
                    if (gap || error > HardSnapFrames || (peak < QuietPeak && error > QuietSnapFrames)) lead = error;
                }
                else if (error < 0)
                {
                    if (-error > HardSnapFrames || (peak < QuietPeak && -error > QuietSnapFrames))
                    {
                        skip = (int)Math.Min((long)frames, -error);
                        statDroppedFrames += skip;
                    }
                }
                keep = frames - skip;
            }

            if (lead == 0 && keep == 0) return;
            if (!Append(lead, packet, skip * FrameBytes, keep * FrameBytes))
            {
                // The reader has not read for 20 seconds. Let this packet go; the writer
                // covers the time with silence once it can write again.
                statDroppedFrames += keep;
                havePacket = false;
                return;
            }
            statZeroFrames += lead;
            written += lead + keep;
        }

        private static bool Append(long zeroFrames, byte[] data, int offset, int count)
        {
            long total = queued + zeroFrames * FrameBytes + count;
            if (total > MaxQueueBytes) return false;
            if (queue.Length < total)
            {
                int size = queue.Length;
                while (size < total) size *= 2;
                byte[] bigger = new byte[Math.Min(size, MaxQueueBytes)];
                Buffer.BlockCopy(queue, 0, bigger, 0, queued);
                queue = bigger;
            }
            int zeroBytes = (int)(zeroFrames * FrameBytes);
            if (zeroBytes > 0) Array.Clear(queue, queued, zeroBytes);
            if (count > 0) Buffer.BlockCopy(data, offset, queue, queued + zeroBytes, count);
            queued = (int)total;
            if (queued > statQueueMax) statQueueMax = queued;
            return true;
        }

        // ---- the writer thread ----

        private static void WriterLoop()
        {
            Prioritise();

            // Wakes when the capture thread queues something, or 10 ms after the last
            // wake. A plain wait timeout is only as fine as the system timer (15.6 ms,
            // and Windows 11 ignores timeBeginPeriod for a process nobody sees or
            // hears), so the 10 ms come from a high-resolution timer.
            IntPtr timer = Native.CreateWaitableTimerExW(IntPtr.Zero, null, Native.CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, Native.TIMER_ALL_ACCESS);
            IntPtr[] waits = timer != IntPtr.Zero ? new IntPtr[] { dataReady, timer } : new IntPtr[] { dataReady };
            try
            {
                while (true)
                {
                    if (timer != IntPtr.Zero)
                    {
                        long due = -(long)WakeMs * 10000;
                        Native.SetWaitableTimer(timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false);
                    }
                    Native.WaitForMultipleObjects((uint)waits.Length, waits, false, timer != IntPtr.Zero ? 4 * WakeMs : WakeMs);
                    bool last = quitting;
                    long fill = 0;
                    int count;
                    lock (gate)
                    {
                        // Nothing placed for a while: keep the timeline moving with
                        // silence, a margin behind the clock. It goes out after what is
                        // queued, which is where it sits on the timeline.
                        if (!last)
                        {
                            long target = FrameAt(Clock.Ticks() - FillMarginTicks);
                            if (target > written)
                            {
                                fill = target - written;
                                written = target;
                                statZeroFrames += fill;
                            }
                        }
                        byte[] swap = queue;
                        queue = sending;
                        sending = swap;
                        count = queued;
                        queued = 0;
                    }
                    if (count > 0) Write(sending, count);
                    while (fill > 0)
                    {
                        int n = (int)Math.Min(fill, (long)(zeros.Length / FrameBytes));
                        Write(zeros, n * FrameBytes);
                        fill -= n;
                    }
                    if (last) return;
                }
            }
            catch (IOException)
            {
                // The reader closed our stdout: nothing left to do but leave.
            }
            catch (ObjectDisposedException)
            {
            }
            readerGone = true;
            Native.SetEvent(StopSignal.Handle);
        }

        private static void Write(byte[] buffer, int count)
        {
            // An unbuffered stream: this is one WriteFile on the pipe, nothing to flush.
            stdout.Write(buffer, 0, count);
            long now = Clock.Ticks();
            if (statLastWrite != 0 && now - statLastWrite > statWriteGapMax) statWriteGapMax = now - statLastWrite;
            statLastWrite = now;
        }

        // ---- --stats ----

        private static void PrintStats(long now)
        {
            StringBuilder sb = new StringBuilder(512);
            lock (gate)
            {
                sb.Append("{\"event\":\"stats\",\"t\":");
                Out.AppendTime(sb, Clock.EpochMicros());
                sb.Append(",\"frames\":").Append(written);
                sb.Append(",\"clockFrames\":").Append(FrameAt(now));
                sb.Append(",\"packets\":").Append(statPackets);
                sb.Append(",\"packetFrames\":").Append(statPacketFrames);
                sb.Append(",\"silentPackets\":").Append(statSilentPackets);
                sb.Append(",\"discontinuities\":").Append(statDiscontinuities);
                sb.Append(",\"gaps\":").Append(statGaps);
                sb.Append(",\"badStamps\":").Append(statBadStamps);
                sb.Append(",\"zeroFrames\":").Append(statZeroFrames);
                sb.Append(",\"droppedFrames\":").Append(statDroppedFrames);
                sb.Append(",\"reopens\":").Append(statReopens);
                sb.Append(",\"bufferFrames\":").Append(statBufferFrames);
                if (statPackets > 0)
                {
                    sb.Append(",\"lagMinMs\":").Append(Ms(statLagMin));
                    sb.Append(",\"lagAvgMs\":").Append(Ms(statLagSum / statPackets));
                    sb.Append(",\"lagMaxMs\":").Append(Ms(statLagMax));
                    if (statRecentLagMin != long.MaxValue) sb.Append(",\"recentLagMinMs\":").Append(Ms(statRecentLagMin));
                    sb.Append(",\"stepMaxMs\":").Append(Ms(statStepMax));
                    sb.Append(",\"errorMinFrames\":").Append(statErrorMin);
                    sb.Append(",\"errorMaxFrames\":").Append(statErrorMax);
                }
                sb.Append(",\"callMaxMs\":").Append(Ms(statCallMax));
                sb.Append(",\"queueMaxBytes\":").Append(statQueueMax);
                sb.Append(",\"writeGapMaxMs\":").Append(Ms(statWriteGapMax));
                sb.Append('}');
                statRecentLagMin = long.MaxValue;
            }
            Out.Line(Out.Stderr, sb);
        }

        private static string Ms(long ticks)
        {
            long micros = ticks / 10;
            string sign = micros < 0 ? "-" : "";
            micros = Math.Abs(micros);
            long frac = micros % 1000;
            return sign + (micros / 1000) + "." + (frac / 100) + (frac / 10 % 10) + (frac % 10);
        }
    }
}
