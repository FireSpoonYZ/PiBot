using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace ELauncher.Shower
{
    /// <summary>
    /// Probes the agent's own session desktop. A locked, disconnected or foreign desktop is reported as an
    /// error; nothing is captured or injected anywhere else.
    /// </summary>
    internal static class AgentDesktop
    {
        private const int SmXVirtualScreen = 76;
        private const int SmYVirtualScreen = 77;
        private const int SmCxVirtualScreen = 78;
        private const int SmCyVirtualScreen = 79;
        private const uint DesktopReadObjects = 0x0001;
        private const uint DesktopSwitchDesktop = 0x0100;
        private const int UoiName = 2;

        public static bool TryGetScreen(out Rectangle screen, out string reason)
        {
            screen = Rectangle.Empty;
            int width = GetSystemMetrics(SmCxVirtualScreen);
            int height = GetSystemMetrics(SmCyVirtualScreen);
            if (width <= 0 || height <= 0)
            {
                reason = "session desktop has no screen (disconnected or still logging in)";
                return false;
            }
            if (!IsInputDesktop())
            {
                reason = "session desktop is locked or a secure desktop is active";
                return false;
            }
            screen = new Rectangle(GetSystemMetrics(SmXVirtualScreen), GetSystemMetrics(SmYVirtualScreen), width, height);
            reason = null;
            return true;
        }

        /// <summary>Input can only reach this session while its own default desktop is the input desktop.</summary>
        public static bool IsInputDesktop()
        {
            IntPtr input = OpenInputDesktop(0, false, DesktopReadObjects);
            if (input == IntPtr.Zero) return false;
            try
            {
                string inputName = DesktopName(input);
                string ownName = DesktopName(GetThreadDesktop(GetCurrentThreadId()));
                if (inputName == null || ownName == null) return false;
                return string.Equals(inputName, ownName, StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                CloseDesktop(input);
            }
        }

        private static string DesktopName(IntPtr desktop)
        {
            if (desktop == IntPtr.Zero) return null;
            uint needed;
            // A null buffer only queries the required length; the call itself reports ERROR_MORE_DATA.
            GetUserObjectInformation(desktop, UoiName, IntPtr.Zero, 0, out needed);
            if (needed == 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!GetUserObjectInformation(desktop, UoiName, buffer, needed, out needed)) return null;
                return Marshal.PtrToStringUni(buffer);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);

        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDesktop(uint threadId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr info, uint length, out uint needed);
    }

    /// <summary>SendInput-based injection: Unicode text, key/modifier pairs, clicks, drags and wheel notches.</summary>
    internal static class AgentInput
    {
        private const uint InputMouse = 0;
        private const uint InputKeyboard = 1;

        private const uint MouseMove = 0x0001;
        private const uint MouseLeftDown = 0x0002;
        private const uint MouseLeftUp = 0x0004;
        private const uint MouseRightDown = 0x0008;
        private const uint MouseRightUp = 0x0010;
        private const uint MouseMiddleDown = 0x0020;
        private const uint MouseMiddleUp = 0x0040;
        private const uint MouseWheel = 0x0800;
        private const uint MouseHWheel = 0x1000;
        private const uint MouseAbsolute = 0x8000;
        private const uint MouseVirtualDesk = 0x4000;

        private const uint KeyExtended = 0x0001;
        private const uint KeyUp = 0x0002;
        private const uint KeyUnicode = 0x0004;

        private const ushort VkShift = 0x10;
        private const ushort VkControl = 0x11;
        private const ushort VkMenu = 0x12;
        private const ushort VkLeftShift = 0xA0;
        private const ushort VkRightShift = 0xA1;
        private const ushort VkLeftControl = 0xA2;
        private const ushort VkRightControl = 0xA3;
        private const ushort VkLeftMenu = 0xA4;
        private const ushort VkRightMenu = 0xA5;
        private const ushort VkLeftWindows = 0x5B;
        private const ushort VkRightWindows = 0x5C;
        private const ushort VkReturn = 0x0D;
        private const ushort VkTab = 0x09;

        /// <summary>One wheel notch. The protocol sends notch counts, Windows wants WHEEL_DELTA units.</summary>
        private const int WheelNotch = 120;
        private const int MaxScrollNotches = 20;
        private const int MaxTextChars = 1000;
        private const int DragStepMs = 16;
        private const int MinDragMs = 50;
        private const int MaxDragMs = 3000;

        private static readonly Dictionary<string, ushort> KeyVirtualList = CreateKeys();
        private static readonly HashSet<string> ExtendedKeys = CreateExtendedKeys();
        private static readonly Dictionary<string, ushort> ModifierVirtualList = CreateModifiers();
        private static readonly string[] ModifierOrder = new string[] { "CTRL", "ALT", "SHIFT", "META" };

        public static Dictionary<string, object> Execute(Dictionary<string, object> input, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            string type;
            if (!AgentJson.TryGetString(AgentJson.Get(input, "type"), out type) || type.Length == 0)
            {
                failure = Invalid("input.type must be a non-empty string");
                return null;
            }
            Rectangle screen;
            string reason;
            if (!AgentDesktop.TryGetScreen(out screen, out reason))
            {
                // Locked/secure desktop: the user has to unlock the child session before input can land.
                failure = new AgentFailure("SHOWER_AUTH_REQUIRED", reason);
                return null;
            }
            if (cancel != null && cancel.Cancelled)
            {
                failure = CancelledBeforeStart();
                return null;
            }
            if (type == "click") return Click(input, screen, cancel, out failure);
            if (type == "drag") return Drag(input, screen, cancel, out failure);
            if (type == "scroll") return Scroll(input, screen, out failure);
            if (type == "key") return PressKey(input, out failure);
            if (type == "text") return TypeText(input, cancel, out failure);
            failure = new AgentFailure("SHOWER_UNSUPPORTED", "unsupported input type: " + type);
            return null;
        }

        /// <summary>
        /// Releases every generic and left/right modifier plus the three mouse buttons; keys that were
        /// never pressed are harmless to release. Cua cancel calls this only after the driver tree is
        /// confirmed dead, so a killed driver cannot press again afterwards.
        /// </summary>
        public static void ReleaseHeldInput()
        {
            AgentFailure ignored;
            SendKey(VkShift, false, true, out ignored);
            SendKey(VkControl, false, true, out ignored);
            SendKey(VkMenu, false, true, out ignored);
            SendKey(VkLeftShift, false, true, out ignored);
            SendKey(VkRightShift, false, true, out ignored);
            SendKey(VkLeftControl, false, true, out ignored);
            SendKey(VkRightControl, false, true, out ignored);
            SendKey(VkLeftMenu, false, true, out ignored);
            SendKey(VkRightMenu, false, true, out ignored);
            SendKey(VkLeftWindows, false, true, out ignored);
            SendKey(VkRightWindows, false, true, out ignored);
            SendMouse(0, 0, 0u, MouseLeftUp, out ignored);
            SendMouse(0, 0, 0u, MouseRightUp, out ignored);
            SendMouse(0, 0, 0u, MouseMiddleUp, out ignored);
        }

        private static Dictionary<string, object> Click(Dictionary<string, object> input, Rectangle screen, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            if (!CheckFields(input, new string[] { "type", "x", "y", "button", "count" }, out failure)) return null;
            int x;
            int y;
            if (!TryCoordinate(input, "x", screen.Width, out x, out failure)) return null;
            if (!TryCoordinate(input, "y", screen.Height, out y, out failure)) return null;
            string button = "left";
            object rawButton = AgentJson.Get(input, "button");
            if (rawButton != null && (!AgentJson.TryGetString(rawButton, out button) || (button != "left" && button != "right" && button != "middle")))
            {
                failure = Invalid("input.button must be left, right or middle");
                return null;
            }
            int count = 1;
            object rawCount = AgentJson.Get(input, "count");
            if (rawCount != null && (!AgentJson.TryGetInt(rawCount, out count) || (count != 1 && count != 2)))
            {
                failure = Invalid("input.count must be 1 or 2");
                return null;
            }
            if (!MoveAbsolute(screen, x, y, out failure)) return null;
            uint down = button == "right" ? MouseRightDown : (button == "middle" ? MouseMiddleDown : MouseLeftDown);
            uint up = button == "right" ? MouseRightUp : (button == "middle" ? MouseMiddleUp : MouseLeftUp);
            bool pressed = false;
            try
            {
                for (int i = 0; i < count; i++)
                {
                    if (cancel != null && cancel.Cancelled)
                    {
                        failure = i == 0 ? CancelledBeforeStart() : new AgentFailure("CANCELLED", "click cancelled between presses", "unconfirmed");
                        return null;
                    }
                    if (!SendMouse(0, 0, 0u, down, out failure)) return null;
                    pressed = true;
                    if (!SendMouse(0, 0, 0u, up, out failure)) return null;
                    pressed = false;
                }
                return Applied("click");
            }
            finally
            {
                if (pressed)
                {
                    AgentFailure ignored;
                    SendMouse(0, 0, 0u, up, out ignored);
                }
            }
        }

        private static Dictionary<string, object> Drag(Dictionary<string, object> input, Rectangle screen, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            if (!CheckFields(input, new string[] { "type", "x1", "y1", "x2", "y2", "durationMs" }, out failure)) return null;
            int x1;
            int y1;
            int x2;
            int y2;
            if (!TryCoordinate(input, "x1", screen.Width, out x1, out failure)) return null;
            if (!TryCoordinate(input, "y1", screen.Height, out y1, out failure)) return null;
            if (!TryCoordinate(input, "x2", screen.Width, out x2, out failure)) return null;
            if (!TryCoordinate(input, "y2", screen.Height, out y2, out failure)) return null;
            int durationMs = 300;
            object rawDuration = AgentJson.Get(input, "durationMs");
            if (rawDuration != null && (!AgentJson.TryGetInt(rawDuration, out durationMs) || durationMs < MinDragMs || durationMs > MaxDragMs))
            {
                failure = Invalid("input.durationMs must be " + MinDragMs.ToString(CultureInfo.InvariantCulture) + ".." + MaxDragMs.ToString(CultureInfo.InvariantCulture));
                return null;
            }
            if (!MoveAbsolute(screen, x1, y1, out failure)) return null;
            if (cancel != null && cancel.Cancelled)
            {
                failure = CancelledBeforeStart();
                return null;
            }
            int steps = Math.Max(1, durationMs / DragStepMs);
            int stepDelay = Math.Max(1, durationMs / steps);
            bool pressed = false;
            try
            {
                if (!SendMouse(0, 0, 0u, MouseLeftDown, out failure)) return null;
                pressed = true;
                for (int step = 1; step <= steps; step++)
                {
                    if (cancel != null && cancel.Cancelled)
                    {
                        failure = new AgentFailure("CANCELLED", "drag cancelled after the button went down", "unconfirmed");
                        return null;
                    }
                    int x = x1 + (x2 - x1) * step / steps;
                    int y = y1 + (y2 - y1) * step / steps;
                    if (!MoveAbsolute(screen, x, y, out failure)) return null;
                    Thread.Sleep(stepDelay);
                }
                return Applied("drag");
            }
            finally
            {
                if (pressed)
                {
                    AgentFailure ignored;
                    SendMouse(0, 0, 0u, MouseLeftUp, out ignored);
                }
            }
        }

        private static Dictionary<string, object> Scroll(Dictionary<string, object> input, Rectangle screen, out AgentFailure failure)
        {
            failure = null;
            if (!CheckFields(input, new string[] { "type", "x", "y", "deltaX", "deltaY" }, out failure)) return null;
            int x;
            int y;
            if (!TryCoordinate(input, "x", screen.Width, out x, out failure)) return null;
            if (!TryCoordinate(input, "y", screen.Height, out y, out failure)) return null;
            int deltaX = 0;
            int deltaY = 0;
            object rawDeltaX = AgentJson.Get(input, "deltaX");
            if (rawDeltaX != null && !AgentJson.TryGetInt(rawDeltaX, out deltaX))
            {
                failure = Invalid("input.deltaX must be an integer");
                return null;
            }
            object rawDeltaY = AgentJson.Get(input, "deltaY");
            if (rawDeltaY != null && !AgentJson.TryGetInt(rawDeltaY, out deltaY))
            {
                failure = Invalid("input.deltaY must be an integer");
                return null;
            }
            if (Math.Abs(deltaX) > MaxScrollNotches || Math.Abs(deltaY) > MaxScrollNotches)
            {
                failure = Invalid("input.deltaX/input.deltaY accept -" + MaxScrollNotches.ToString(CultureInfo.InvariantCulture) + ".." + MaxScrollNotches.ToString(CultureInfo.InvariantCulture) + " notches");
                return null;
            }
            if (deltaX == 0 && deltaY == 0)
            {
                failure = Invalid("input.deltaX and input.deltaY cannot both be 0");
                return null;
            }
            if (!MoveAbsolute(screen, x, y, out failure)) return null;
            // deltaY is notch count with positive scrolling down; a positive wheel value scrolls up.
            if (deltaY != 0 && !SendMouse(0, 0, unchecked((uint)(-deltaY * WheelNotch)), MouseWheel, out failure)) return null;
            if (deltaX != 0 && !SendMouse(0, 0, unchecked((uint)(deltaX * WheelNotch)), MouseHWheel, out failure)) return null;
            return Applied("scroll");
        }

        private static Dictionary<string, object> PressKey(Dictionary<string, object> input, out AgentFailure failure)
        {
            failure = null;
            if (!CheckFields(input, new string[] { "type", "key", "modifiers" }, out failure)) return null;
            string name;
            if (!AgentJson.TryGetString(AgentJson.Get(input, "key"), out name) || name.Length == 0)
            {
                failure = Invalid("input.key must be a non-empty string");
                return null;
            }
            ushort virtualKey;
            if (!KeyVirtualList.TryGetValue(name, out virtualKey))
            {
                failure = new AgentFailure("SHOWER_UNSUPPORTED", "unsupported key: " + name);
                return null;
            }
            var modifiers = new List<ushort>();
            object rawModifiers = AgentJson.Get(input, "modifiers");
            if (rawModifiers != null)
            {
                object[] items;
                if (!AgentJson.TryGetArray(rawModifiers, out items))
                {
                    failure = Invalid("input.modifiers must be an array");
                    return null;
                }
                if (items.Length > ModifierOrder.Length)
                {
                    failure = Invalid("input.modifiers accepts at most " + ModifierOrder.Length.ToString(CultureInfo.InvariantCulture) + " names");
                    return null;
                }
                var requested = new List<string>();
                for (int i = 0; i < items.Length; i++)
                {
                    string modifier;
                    if (!AgentJson.TryGetString(items[i], out modifier) || !ModifierVirtualList.ContainsKey(modifier))
                    {
                        failure = Invalid("input.modifiers entries must be CTRL, ALT, SHIFT or META");
                        return null;
                    }
                    if (requested.Contains(modifier))
                    {
                        failure = Invalid("input.modifiers must not repeat " + modifier);
                        return null;
                    }
                    requested.Add(modifier);
                }
                for (int i = 0; i < ModifierOrder.Length; i++)
                {
                    if (requested.Contains(ModifierOrder[i])) modifiers.Add(ModifierVirtualList[ModifierOrder[i]]);
                }
            }
            bool extended = ExtendedKeys.Contains(name);
            int pressed = 0;
            try
            {
                for (int i = 0; i < modifiers.Count; i++)
                {
                    if (!SendKey(modifiers[i], false, false, out failure)) return null;
                    pressed++;
                }
                if (!SendKey(virtualKey, extended, false, out failure)) return null;
                if (!SendKey(virtualKey, extended, true, out failure)) return null;
                return Applied("key");
            }
            finally
            {
                for (int i = pressed - 1; i >= 0; i--)
                {
                    AgentFailure ignored;
                    SendKey(modifiers[i], false, true, out ignored);
                }
            }
        }

        private static Dictionary<string, object> TypeText(Dictionary<string, object> input, AgentOpCancel cancel, out AgentFailure failure)
        {
            failure = null;
            if (!CheckFields(input, new string[] { "type", "text" }, out failure)) return null;
            string text;
            if (!AgentJson.TryGetString(AgentJson.Get(input, "text"), out text))
            {
                failure = Invalid("input.text must be a string");
                return null;
            }
            if (text.Length == 0)
            {
                failure = Invalid("input.text must not be empty");
                return null;
            }
            if (text.Length > MaxTextChars)
            {
                failure = Invalid("input.text accepts at most " + MaxTextChars.ToString(CultureInfo.InvariantCulture) + " characters");
                return null;
            }
            for (int i = 0; i < text.Length; i++)
            {
                if (cancel != null && cancel.Cancelled)
                {
                    failure = i == 0 ? CancelledBeforeStart() : new AgentFailure("CANCELLED", "text cancelled after " + i.ToString(CultureInfo.InvariantCulture) + " characters", "unconfirmed");
                    return null;
                }
                char c = text[i];
                if (c == '\r')
                {
                    if (!TapKey(VkReturn, false, out failure)) return null;
                    if (i + 1 < text.Length && text[i + 1] == '\n') i++;
                }
                else if (c == '\n')
                {
                    if (!TapKey(VkReturn, false, out failure)) return null;
                }
                else if (c == '\t')
                {
                    if (!TapKey(VkTab, false, out failure)) return null;
                }
                else
                {
                    // Unicode input needs no keyboard layout; surrogate pairs arrive as two code units.
                    if (!SendUnicode(c, false, out failure)) return null;
                    if (!SendUnicode(c, true, out failure)) return null;
                }
            }
            return Applied("text");
        }

        private static bool TapKey(ushort virtualKey, bool extended, out AgentFailure failure)
        {
            if (!SendKey(virtualKey, extended, false, out failure)) return false;
            return SendKey(virtualKey, extended, true, out failure);
        }

        private static bool MoveAbsolute(Rectangle screen, int x, int y, out AgentFailure failure)
        {
            int normalizedX = screen.Width <= 1 ? 0 : (int)Math.Round((x - screen.X) * 65535.0 / (screen.Width - 1), MidpointRounding.AwayFromZero);
            int normalizedY = screen.Height <= 1 ? 0 : (int)Math.Round((y - screen.Y) * 65535.0 / (screen.Height - 1), MidpointRounding.AwayFromZero);
            return SendMouse(normalizedX, normalizedY, 0u, MouseMove | MouseAbsolute | MouseVirtualDesk, out failure);
        }

        private static bool SendKey(ushort virtualKey, bool extended, bool up, out AgentFailure failure)
        {
            uint flags = 0;
            if (extended) flags |= KeyExtended;
            if (up) flags |= KeyUp;
            var input = new INPUT();
            input.type = InputKeyboard;
            input.data.ki.wVk = virtualKey;
            input.data.ki.wScan = 0;
            input.data.ki.dwFlags = flags;
            input.data.ki.time = 0;
            input.data.ki.dwExtraInfo = IntPtr.Zero;
            return Send(input, out failure);
        }

        private static bool SendUnicode(char character, bool up, out AgentFailure failure)
        {
            var input = new INPUT();
            input.type = InputKeyboard;
            input.data.ki.wVk = 0;
            input.data.ki.wScan = character;
            input.data.ki.dwFlags = up ? (KeyUnicode | KeyUp) : KeyUnicode;
            input.data.ki.time = 0;
            input.data.ki.dwExtraInfo = IntPtr.Zero;
            return Send(input, out failure);
        }

        private static bool SendMouse(int dx, int dy, uint data, uint flags, out AgentFailure failure)
        {
            var input = new INPUT();
            input.type = InputMouse;
            input.data.mi.dx = dx;
            input.data.mi.dy = dy;
            input.data.mi.mouseData = data;
            input.data.mi.dwFlags = flags;
            input.data.mi.time = 0;
            input.data.mi.dwExtraInfo = IntPtr.Zero;
            return Send(input, out failure);
        }

        private static bool Send(INPUT input, out AgentFailure failure)
        {
            failure = null;
            var inputs = new INPUT[] { input };
            uint sent = SendInput(1u, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent == 1u) return true;
            int error = Marshal.GetLastWin32Error();
            string detail = error == 0 ? "SendInput reported no events" : new Win32Exception(error).Message;
            failure = new AgentFailure("SHOWER_INPUT_FAILED", "input injection failed: " + detail);
            return false;
        }

        private static bool CheckFields(Dictionary<string, object> input, string[] allowed, out AgentFailure failure)
        {
            failure = null;
            string unknown;
            if (!AgentJson.HasUnexpectedField(input, allowed, out unknown))
            {
                return true;
            }
            failure = Invalid("unknown input field: " + unknown);
            return false;
        }

        private static bool TryCoordinate(Dictionary<string, object> input, string name, int size, out int value, out AgentFailure failure)
        {
            value = 0;
            failure = null;
            object raw = AgentJson.Get(input, name);
            if (raw == null || !AgentJson.TryGetInt(raw, out value))
            {
                failure = Invalid("input." + name + " must be an integer");
                return false;
            }
            if (value < 0 || value >= size)
            {
                failure = Invalid("input." + name + " must be within 0.." + (size - 1).ToString(CultureInfo.InvariantCulture));
                return false;
            }
            return true;
        }

        private static Dictionary<string, object> Applied(string type)
        {
            var result = new Dictionary<string, object>();
            result["applied"] = true;
            result["type"] = type;
            return result;
        }

        private static AgentFailure Invalid(string message)
        {
            return new AgentFailure("INVALID_ARGUMENT", message);
        }

        private static AgentFailure CancelledBeforeStart()
        {
            return new AgentFailure("CANCELLED", "operation cancelled before any input was sent", "not-sent");
        }

        private static Dictionary<string, ushort> CreateKeys()
        {
            var keys = new Dictionary<string, ushort>(StringComparer.Ordinal);
            keys["ENTER"] = VkReturn;
            keys["TAB"] = VkTab;
            keys["ESCAPE"] = 0x1B;
            keys["SPACE"] = 0x20;
            keys["BACKSPACE"] = 0x08;
            keys["DELETE"] = 0x2E;
            keys["LEFT"] = 0x25;
            keys["UP"] = 0x26;
            keys["RIGHT"] = 0x27;
            keys["DOWN"] = 0x28;
            keys["HOME"] = 0x24;
            keys["END"] = 0x23;
            keys["PAGEUP"] = 0x21;
            keys["PAGEDOWN"] = 0x22;
            for (char letter = 'A'; letter <= 'Z'; letter++) keys[letter.ToString()] = letter;
            for (char digit = '0'; digit <= '9'; digit++) keys[digit.ToString()] = digit;
            for (int i = 1; i <= 12; i++) keys["F" + i.ToString(CultureInfo.InvariantCulture)] = (ushort)(0x70 + i - 1);
            return keys;
        }

        private static HashSet<string> CreateExtendedKeys()
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            keys.Add("DELETE");
            keys.Add("LEFT");
            keys.Add("UP");
            keys.Add("RIGHT");
            keys.Add("DOWN");
            keys.Add("HOME");
            keys.Add("END");
            keys.Add("PAGEUP");
            keys.Add("PAGEDOWN");
            return keys;
        }

        private static Dictionary<string, ushort> CreateModifiers()
        {
            var modifiers = new Dictionary<string, ushort>(StringComparer.Ordinal);
            modifiers["CTRL"] = VkControl;
            modifiers["ALT"] = VkMenu;
            modifiers["SHIFT"] = VkShift;
            modifiers["META"] = VkLeftWindows;
            return modifiers;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTDATA
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;

            [FieldOffset(0)]
            public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;

            public INPUTDATA data;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    }
}
