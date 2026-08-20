# Generate multi-size dsh-shell.ico from the OFFICIAL favicon.svg (GDI+ vector render).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1 [-Color black|white]
param([string]$Color = 'black')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$svgPath = Join-Path $PSScriptRoot 'favicon.svg'
$out = Join-Path $PSScriptRoot 'dsh-shell.ico'
if (-not (Test-Path $svgPath)) { throw 'favicon.svg not found next to make-icon.ps1' }
if (Test-Path $out) { Copy-Item $out ($out + '.bak') -Force }
Add-Type -ReferencedAssemblies 'System.Drawing' @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

public static class OfficialIcon
{
    public static GraphicsPath ParseSvgPath(string d)
    {
        var gp = new GraphicsPath();
        var tokens = Regex.Matches(d, @"[MCLZ]|-?\d+\.?\d*(?:[eE][+-]?\d+)?");
        int i = 0;
        char cmd = 'M';
        float cx = 0, cy = 0;
        while (i < tokens.Count)
        {
            string t = tokens[i].Value;
            if (t.Length == 1 && "MCLZ".IndexOf(t[0]) >= 0) { cmd = t[0]; i++; continue; }
            float v = float.Parse(t, CultureInfo.InvariantCulture);
            switch (cmd)
            {
                case 'M':
                    cx = v; cy = ParseF(tokens, i + 1);
                    gp.StartFigure(); i += 2; break;
                case 'L':
                    { float nx = v, ny = ParseF(tokens, i + 1); gp.AddLine(cx, cy, nx, ny); cx = nx; cy = ny; i += 2; break; }
                case 'C':
                    {
                        float x1 = v, y1 = ParseF(tokens, i + 1), x2 = ParseF(tokens, i + 2), y2 = ParseF(tokens, i + 3);
                        float x = ParseF(tokens, i + 4), y = ParseF(tokens, i + 5);
                        gp.AddBezier(cx, cy, x1, y1, x2, y2, x, y);
                        cx = x; cy = y; i += 6; break;
                    }
                case 'Z': gp.CloseFigure(); i++; break;
            }
        }
        return gp;
    }
    static float ParseF(MatchCollection tokens, int idx)
    {
        if (idx >= tokens.Count) return 0f;
        return float.Parse(tokens[idx].Value, CultureInfo.InvariantCulture);
    }

    public static GraphicsPath RoundedRect(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        float d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static Bitmap Draw(int size, GraphicsPath logo, Color glyph)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            // Windows icon convention: transparent background, no fill.
            // Slightly above the Fluent safe area (83.3%) toward common app-icon usage (~85-92%):
            // width 88%, height 66% (official logo AR ~1.33:1, width is the limiting edge).
            var b = logo.GetBounds();
            float target = size * 0.88f;
            float scale = Math.Min(target / b.Width, target / b.Height);
            float w = b.Width * scale, h = b.Height * scale;
            g.TranslateTransform((size - w) / 2f - b.X * scale, (size - h) / 2f - b.Y * scale);
            g.ScaleTransform(scale, scale);
            using (var br = new SolidBrush(glyph))
                g.FillPath(br, logo);
        }
        return bmp;
    }

    public static byte[] BuildIcon(int[] sizes, GraphicsPath logo, Color glyph)
    {
        int n = sizes.Length;
        byte[][] datas = new byte[n][];
        for (int i = 0; i < n; i++)
        {
            using (var bmp = Draw(sizes[i], logo, glyph))
            {
                if (sizes[i] >= 256)
                {
                    using (var pms = new MemoryStream()) { bmp.Save(pms, ImageFormat.Png); datas[i] = pms.ToArray(); }
                }
                else datas[i] = ToBmpBytes(bmp);
            }
        }
        using (var ms = new MemoryStream())
        {
            using (var bw = new BinaryWriter(ms))
            {
                bw.Write((ushort)0); bw.Write((ushort)1); bw.Write((ushort)n);
                long off = 6 + 16L * n;
                for (int i = 0; i < n; i++)
                {
                    int dim = sizes[i] >= 256 ? 0 : sizes[i];
                    bw.Write((byte)dim); bw.Write((byte)dim);
                    bw.Write((byte)0); bw.Write((byte)0);
                    bw.Write((ushort)1); bw.Write((ushort)32);
                    bw.Write((uint)datas[i].Length); bw.Write((uint)off);
                    off += datas[i].Length;
                }
                for (int i = 0; i < n; i++) bw.Write(datas[i]);
            }
            return ms.ToArray();
        }
    }

    static byte[] ToBmpBytes(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        int stride = w * 4;
        int maskStride = (w + 31) / 32 * 4;
        using (var ms = new MemoryStream())
        {
            using (var bw = new BinaryWriter(ms))
            {
                bw.Write(40);
                bw.Write(w); bw.Write(h * 2);
                bw.Write((ushort)1); bw.Write((ushort)32);
                bw.Write(0); bw.Write((uint)(stride * h + maskStride * h));
                bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
                for (int y = h - 1; y >= 0; y--)
                    for (int x = 0; x < w; x++)
                    {
                        Color c = bmp.GetPixel(x, y);
                        bw.Write((byte)c.B); bw.Write((byte)c.G); bw.Write((byte)c.R); bw.Write((byte)c.A);
                    }
                for (int i = 0; i < h * maskStride; i++) bw.Write((byte)0);
            }
            return ms.ToArray();
        }
    }
}
'@
$raw = [System.IO.File]::ReadAllText($svgPath)
$m = [regex]::Match($raw, ' d="([^"]*)"')
if (-not $m.Success) { throw 'd attribute not found in favicon.svg' }
$d = $m.Groups[1].Value
$logo = [OfficialIcon]::ParseSvgPath($d)
$b = $logo.GetBounds()
"LOGO bbox: x=" + [math]::Round($b.X,1) + " y=" + [math]::Round($b.Y,1) + " w=" + [math]::Round($b.Width,1) + " h=" + [math]::Round($b.Height,1)
if ($Color -eq 'white') { $brush = [System.Drawing.Color]::White } else { $brush = [System.Drawing.Color]::FromArgb(255, 18, 18, 18) }
$ico = [OfficialIcon]::BuildIcon(@(16, 24, 32, 48, 64, 128, 256), $logo, $brush)
$tmp = Join-Path $env:TEMP 'dsh-official-icon.ico'
[System.IO.File]::WriteAllBytes($tmp, $ico)
Copy-Item $tmp $out -Force
"ICO bytes: " + (Get-Item $out).Length
