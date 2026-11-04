// host-core/native/windows/InteropGenerator.cs: build-time COM interop generator for
// the Windows Shower native host.
//
// host-core/build-shower-windows.js compiles this file with the in-box Framework64
// csc.exe (C# 5) and runs it once per build. It converts the system mstscax.dll type
// library (MSTSCLib) into MSTSCLib.dll next to the host executable, so no generated
// interop assembly is committed, and no tlbimp/PowerShell/NuGet/SDK is required.
//
// Type libraries the conversion references (stdole and anything else mstscax pulls in)
// are generated the same way from the same source instead of borrowing a Primary
// Interop Assembly from the GAC, so the build stays reproducible from what Windows
// already ships.
//
// usage: InteropGenerator.exe <path to mstscax.dll> <output directory>
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using TYPELIBATTR = System.Runtime.InteropServices.ComTypes.TYPELIBATTR;
using System.Text;

namespace ELauncher.Shower.Build
{
    internal sealed class InteropGenerator : ITypeLibImporterNotifySink
    {
        private const string PrimaryAssemblyFileName = "MSTSCLib.dll";
        // REGKIND_NONE: read the typelib without registering mstscax.dll anywhere.
        private const int RegKindNone = 2;

        private static readonly TypeLibConverter Converter = new TypeLibConverter();

        private readonly string outDir;
        private readonly Dictionary<Guid, Assembly> resolved = new Dictionary<Guid, Assembly>();
        private readonly List<Guid> inProgress = new List<Guid>();

        private InteropGenerator(string outDir)
        {
            this.outDir = outDir;
        }

        public static int Main(string[] args)
        {
            if (args.Length != 2)
            {
                Console.Error.WriteLine("usage: InteropGenerator.exe <mstscax.dll> <output directory>");
                return 2;
            }
            try
            {
                string typeLibPath = Path.GetFullPath(args[0]);
                if (!File.Exists(typeLibPath))
                {
                    Console.Error.WriteLine("interop: type library file not found: " + typeLibPath);
                    return 1;
                }
                string outDir = Path.GetFullPath(args[1]);
                Directory.CreateDirectory(outDir);
                InteropGenerator generator = new InteropGenerator(outDir);
                ITypeLib typeLib = NativeMethods.LoadTypeLib(typeLibPath);
                string assemblyPath = generator.Generate(typeLib, PrimaryAssemblyFileName);
                Console.Error.WriteLine("interop: wrote " + assemblyPath);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("interop: failed: " + error);
                return 1;
            }
        }

        public void ReportEvent(ImporterEventKind eventKind, int eventCode, string eventMsg)
        {
            // Conversion warnings mean a type or member was dropped from the generated
            // interop; surface them in the build log instead of shipping a silent gap.
            Console.Error.WriteLine("interop: " + eventKind + " " + eventCode + ": " + eventMsg);
        }

        public Assembly ResolveRef(object typeLib)
        {
            ITypeLib referenced = typeLib as ITypeLib;
            if (referenced == null)
            {
                throw new InvalidOperationException("interop: a referenced type library is not an ITypeLib");
            }
            Guid libId = GetLibAttribute(referenced).guid;
            Assembly cached;
            if (resolved.TryGetValue(libId, out cached))
            {
                return cached;
            }
            if (inProgress.Contains(libId))
            {
                throw new InvalidOperationException("interop: circular type library reference " + libId);
            }
            inProgress.Add(libId);
            try
            {
                string fileName = SafeFileName(GetLibName(referenced), libId) + ".dll";
                string path = Generate(referenced, fileName);
                // ConvertTypeLibToAssembly returns an in-memory AssemblyBuilder; the host
                // compile and the runtime both need a file on disk, so load the saved one.
                Assembly assembly = Assembly.LoadFrom(path);
                resolved[libId] = assembly;
                return assembly;
            }
            finally
            {
                inProgress.Remove(libId);
            }
        }

        private string Generate(ITypeLib typeLib, string assemblyFileName)
        {
            string assemblyPath = Path.Combine(outDir, assemblyFileName);
            AssemblyBuilder builder = Converter.ConvertTypeLibToAssembly(
                typeLib,
                assemblyPath,
                TypeLibImporterFlags.None,
                this,
                null,
                null,
                Path.GetFileNameWithoutExtension(assemblyFileName),
                null);
            builder.Save(assemblyFileName);
            return assemblyPath;
        }

        private static TYPELIBATTR GetLibAttribute(ITypeLib typeLib)
        {
            IntPtr attributes;
            typeLib.GetLibAttr(out attributes);
            try
            {
                return (TYPELIBATTR)Marshal.PtrToStructure(attributes, typeof(TYPELIBATTR));
            }
            finally
            {
                typeLib.ReleaseTLibAttr(attributes);
            }
        }

        private static string GetLibName(ITypeLib typeLib)
        {
            string name;
            string documentation;
            int helpContext;
            string helpFile;
            typeLib.GetDocumentation(-1, out name, out documentation, out helpContext, out helpFile);
            return name;
        }

        private static string SafeFileName(string name, Guid libId)
        {
            StringBuilder builder = new StringBuilder(name == null ? 0 : name.Length);
            if (name != null)
            {
                foreach (char character in name)
                {
                    builder.Append(
                        (character >= 'a' && character <= 'z')
                        || (character >= 'A' && character <= 'Z')
                        || (character >= '0' && character <= '9')
                        || character == '.' || character == '-' || character == '_'
                            ? character
                            : '_');
                }
            }
            string candidate = builder.ToString().Trim('.');
            return candidate.Length == 0 ? libId.ToString("N") : candidate;
        }

        private static class NativeMethods
        {
            [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
            private static extern void LoadTypeLibEx(
                string fileName,
                int regKind,
                [MarshalAs(UnmanagedType.Interface)] out object typeLib);

            public static ITypeLib LoadTypeLib(string fileName)
            {
                object typeLib;
                LoadTypeLibEx(fileName, RegKindNone, out typeLib);
                ITypeLib typed = typeLib as ITypeLib;
                if (typed == null)
                {
                    throw new InvalidOperationException("interop: mstscax.dll type library is not an ITypeLib");
                }
                return typed;
            }
        }
    }
}
