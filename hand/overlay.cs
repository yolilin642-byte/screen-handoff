// overlay.exe —— 屏幕最上面那层「我」。CrossDesk 抓屏不带光标，所以我点哪儿、在干嘛，得自己画出来，谁连进来都看得见。
// 两扇小窗，都置顶、点不中（WS_EX_TRANSPARENT）、不抢焦点、不进任务栏，逐像素透明（UpdateLayeredWindow）：
//   字幕窗：屏幕底边正中一行字，左边一枚 K 印。
//   手印窗：动作落在哪儿，那儿泛开一圈涟漪；挪动时只留一个小点。
// stdin 一行一条（tab 分隔）：
//   say <文字>        换字幕（空=收起）
//   wait <文字>       字幕换成等人的样子
//   tap x y           点击涟漪（屏幕物理像素）
//   at x y            手停在这儿（小点）
//   hide              全收
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Overlay
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll", SetLastError = true)] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int w, int h) { cx = w; cy = h; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    // 颜色：纸 #eef0ea、墨 #2b2e2a、绿 #3f6b5a。
    static readonly Color Paper = Color.FromArgb(236, 238, 240, 234);
    static readonly Color Ink = Color.FromArgb(255, 43, 46, 42);
    static readonly Color Green = Color.FromArgb(255, 63, 107, 90);
    static readonly Color Rust = Color.FromArgb(255, 150, 86, 60);

    class Layer : Form
    {
        public Layer() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; TopMost = true; }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000 | 0x00000008; // LAYERED|TRANSPARENT|TOOLWINDOW|NOACTIVATE|TOPMOST
                return cp;
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }

        public void Paint32(Bitmap bmp, int x, int y)
        {
            IntPtr screenDc = GetDC(IntPtr.Zero), memDc = CreateCompatibleDC(screenDc), hBmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(memDc, hBmp);
                SIZE size = new SIZE(bmp.Width, bmp.Height);
                POINT src = new POINT(0, 0), dst = new POINT(x, y);
                BLENDFUNCTION blend = new BLENDFUNCTION(); blend.BlendOp = 0; blend.SourceConstantAlpha = 255; blend.AlphaFormat = 1;
                UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // 钉在最上面
            }
            finally
            {
                if (old != IntPtr.Zero) SelectObject(memDc, old);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc);
            }
        }
    }

    static Layer caption, mark;
    static System.Windows.Forms.Timer anim;
    static int sw, sh;
    static float scale;
    static int tapX, tapY; static DateTime tapAt = DateTime.MinValue; static bool tapping;
    static Font capFont, sealFont;

    [STAThread]
    static void Main()
    {
        SetProcessDPIAware();
        sw = GetSystemMetrics(0); sh = GetSystemMetrics(1);
        scale = sh / 1067f; // 150% 缩放下逻辑高 1067；按物理像素放大笔画
        capFont = new Font("Microsoft YaHei UI", 11f * scale, FontStyle.Regular, GraphicsUnit.Point);
        sealFont = new Font("Georgia", 10.5f * scale, FontStyle.Bold | FontStyle.Italic, GraphicsUnit.Point);
        caption = new Layer(); mark = new Layer();
        caption.Show(); mark.Show();
        caption.Paint32(new Bitmap(1, 1, PixelFormat.Format32bppArgb), 0, 0);
        mark.Paint32(new Bitmap(1, 1, PixelFormat.Format32bppArgb), 0, 0);
        anim = new System.Windows.Forms.Timer(); anim.Interval = 33; anim.Tick += delegate { DrawMark(); };
        Thread reader = new Thread(ReadLoop); reader.IsBackground = true; reader.Start();
        Application.Run();
    }

    static void ReadLoop()
    {
        StreamReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            string[] a = line.Split('\t');
            string l = line;
            try { caption.BeginInvoke(new Action(delegate { Handle(a); })); } catch { }
        }
        try { caption.BeginInvoke(new Action(delegate { Application.Exit(); })); } catch { }
    }

    static void Handle(string[] a)
    {
        switch (a[0])
        {
            case "say": DrawCaption(a.Length > 1 ? a[1] : "", false); break;
            case "wait": DrawCaption(a.Length > 1 ? a[1] : "你在用，我等着", true); break;
            case "tap": tapX = int.Parse(a[1]); tapY = int.Parse(a[2]); tapAt = DateTime.Now; tapping = true; anim.Start(); break;
            case "at": tapX = int.Parse(a[1]); tapY = int.Parse(a[2]); tapping = false; tapAt = DateTime.Now; anim.Start(); break;
            case "hide": DrawCaption("", false); tapAt = DateTime.MinValue; DrawMark(); break;
        }
    }

    static void DrawCaption(string text, bool waiting)
    {
        if (string.IsNullOrEmpty(text)) { caption.Paint32(new Bitmap(1, 1, PixelFormat.Format32bppArgb), 0, 0); return; }
        int padX = (int)(14 * scale), padY = (int)(8 * scale), seal = (int)(22 * scale), gap = (int)(10 * scale);
        SizeF ts;
        using (Bitmap probe = new Bitmap(1, 1)) using (Graphics pg = Graphics.FromImage(probe)) ts = pg.MeasureString(text, capFont);
        int w = (int)(padX * 2 + seal + gap + ts.Width), h = (int)Math.Max(seal + padY * 2, ts.Height + padY * 2);
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (GraphicsPath p = Pill(0, 0, w - 1, h - 1, h / 2f)) using (SolidBrush b = new SolidBrush(Paper)) g.FillPath(b, p);
            Color sealColor = waiting ? Rust : Green;
            int sy = (h - seal) / 2;
            using (SolidBrush b = new SolidBrush(sealColor)) g.FillEllipse(b, padX, sy, seal, seal);
            StringFormat c = new StringFormat(); c.Alignment = StringAlignment.Center; c.LineAlignment = StringAlignment.Center;
            using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 240, 238, 230))) g.DrawString("K", sealFont, b, new RectangleF(padX, sy - 1, seal, seal), c);
            using (SolidBrush b = new SolidBrush(Ink)) g.DrawString(text, capFont, b, padX + seal + gap, (h - ts.Height) / 2f);
            caption.Paint32(bmp, (sw - w) / 2, sh - h - (int)(64 * scale));
        }
    }

    static void DrawMark()
    {
        double t = (DateTime.Now - tapAt).TotalMilliseconds;
        int size = (int)(90 * scale);
        if (tapAt == DateTime.MinValue || t > (tapping ? 900 : 2500)) { anim.Stop(); mark.Paint32(new Bitmap(1, 1, PixelFormat.Format32bppArgb), 0, 0); return; }
        using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float c = size / 2f;
            float dot = 7 * scale;
            int fade = tapping ? 255 : (int)Math.Max(0, 255 - Math.Max(0, t - 1500) / 1000 * 255);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(fade, Green))) g.FillEllipse(b, c - dot / 2, c - dot / 2, dot, dot);
            if (tapping)
            {
                double k = Math.Min(1, t / 900);
                float r = (float)(6 * scale + k * (size / 2f - 8 * scale));
                int alpha = (int)(220 * (1 - k));
                using (Pen p = new Pen(Color.FromArgb(alpha, Green), 2.2f * scale)) g.DrawEllipse(p, c - r, c - r, r * 2, r * 2);
            }
            mark.Paint32(bmp, tapX - size / 2, tapY - size / 2);
        }
    }

    static GraphicsPath Pill(float x, float y, float w, float h, float r)
    {
        GraphicsPath p = new GraphicsPath();
        p.AddArc(x, y, r * 2, h, 90, 180);
        p.AddArc(x + w - r * 2, y, r * 2, h, 270, 180);
        p.CloseFigure();
        return p;
    }
}
