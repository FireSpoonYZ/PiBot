using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

namespace ELauncher.Shower
{
    /// <summary>FrameLimits forwarded over the pipe; defaults and ranges follow the shared contract.</summary>
    internal sealed class AgentCaptureLimits
    {
        public const int DefaultMaxWidth = 1280;
        public const int DefaultMaxHeight = 800;
        public const int DefaultMaxBytes = 720 * 1024;
        public const int MinDimension = 160;
        public const int MaxDimension = 4096;
        public const int MinLimitBytes = 1;
        public const int MaxLimitBytes = 720 * 1024;

        public AgentCaptureLimits()
        {
            MaxWidth = DefaultMaxWidth;
            MaxHeight = DefaultMaxHeight;
            MaxBytes = DefaultMaxBytes;
        }

        public int MaxWidth { get; set; }

        public int MaxHeight { get; set; }

        public int MaxBytes { get; set; }
    }

    /// <summary>
    /// GDI capture of the agent's own session desktop. Never touches the parent desktop and never retries with
    /// a different surface; an unusable desktop is reported instead.
    /// </summary>
    internal static class AgentCapture
    {
        private const int SourceCopy = 0x00CC0020;
        private const long JpegQuality = 80L;
        private const double ShrinkFactor = 0.8;

        public static bool TryReadLimits(object raw, out AgentCaptureLimits limits, out AgentFailure failure)
        {
            limits = new AgentCaptureLimits();
            failure = null;
            if (raw == null) return true;
            Dictionary<string, object> fields;
            if (!AgentJson.TryGetObject(raw, out fields))
            {
                failure = new AgentFailure("INVALID_ARGUMENT", "frame.limits must be an object");
                return false;
            }
            string unknown;
            if (AgentJson.HasUnexpectedField(fields, new string[] { "maxWidth", "maxHeight", "maxBytes" }, out unknown))
            {
                failure = new AgentFailure("INVALID_ARGUMENT", "unknown limits field: " + unknown);
                return false;
            }
            int maxWidth = AgentCaptureLimits.DefaultMaxWidth;
            int maxHeight = AgentCaptureLimits.DefaultMaxHeight;
            int maxBytes = AgentCaptureLimits.DefaultMaxBytes;
            if (!TryReadLimit(fields, "maxWidth", AgentCaptureLimits.MinDimension, AgentCaptureLimits.MaxDimension, ref maxWidth, out failure)) return false;
            if (!TryReadLimit(fields, "maxHeight", AgentCaptureLimits.MinDimension, AgentCaptureLimits.MaxDimension, ref maxHeight, out failure)) return false;
            if (!TryReadLimit(fields, "maxBytes", AgentCaptureLimits.MinLimitBytes, AgentCaptureLimits.MaxLimitBytes, ref maxBytes, out failure)) return false;
            limits.MaxWidth = maxWidth;
            limits.MaxHeight = maxHeight;
            limits.MaxBytes = maxBytes;
            return true;
        }

        public static Dictionary<string, object> Capture(AgentCaptureLimits limits, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            Rectangle screen;
            string reason;
            if (!AgentDesktop.TryGetScreen(out screen, out reason))
            {
                failure = new AgentFailure("SHOWER_NOT_READY", reason);
                return null;
            }
            if (Cancelled(cancel))
            {
                failure = new AgentFailure("CANCELLED", "frame cancelled before capture", "not-sent");
                return null;
            }
            using (Bitmap source = GrabScreen(screen))
            {
                if (source == null)
                {
                    failure = new AgentFailure("SHOWER_BACKEND_FAILED", "GDI screen capture failed");
                    return null;
                }
                int imageWidth;
                int imageHeight;
                ScaleToFit(source.Width, source.Height, limits.MaxWidth, limits.MaxHeight, out imageWidth, out imageHeight);
                while (true)
                {
                    if (Cancelled(cancel))
                    {
                        failure = new AgentFailure("CANCELLED", "frame cancelled while encoding", "not-sent");
                        return null;
                    }
                    byte[] jpeg = EncodeJpeg(source, imageWidth, imageHeight);
                    if (jpeg == null)
                    {
                        failure = new AgentFailure("SHOWER_BACKEND_FAILED", "JPEG encoding failed");
                        return null;
                    }
                    if (Base64Length(jpeg.Length) <= limits.MaxBytes)
                    {
                        var frame = new Dictionary<string, object>();
                        frame["capturedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                        frame["width"] = source.Width;
                        frame["height"] = source.Height;
                        frame["imageWidth"] = imageWidth;
                        frame["imageHeight"] = imageHeight;
                        frame["mimeType"] = "image/jpeg";
                        frame["data"] = Convert.ToBase64String(jpeg);
                        return frame;
                    }
                    int nextWidth = (int)(imageWidth * ShrinkFactor);
                    int nextHeight = (int)(imageHeight * ShrinkFactor);
                    if (nextWidth < AgentCaptureLimits.MinDimension || nextHeight < AgentCaptureLimits.MinDimension)
                    {
                        failure = new AgentFailure("SHOWER_FRAME_TOO_LARGE", "desktop does not fit " + limits.MaxBytes.ToString(CultureInfo.InvariantCulture) + " base64 bytes");
                        return null;
                    }
                    imageWidth = nextWidth;
                    imageHeight = nextHeight;
                }
            }
        }

        private static bool TryReadLimit(Dictionary<string, object> fields, string name, int minimum, int maximum, ref int value, out AgentFailure failure)
        {
            failure = null;
            object raw = AgentJson.Get(fields, name);
            if (raw == null) return true;
            int parsed;
            if (!AgentJson.TryGetInt(raw, out parsed) || parsed < minimum || parsed > maximum)
            {
                failure = new AgentFailure("INVALID_ARGUMENT", "frame.limits." + name + " must be " + minimum.ToString(CultureInfo.InvariantCulture) + ".." + maximum.ToString(CultureInfo.InvariantCulture));
                return false;
            }
            value = parsed;
            return true;
        }

        private static bool Cancelled(AgentOpCancel cancel)
        {
            return cancel != null && cancel.Cancelled;
        }

        private static void ScaleToFit(int sourceWidth, int sourceHeight, int maxWidth, int maxHeight, out int width, out int height)
        {
            width = sourceWidth;
            height = sourceHeight;
            if (width <= maxWidth && height <= maxHeight) return;
            double scale = Math.Min((double)maxWidth / sourceWidth, (double)maxHeight / sourceHeight);
            width = Math.Max(1, (int)Math.Floor(sourceWidth * scale));
            height = Math.Max(1, (int)Math.Floor(sourceHeight * scale));
        }

        private static int Base64Length(int bytes)
        {
            return ((bytes + 2) / 3) * 4;
        }

        private static byte[] EncodeJpeg(Bitmap source, int width, int height)
        {
            ImageCodecInfo codec = FindJpegCodec();
            if (codec == null) return null;
            using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.CompositingQuality = CompositingQuality.HighSpeed;
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height));
                }
                using (var parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, JpegQuality);
                    using (var buffer = new MemoryStream())
                    {
                        scaled.Save(buffer, codec, parameters);
                        return buffer.ToArray();
                    }
                }
            }
        }

        private static ImageCodecInfo FindJpegCodec()
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            for (int i = 0; i < codecs.Length; i++)
            {
                if (string.Equals(codecs[i].MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase)) return codecs[i];
            }
            return null;
        }

        private static Bitmap GrabScreen(Rectangle screen)
        {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) return null;
            IntPtr memoryDc = IntPtr.Zero;
            IntPtr bitmap = IntPtr.Zero;
            IntPtr previous = IntPtr.Zero;
            try
            {
                memoryDc = CreateCompatibleDC(screenDc);
                if (memoryDc == IntPtr.Zero) return null;
                bitmap = CreateCompatibleBitmap(screenDc, screen.Width, screen.Height);
                if (bitmap == IntPtr.Zero) return null;
                previous = SelectObject(memoryDc, bitmap);
                if (!BitBlt(memoryDc, 0, 0, screen.Width, screen.Height, screenDc, screen.Left, screen.Top, SourceCopy)) return null;
                using (Bitmap raw = Image.FromHbitmap(bitmap))
                {
                    return new Bitmap(raw);
                }
            }
            finally
            {
                if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previous);
                if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
                if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr dc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr dc, IntPtr graphicsObject);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(IntPtr dc, int x, int y, int width, int height, IntPtr sourceDc, int sourceX, int sourceY, int rasterOperation);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr graphicsObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr dc);
    }
}
