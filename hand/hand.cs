// hand.exe —— 屏幕那扇窗的手和眼。server.mjs 常驻拉起它，一行一条命令（tab 分隔），一行一条回话。
// 只用系统自带的东西：.NET Framework 4 的 csc 编（C# 5 语法），GDI 截屏，SendInput 动手。
//
// 命令                                   回话
// screen                                 OK  W  H  cx  cy
// frame x y w h tw th q since            JPEG len hash cx cy  + len 字节   |  SAME hash cx cy
// move x y                               OK
// button left|right|middle down|up       OK
// click x y left|right|middle n          OK
// scroll x y clicks [h]                  OK   （clicks>0 往下；第四个参数写 h 是横着滚）
// key ctrl+shift+t                       OK
// text <utf8 base64>                     OK
// lastinput                              OK  idleMs  ourMs   （离最后一次输入多久 / 离我们最后一次注入多久）
// win x y                                OK  x0  y0  x1  y1  class   （那一点底下那扇顶层窗；x 写 -1 是前台那扇；桌面/任务栏回整屏）
// front <标题里的一截>                    OK  x0  y0  x1  y1  class  fg|top   （按标题找那扇窗拎到最前面；Windows 不让抢焦点时至少压到最上层）
// 出错一律：ERR 原因
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Hand
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);

    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L; public int T; public int R; public int B; }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;
    const uint WHEEL = 0x800, HWHEEL = 0x1000;
    static readonly IntPtr MARK = new IntPtr(0x4B41454C); // 'KAEL'，往后分辨谁按的
    static long lastOurs = 0; // 我们最后一次注入的 Environment.TickCount

    // Record non-KAEL input independently: our next injection must not erase it.
    delegate IntPtr Hook(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, Hook proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; public uint extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public POINT pt; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyHook { public uint vk, scan, flags, time; public IntPtr extra; }
    static Hook mouseHook, keyHook;
    static int otherTick, otherSeen;
    static bool monitorReady;
    static void StartMonitor()
    {
        ManualResetEvent ready = new ManualResetEvent(false);
        Thread t = new Thread(delegate () {
            mouseHook = delegate (int code, IntPtr w, IntPtr l) {
                if (code >= 0 && ((MouseHook)Marshal.PtrToStructure(l, typeof(MouseHook))).extra != MARK) ForeignInput();
                return CallNextHookEx(IntPtr.Zero, code, w, l);
            };
            keyHook = delegate (int code, IntPtr w, IntPtr l) {
                if (code >= 0 && ((KeyHook)Marshal.PtrToStructure(l, typeof(KeyHook))).extra != MARK) ForeignInput();
                return CallNextHookEx(IntPtr.Zero, code, w, l);
            };
            IntPtr m = SetWindowsHookEx(14, mouseHook, GetModuleHandle(null), 0);
            IntPtr k = SetWindowsHookEx(13, keyHook, GetModuleHandle(null), 0);
            monitorReady = m != IntPtr.Zero && k != IntPtr.Zero; ready.Set();
            if (!monitorReady) return;
            MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWindowsHookEx(m); UnhookWindowsHookEx(k);
        });
        t.IsBackground = true; t.Start();
        if (!ready.WaitOne(2000) || !monitorReady) throw new Exception("input monitor unavailable");
    }
    static void ForeignInput() { Interlocked.Exchange(ref otherTick, Environment.TickCount); Interlocked.Exchange(ref otherSeen, 1); }
    static void MoveCursor(int x, int y)
    {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        INPUT[] a = new INPUT[1]; a[0].type = INPUT_MOUSE;
        a[0].u.mi.dx = (int)Math.Round(Math.Max(0, Math.Min(width - 1, x - left)) * 65535.0 / Math.Max(1, width - 1));
        a[0].u.mi.dy = (int)Math.Round(Math.Max(0, Math.Min(height - 1, y - top)) * 65535.0 / Math.Max(1, height - 1));
        a[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000; a[0].u.mi.dwExtraInfo = MARK; Send(a);
    }

    static Stream stdout;
    static ImageCodecInfo jpegCodec;

    static void Main()
    {
        SetProcessDPIAware();
        StartMonitor();
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpegCodec = c;
        stdout = Console.OpenStandardOutput();
        StreamReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            string[] a = line.Split('\t');
            try { Handle(a); }
            catch (Exception e) { Reply("ERR\t" + e.GetType().Name + ": " + e.Message.Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ')); }
        }
    }

    static void Reply(string head) { Reply(head, null); }
    static void Reply(string head, byte[] body)
    {
        byte[] h = Encoding.UTF8.GetBytes(head + "\n");
        stdout.Write(h, 0, h.Length);
        if (body != null) stdout.Write(body, 0, body.Length);
        stdout.Flush();
    }

    static int I(string s) { return int.Parse(s, System.Globalization.CultureInfo.InvariantCulture); }

    static void Handle(string[] a)
    {
        POINT p;
        switch (a[0])
        {
            case "ping": Reply("OK"); return;
            case "screen":
                GetCursorPos(out p);
                Reply(string.Format("OK\t{0}\t{1}\t{2}\t{3}", GetSystemMetrics(0), GetSystemMetrics(1), p.X, p.Y));
                return;
            case "frame": Frame(I(a[1]), I(a[2]), I(a[3]), I(a[4]), I(a[5]), I(a[6]), I(a[7]), a.Length > 8 ? a[8] : "", a.Length > 9 && a[9] == "layers"); return;
            case "move": MoveCursor(I(a[1]), I(a[2])); Touch(); Reply("OK"); return;
            case "button": Button(a[1], a[2] == "down"); Reply("OK"); return;
            case "click":
                MoveCursor(I(a[1]), I(a[2]));
                Thread.Sleep(15);
                int n = a.Length > 4 ? I(a[4]) : 1;
                for (int i = 0; i < n; i++) { Button(a[3], true); Thread.Sleep(10); Button(a[3], false); if (i < n - 1) Thread.Sleep(40); }
                Reply("OK"); return;
            case "scroll":
                MoveCursor(I(a[1]), I(a[2]));
                Thread.Sleep(10);
                bool horiz = a.Length > 4 && a[4] == "h";
                int clicks = I(a[3]);
                Mouse(horiz ? HWHEEL : WHEEL, (uint)(horiz ? clicks * 120 : -clicks * 120));
                Reply("OK"); return;
            case "key": Key(a[1]); Reply("OK"); return;
            case "text": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); Reply("OK"); return;
            case "lastinput":
                LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
                if (!GetLastInputInfo(ref li) || !monitorReady) throw new Exception("input monitor unavailable");
                long now = Environment.TickCount;
                Reply(string.Format("OK\t{0}\t{1}\t{2}", (uint)(now - li.dwTime), lastOurs == 0 ? -1 : (long)(uint)(now - lastOurs), Interlocked.CompareExchange(ref otherSeen, 0, 0) == 0 ? -1 : (long)(uint)((uint)now - (uint)Interlocked.CompareExchange(ref otherTick, 0, 0))));
                return;
            case "win": Win(I(a[1]), I(a[2])); return;
            case "front": Front(a[1]); return;
        }
        Reply("ERR\tunknown command " + a[0]);
    }

    static void Touch() { lastOurs = Environment.TickCount; }

    // —— 我正在用的那扇窗：聊天间那张会动的图只裁这一扇 ——
    static void Win(int x, int y)
    {
        IntPtr h;
        if (x < 0) h = GetForegroundWindow();
        else { POINT q; q.X = x; q.Y = y; h = GetAncestor(WindowFromPoint(q), 2 /* GA_ROOT */); }
        Reply(RectOf(h));
    }

    // OpenCLI 说开在前台，Chrome 的新窗却常被 Windows 压在后面（别的窗还在最前）。
    // 按标题找那扇（z 序从上往下第一个对得上的），借前台那条线程的输入抢一下焦点；抢不到也用置顶再取消置顶把它压到最上层
    static void Front(string want)
    {
        IntPtr hit = IntPtr.Zero;
        StringBuilder t = new StringBuilder(512);
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            t.Length = 0; GetWindowText(h, t, t.Capacity);
            if (t.ToString().IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) { hit = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (hit == IntPtr.Zero) { Reply("ERR\tno window: " + want); return; }
        if (IsIconic(hit)) ShowWindow(hit, 9 /* SW_RESTORE */);
        uint me = GetCurrentThreadId(), them = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool att = them != 0 && them != me && AttachThreadInput(me, them, true);
        SetWindowPos(hit, new IntPtr(-1) /* TOPMOST */, 0, 0, 0, 0, 0x3 /* NOSIZE|NOMOVE */);
        SetWindowPos(hit, new IntPtr(-2) /* NOTOPMOST */, 0, 0, 0, 0, 0x3);
        BringWindowToTop(hit);
        SetForegroundWindow(hit);
        if (att) AttachThreadInput(me, them, false);
        Thread.Sleep(150);
        Reply(RectOf(hit) + (GetForegroundWindow() == hit ? "\tfg" : "\ttop"));
    }

    static string RectOf(IntPtr h)
    {
        int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
        StringBuilder cls = new StringBuilder(128);
        if (h != IntPtr.Zero) GetClassName(h, cls, cls.Capacity);
        string c = cls.ToString();
        RECT r;
        bool whole = h == IntPtr.Zero || c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd";
        if (whole || (DwmGetWindowAttribute(h, 9 /* EXTENDED_FRAME_BOUNDS */, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)))
        { r.L = 0; r.T = 0; r.R = sw; r.B = sh; }
        r.L = Math.Max(0, r.L); r.T = Math.Max(0, r.T); r.R = Math.Min(sw, r.R); r.B = Math.Min(sh, r.B);
        if (r.R - r.L < 40 || r.B - r.T < 40) { r.L = 0; r.T = 0; r.R = sw; r.B = sh; }
        return string.Format("OK\t{0}\t{1}\t{2}\t{3}\t{4}", r.L, r.T, r.R, r.B, c.Length > 0 ? c : "-");
    }

    // —— 眼 ——
    // layers=true 时连分层窗口（我那层字幕和涟漪）一起拍——默认不拍，免得我自己的字挡住我要看的界面
    static void Frame(int x, int y, int w, int h, int tw, int th, int q, string since, bool layers)
    {
        int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
        if (x < 0) x = 0; if (y < 0) y = 0;
        if (x + w > sw) w = sw - x; if (y + h > sh) h = sh - y;
        if (w < 1 || h < 1) { Reply("ERR\tempty region"); return; }
        if (tw < 1 || th < 1) { tw = w; th = h; }
        POINT p; GetCursorPos(out p);
        using (Bitmap src = new Bitmap(w, h, PixelFormat.Format32bppRgb))
        {
            using (Graphics g = Graphics.FromImage(src))
            {
                if (layers)
                {
                    IntPtr dc = g.GetHdc(), sdc = GetDC(IntPtr.Zero);
                    try { BitBlt(dc, 0, 0, w, h, sdc, x, y, 0x00CC0020 | 0x40000000); }
                    finally { ReleaseDC(IntPtr.Zero, sdc); g.ReleaseHdc(dc); }
                }
                else g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            Bitmap outBmp = src;
            if (tw != w || th != h)
            {
                outBmp = new Bitmap(tw, th, PixelFormat.Format32bppRgb);
                using (Graphics g2 = Graphics.FromImage(outBmp))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g2.CompositingMode = CompositingMode.SourceCopy;
                    g2.DrawImage(src, new Rectangle(0, 0, tw, th), 0, 0, w, h, GraphicsUnit.Pixel);
                }
            }
            try
            {
                string hash = Hash(outBmp);
                if (hash == since) { Reply(string.Format("SAME\t{0}\t{1}\t{2}", hash, p.X, p.Y)); return; }
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(10, Math.Min(95, q)));
                using (MemoryStream ms = new MemoryStream())
                {
                    outBmp.Save(ms, jpegCodec, ep);
                    byte[] bytes = ms.ToArray();
                    Reply(string.Format("JPEG\t{0}\t{1}\t{2}\t{3}", bytes.Length, hash, p.X, p.Y), bytes);
                }
            }
            finally { if (!object.ReferenceEquals(outBmp, src)) outBmp.Dispose(); }
        }
    }

    static string Hash(Bitmap b)
    {
        BitmapData d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try
        {
            int len = Math.Abs(d.Stride) * b.Height;
            byte[] buf = new byte[len];
            Marshal.Copy(d.Scan0, buf, 0, len);
            ulong hsh = 1469598103934665603UL;
            for (int i = 0; i < len; i += 4) // 只看 BGR，第四个字节在 32bppRgb 里不算数
            {
                hsh = (hsh ^ buf[i]) * 1099511628211UL;
                hsh = (hsh ^ buf[i + 1]) * 1099511628211UL;
                hsh = (hsh ^ buf[i + 2]) * 1099511628211UL;
            }
            return hsh.ToString("x16");
        }
        finally { b.UnlockBits(d); }
    }

    // —— 手 ——
    static void Mouse(uint flags, uint data)
    {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dwFlags = flags;
        inp[0].u.mi.mouseData = data;
        inp[0].u.mi.dwExtraInfo = MARK;
        Send(inp);
    }

    static void Button(string which, bool down)
    {
        uint f;
        if (which == "right") f = down ? 0x8u : 0x10u;
        else if (which == "middle") f = down ? 0x20u : 0x40u;
        else f = down ? 0x2u : 0x4u;
        Mouse(f, 0);
    }

    static void Send(INPUT[] inp)
    {
        uint sent = SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT)));
        Touch();
        if (sent != inp.Length) throw new Exception("SendInput 只送出 " + sent + "/" + inp.Length + "（被挡了？对面可能是管理员窗口）, err " + Marshal.GetLastWin32Error());
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; i.u.ki.dwExtraInfo = MARK;
        return i;
    }

    static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>
    {
        {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"win",0x5B},{"meta",0x5B},
        {"enter",0x0D},{"return",0x0D},{"esc",0x1B},{"escape",0x1B},{"tab",0x09},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},
        {"space",0x20},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"home",0x24},{"end",0x23},
        {"pageup",0x21},{"pagedown",0x22},{"insert",0x2D},{"printscreen",0x2C},{"capslock",0x14},{"contextmenu",0x5D},
        {"minus",0xBD},{"-",0xBD},{"equal",0xBB},{"plus",0xBB},{"=",0xBB},{"comma",0xBC},{",",0xBC},{"period",0xBE},{".",0xBE},
        {"slash",0xBF},{"/",0xBF},{"semicolon",0xBA},{";",0xBA},{"quote",0xDE},{"'",0xDE},{"bracketleft",0xDB},{"[",0xDB},
        {"bracketright",0xDD},{"]",0xDD},{"backslash",0xDC},{"\\",0xDC},{"backquote",0xC0},{"`",0xC0},
    };
    static readonly HashSet<ushort> EXT = new HashSet<ushort> { 0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B, 0x5D };

    static ushort VkOf(string k)
    {
        k = k.Trim().ToLowerInvariant();
        ushort v;
        if (VK.TryGetValue(k, out v)) return v;
        if (k.Length == 1)
        {
            char c = k[0];
            if (c >= 'a' && c <= 'z') return (ushort)(c - 'a' + 0x41);
            if (c >= '0' && c <= '9') return (ushort)c;
        }
        if (k.Length >= 2 && k[0] == 'f')
        {
            int n;
            if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
        }
        throw new Exception("不认识的键 " + k);
    }

    static void Key(string combo)
    {
        string[] parts = combo.Split('+');
        List<ushort> vks = new List<ushort>();
        foreach (string s in parts) vks.Add(VkOf(s));
        List<INPUT> seq = new List<INPUT>();
        foreach (ushort v in vks) seq.Add(KeyInput(v, 0, EXT.Contains(v) ? EXTENDED : 0));
        for (int i = vks.Count - 1; i >= 0; i--) seq.Add(KeyInput(vks[i], 0, KEYUP | (EXT.Contains(vks[i]) ? EXTENDED : 0)));
        Send(seq.ToArray());
    }

    static void TypeText(string s)
    {
        List<INPUT> seq = new List<INPUT>();
        foreach (char c in s)
        {
            if (c == '\r') continue;
            if (c == '\n') { seq.Add(KeyInput(0x0D, 0, 0)); seq.Add(KeyInput(0x0D, 0, KEYUP)); }
            else if (c == '\t') { seq.Add(KeyInput(0x09, 0, 0)); seq.Add(KeyInput(0x09, 0, KEYUP)); }
            else { seq.Add(KeyInput(0, c, UNICODE)); seq.Add(KeyInput(0, c, UNICODE | KEYUP)); }
            if (seq.Count >= 40) { Send(seq.ToArray()); seq.Clear(); Thread.Sleep(8); }
        }
        if (seq.Count > 0) Send(seq.ToArray());
    }
}
