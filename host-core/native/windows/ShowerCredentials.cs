using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using MSTSCLib;

namespace ELauncher.Shower
{
    // Passwords stay in this native process and the current user's Windows credential vault.
    internal sealed class ShowerCredentials : IDisposable
    {
        internal const string TargetName = "e-launcher/Shower/localhost";
        private const uint Generic = 1;
        private const int InsufficientBuffer = 122;
        private readonly string account;
        private readonly SecureString password;
        private readonly bool saveAfterLogon;

        private ShowerCredentials(string account, SecureString password, bool saveAfterLogon)
        {
            this.account = account;
            this.password = password;
            this.saveAfterLogon = saveAfterLogon;
        }

        internal static ShowerCredentials Read(string expectedAccount)
        {
            IntPtr pointer;
            if (!CredReadW(TargetName, Generic, 0, out pointer))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 1168) return null;
                throw new Win32Exception(error, "Cannot read the Windows Shower credential");
            }
            Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            try
            {
                if (!string.Equals(value.UserName, expectedAccount, StringComparison.OrdinalIgnoreCase)) return null;
                if (value.CredentialBlobSize == 0 || value.CredentialBlobSize > 2560 || value.CredentialBlobSize % 2 != 0)
                    throw new InvalidOperationException("Invalid Windows Shower credential; remove it in Credential Manager");
                return new ShowerCredentials(expectedAccount, ReadPassword(value.CredentialBlob, (int)value.CredentialBlobSize / 2), false);
            }
            finally
            {
                Zero(value.CredentialBlob, value.CredentialBlobSize);
                CredFree(pointer);
            }
        }

        internal static ShowerCredentials Prompt(IntPtr parent, string expectedAccount, bool rejected)
        {
            uint inputSize = 0;
            CredPackAuthenticationBufferW(0, expectedAccount, "", IntPtr.Zero, ref inputSize);
            if (Marshal.GetLastWin32Error() != InsufficientBuffer) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr input = Marshal.AllocCoTaskMem(checked((int)inputSize));
            IntPtr output = IntPtr.Zero;
            uint outputSize = 0;
            try
            {
                if (!CredPackAuthenticationBufferW(0, expectedAccount, "", input, ref inputSize))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var info = new CredUiInfo
                {
                    Size = Marshal.SizeOf(typeof(CredUiInfo)),
                    Parent = parent,
                    Caption = "Windows 虚拟屏自动登录",
                    Message = "请输入预填 Windows 账户的密码（不是 PIN）。登录验证成功后保存到本机 Windows 凭据管理器，用于以后自动启动虚拟屏。密码不上传中心。"
                };
                uint package = 0;
                bool save = false;
                uint result = CredUIPromptForWindowsCredentialsW(ref info, rejected ? 1326u : 0u, ref package,
                    input, inputSize, out output, out outputSize, ref save, 1);
                if (result == 1223) throw new HostFault(HostErrorCodes.Cancelled, "Windows credential setup was cancelled");
                if (result != 0) throw new Win32Exception((int)result, "Cannot open Windows credential setup");
                return Unpack(output, outputSize, expectedAccount);
            }
            finally
            {
                Free(input, inputSize);
                Free(output, outputSize);
            }
        }

        private static ShowerCredentials Unpack(IntPtr buffer, uint size, string expectedAccount)
        {
            uint userChars = 0, domainChars = 0, passwordChars = 0;
            CredUnPackAuthenticationBufferW(0, buffer, size, IntPtr.Zero, ref userChars,
                IntPtr.Zero, ref domainChars, IntPtr.Zero, ref passwordChars);
            if (Marshal.GetLastWin32Error() != InsufficientBuffer) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint userBytes = checked(userChars * 2), domainBytes = checked(domainChars * 2), passwordBytes = checked(passwordChars * 2);
            IntPtr user = Marshal.AllocCoTaskMem(checked((int)userBytes));
            IntPtr domain = Marshal.AllocCoTaskMem(checked((int)domainBytes));
            IntPtr secret = Marshal.AllocCoTaskMem(checked((int)passwordBytes));
            try
            {
                if (!CredUnPackAuthenticationBufferW(0, buffer, size, user, ref userChars, domain, ref domainChars, secret, ref passwordChars))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                string name = Marshal.PtrToStringUni(user);
                string realm = domainChars == 0 ? "" : Marshal.PtrToStringUni(domain);
                string fullName = string.IsNullOrEmpty(realm) ? name : realm + "\\" + name;
                if (!string.Equals(fullName, expectedAccount, StringComparison.OrdinalIgnoreCase))
                    throw new HostFault(HostErrorCodes.InvalidArgument, "Use the prefilled current Windows account");
                SecureString password = ReadPassword(secret, checked((int)passwordChars));
                if (password.Length == 0)
                {
                    password.Dispose();
                    throw new HostFault(HostErrorCodes.InvalidArgument, "A Windows account password is required");
                }
                return new ShowerCredentials(expectedAccount, password, true);
            }
            finally
            {
                Free(user, userBytes);
                Free(domain, domainBytes);
                Free(secret, passwordBytes);
            }
        }

        private static SecureString ReadPassword(IntPtr pointer, int chars)
        {
            var value = new SecureString();
            for (int i = 0; i < chars; i++)
            {
                char c = (char)Marshal.ReadInt16(pointer, i * 2);
                if (c == '\0') break;
                value.AppendChar(c);
            }
            value.MakeReadOnly();
            return value;
        }

        internal void Apply(object control)
        {
            IntPtr value = Marshal.SecureStringToBSTR(password);
            try { ((IMsTscNonScriptable)control).ClearTextPassword = Marshal.PtrToStringBSTR(value); }
            finally { Marshal.ZeroFreeBSTR(value); }
        }

        internal void Commit()
        {
            if (!saveAfterLogon) return;
            IntPtr blob = Marshal.SecureStringToCoTaskMemUnicode(password);
            try
            {
                var value = new Credential
                {
                    Type = Generic, TargetName = ShowerCredentials.TargetName, UserName = account,
                    Comment = "e-launcher local Windows virtual desktop",
                    CredentialBlob = blob, CredentialBlobSize = checked((uint)password.Length * 2),
                    Persist = 2
                };
                if (!CredWriteW(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot save the Windows Shower credential");
            }
            finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
        }

        public void Dispose() { password.Dispose(); }

        private static void Zero(IntPtr pointer, uint bytes)
        {
            if (pointer == IntPtr.Zero) return;
            for (int i = 0; i < checked((int)bytes); i++) Marshal.WriteByte(pointer, i, 0);
        }

        private static void Free(IntPtr pointer, uint bytes)
        {
            if (pointer == IntPtr.Zero) return;
            Zero(pointer, bytes);
            Marshal.FreeCoTaskMem(pointer);
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CredUiInfo
        {
            internal int Size;
            internal IntPtr Parent;
            internal string Message;
            internal string Caption;
            internal IntPtr Banner;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Credential
        {
            internal uint Flags, Type;
            internal string TargetName, Comment;
            internal System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            internal uint CredentialBlobSize;
            internal IntPtr CredentialBlob;
            internal uint Persist, AttributeCount;
            internal IntPtr Attributes;
            internal string TargetAlias, UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredWriteW(ref Credential credential, uint flags);
        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr credential);
        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr buffer, ref uint size);
        [DllImport("credui.dll", CharSet = CharSet.Unicode)]
        private static extern uint CredUIPromptForWindowsCredentialsW(ref CredUiInfo info, uint error, ref uint package,
            IntPtr input, uint inputSize, out IntPtr output, out uint outputSize, [MarshalAs(UnmanagedType.Bool)] ref bool save, uint flags);
        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size,
            IntPtr user, ref uint userChars, IntPtr domain, ref uint domainChars, IntPtr password, ref uint passwordChars);
    }
}
