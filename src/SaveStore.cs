using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace WorldOfKungfuSaveEditor
{
    public static class SaveStore
    {
        public const long MaxSaveBytes = 32L * 1024L * 1024L;
        public const long MaxUncompressedSaveBytes = 64L * 1024L * 1024L;
        public const int MaxMsgPackDepth = 64;

        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            IntPtr hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileExW(string lpExistingFileName, string lpNewFileName, uint dwFlags);

        internal static void AtomicReplaceFile(string pendingPath, string destinationFullPath)
        {
            if (String.IsNullOrEmpty(pendingPath))
            {
                throw new ArgumentNullException("pendingPath");
            }
            if (String.IsNullOrEmpty(destinationFullPath))
            {
                throw new ArgumentNullException("destinationFullPath");
            }

            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
            {
                bool moved = MoveFileExW(
                    pendingPath,
                    destinationFullPath,
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
                if (!moved)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new IOException("원자적 파일 교체에 실패했습니다. Win32 오류: " + error.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
                return;
            }

            if (File.Exists(destinationFullPath))
            {
                File.Replace(pendingPath, destinationFullPath, null);
            }
            else
            {
                File.Move(pendingPath, destinationFullPath);
            }
        }

        public static bool IsSaveExtension(string path)
        {
            try
            {
                if (String.IsNullOrEmpty(path) || HasInvalidColon(path))
                {
                    return false;
                }

                string name = Path.GetFileName(path);
                if (String.IsNullOrEmpty(name))
                {
                    return false;
                }

                if (name.IndexOf(':') >= 0)
                {
                    return false;
                }

                int dot = name.IndexOf('.');
                string stem;
                if (dot >= 0)
                {
                    stem = name.Substring(0, dot);
                }
                else
                {
                    stem = name;
                }
                stem = stem.TrimEnd(' ', '.');

                if (IsReservedDeviceName(stem))
                {
                    return false;
                }

                string ext = Path.GetExtension(name);
                return String.Equals(ext, ".dat", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        public static string Hash(byte[] bytes)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException("bytes");
            }

            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(bytes);
                StringBuilder sb = new StringBuilder(digest.Length * 2);
                for (int i = 0; i < digest.Length; i++)
                {
                    sb.Append(digest[i].ToString("x2"));
                }
                return sb.ToString();
            }
        }

        public static void NoLinks(string path)
        {
            if (String.IsNullOrEmpty(path))
            {
                throw new IOException("경로가 비어 있습니다.");
            }

            string trimmed = path.TrimStart();
            if (trimmed.StartsWith("\\\\", StringComparison.Ordinal) ||
                trimmed.StartsWith("//", StringComparison.Ordinal))
            {
                throw new IOException("UNC 경로는 허용되지 않습니다: " + path);
            }

            string[] rawParts = path.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < rawParts.Length; i++)
            {
                if (String.Equals(rawParts[i], "..", StringComparison.Ordinal))
                {
                    throw new IOException("상위 디렉터리 이동(..) 경로는 허용되지 않습니다: " + path);
                }
            }

            string full;
            try
            {
                full = Path.GetFullPath(path);
            }
            catch (Exception ex)
            {
                throw new IOException("유효하지 않은 경로입니다: " + path, ex);
            }

            int colon = full.IndexOf(':', 2);
            if (colon >= 0)
            {
                throw new IOException("NTFS 대체 데이터 스트림 경로는 허용되지 않습니다: " + path);
            }

            CheckNoReparse(full);

            string current = full;
            while (!String.IsNullOrEmpty(current))
            {
                string parent = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(parent))
                {
                    break;
                }

                if (Directory.Exists(parent))
                {
                    CheckNoReparse(parent);
                }

                if (String.Equals(Path.GetPathRoot(parent), parent, StringComparison.OrdinalIgnoreCase))
                {
                    break;
                }

                current = parent;
            }
        }

        public static byte[] Read(string path)
        {
            NoLinks(path);
            if (!IsSaveExtension(path))
            {
                throw new IOException("세이브 확장자(.dat)만 읽을 수 있습니다: " + path);
            }

            string full = Path.GetFullPath(path);
            using (FileStream stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                VerifyHandle(stream, full);
                if (stream.Length <= 0 || stream.Length > MaxSaveBytes)
                {
                    throw new IOException("세이브 파일 크기가 허용 범위를 벗어났습니다: " + full);
                }

                long len = stream.Length;
                byte[] bytes = new byte[(int)len];
                int read = 0;
                while (read < bytes.Length)
                {
                    int n = stream.Read(bytes, read, bytes.Length - read);
                    if (n <= 0)
                    {
                        throw new IOException("세이브 파일을 끝까지 읽지 못했습니다: " + full);
                    }
                    read += n;
                }
                return bytes;
            }
        }

        public static void WriteNew(string path, byte[] data, Action<Stream, byte[]> writer = null)
        {
            if (path == null)
            {
                throw new ArgumentNullException("path");
            }
            if (data == null)
            {
                throw new ArgumentNullException("data");
            }
            if (data.Length <= 0 || data.Length > MaxSaveBytes)
            {
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            }

            NoLinks(path);
            if (!IsAllowedWritePath(path, true))
            {
                throw new IOException("쓰기 가능한 세이브 확장자(.dat/.bak)가 아닙니다: " + path);
            }

            string full = Path.GetFullPath(path);
            if (IsSaveExtension(full))
            {
                WithSaveLock(full, delegate()
                {
                    NoLinks(full);
                    WriteNewCore(full, data, writer);
                    return null;
                });
            }
            else
            {
                WriteNewCore(full, data, writer);
            }
        }

        private static void WriteNewCore(string full, byte[] data, Action<Stream, byte[]> writer)
        {
            bool created = false;
            try
            {
                using (FileStream stream = new FileStream(full, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    created = true;
                    VerifyHandle(stream, full);

                    if (writer != null)
                    {
                        writer(stream, data);
                        FlushStream(stream);
                    }
                    else
                    {
                        WriteAndVerify(stream, data);
                    }
                }
            }
            catch
            {
                if (created)
                {
                    try
                    {
                        if (File.Exists(full))
                        {
                            File.Delete(full);
                        }
                    }
                    catch
                    {
                    }
                }
                throw;
            }
        }

        private static bool IsTransientLockContention(IOException ex)
        {
            if (ex == null)
            {
                return false;
            }

            int code = Marshal.GetHRForException(ex) & 0xFFFF;
            return code == 5 || code == 32 || code == 33;
        }

        private static FileStream AcquireLockStream(string lockPath, int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (true)
            {
                NoLinks(lockPath);

                try
                {
                    FileStream stream = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose);
                    try
                    {
                        VerifyHandle(stream, lockPath);
                        return stream;
                    }
                    catch
                    {
                        stream.Dispose();
                        throw;
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    if (File.Exists(lockPath))
                    {
                        FileAttributes attributes = File.GetAttributes(lockPath);
                        if ((attributes & (FileAttributes.Directory | FileAttributes.ReadOnly | FileAttributes.ReparsePoint)) != 0)
                        {
                            throw new IOException("잠금 파일에 접근할 수 없습니다: " + lockPath);
                        }
                    }

                    if (sw.ElapsedMilliseconds < timeoutMs)
                    {
                        Thread.Sleep(10);
                        continue;
                    }

                    throw new IOException("잠금 파일을 획득하지 못했습니다: " + lockPath);
                }
                catch (IOException ex)
                {
                    if (IsTransientLockContention(ex) && sw.ElapsedMilliseconds < timeoutMs)
                    {
                        Thread.Sleep(10);
                        continue;
                    }

                    throw new IOException("잠금 파일을 획득하지 못했습니다: " + lockPath, ex);
                }
            }
        }

        private static string WithSaveLock(string targetFullPath, Func<string> action)
        {
            string mutexName = "Local\\WokSaveStore_" + Hash(Encoding.UTF8.GetBytes(targetFullPath.ToUpperInvariant()));
            using (Mutex mutex = new Mutex(false, mutexName))
            {
                bool mutexAcquired = false;
                try
                {
                    try
                    {
                        mutexAcquired = mutex.WaitOne(15000);
                    }
                    catch (AbandonedMutexException)
                    {
                        mutexAcquired = true;
                    }

                    if (!mutexAcquired)
                    {
                        throw new IOException("다른 저장 작업이 진행 중이어서 잠금을 획득하지 못했습니다: " + targetFullPath);
                    }

                    using (FileStream lockStream = AcquireLockStream(targetFullPath + ".lock", 15000))
                    {
                        return action();
                    }
                }
                finally
                {
                    if (mutexAcquired)
                    {
                        try
                        {
                            mutex.ReleaseMutex();
                        }
                        catch
                        {
                        }
                    }
                }
            }
        }

        public static string ReplaceWithBackup(string path, string expectedHash, byte[] data, Action<Stream, byte[]> writer = null)
        {
            if (data == null)
            {
                throw new ArgumentNullException("data");
            }
            if (data.Length <= 0 || data.Length > MaxSaveBytes)
            {
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            }

            NoLinks(path);
            if (!IsSaveExtension(path))
            {
                throw new IOException("세이브 확장자(.dat)만 교체할 수 있습니다: " + path);
            }

            string full = Path.GetFullPath(path);

            return WithSaveLock(full, delegate()
            {
                string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
                string backup = full + ".backup-" + stamp + "-" + Guid.NewGuid().ToString("N") + ".bak";
                string pending = full + ".pending-" + Guid.NewGuid().ToString("N");

                using (FileStream target = new FileStream(full, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                {
                    VerifyHandle(target, full);

                    byte[] before = ReadAllFromStream(target);
                    if (!String.Equals(Hash(before), expectedHash, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new IOException("세이브 파일 해시가 예상 값과 다릅니다: " + full);
                    }

                    NoLinks(backup);
                    WriteNewCore(backup, before, null);

                    using (FileStream backupStream = new FileStream(backup, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        VerifyHandle(backupStream, backup);
                        byte[] backupBytes = ReadAllFromStream(backupStream);
                        if (!String.Equals(Hash(backupBytes), expectedHash, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new IOException("백업 파일 검증에 실패했습니다: " + backup);
                        }
                    }

                    try
                    {
                        using (FileStream pendingStream = new FileStream(pending, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                        {
                            VerifyHandle(pendingStream, pending);
                            if (writer != null)
                            {
                                writer(pendingStream, data);
                                FlushStream(pendingStream);
                            }
                            else
                            {
                                WriteAndVerify(pendingStream, data);
                            }
                        }
                    }
                    catch
                    {
                        try
                        {
                            if (File.Exists(pending))
                            {
                                File.Delete(pending);
                            }
                        }
                        catch
                        {
                        }

                        try
                        {
                            if (File.Exists(backup))
                            {
                                File.Delete(backup);
                            }
                        }
                        catch
                        {
                        }

                        throw;
                    }
                }

                NoLinks(full);

                try
                {
                    AtomicReplaceFile(pending, full);
                }
                catch
                {
                    try
                    {
                        if (File.Exists(pending))
                        {
                            File.Delete(pending);
                        }
                    }
                    catch
                    {
                    }

                    throw;
                }

                using (FileStream replaced = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    VerifyHandle(replaced, full);
                    byte[] after = ReadAllFromStream(replaced);
                    if (!String.Equals(Hash(after), Hash(data), StringComparison.OrdinalIgnoreCase))
                    {
                        throw new IOException("교체된 세이브 파일 검증에 실패했습니다: " + full);
                    }
                }

                return backup;
            });
        }

        public static string CopyWithBackup(
            string source,
            string destination,
            string expectedHash,
            byte[] data,
            Action<Stream, byte[]> writer = null)
        {
            if (data == null)
            {
                throw new ArgumentNullException("data");
            }
            if (data.Length <= 0 || data.Length > MaxSaveBytes)
            {
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            }
            if (!IsSaveExtension(source))
            {
                throw new IOException("원본 세이브 확장자(.dat)가 아닙니다: " + source);
            }
            if (!IsSaveExtension(destination))
            {
                throw new IOException("대상 세이브 확장자(.dat)가 아닙니다: " + destination);
            }

            NoLinks(source);
            NoLinks(destination);

            string sourceFull = Path.GetFullPath(source);
            string destFull = Path.GetFullPath(destination);

            if (String.Equals(sourceFull, destFull, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("원본과 대상 경로가 같습니다: " + destFull);
            }
            if (File.Exists(destFull))
            {
                throw new IOException("대상 파일이 이미 존재합니다: " + destFull);
            }

            byte[] original = Read(sourceFull);
            if (!String.Equals(Hash(original), expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("원본 세이브 해시가 예상 값과 다릅니다: " + sourceFull);
            }

            return WithSaveLock(destFull, delegate()
            {
                if (File.Exists(destFull))
                {
                    throw new IOException("대상 파일이 이미 존재합니다: " + destFull);
                }

                string guid = Guid.NewGuid().ToString("N");
                string backup = destFull + ".original-" + guid + ".bak";
                NoLinks(backup);
                WriteNewCore(backup, original, null);

                string pending = destFull + ".pending-" + guid;
                bool pendingCreated = false;
                try
                {
                    using (FileStream stream = new FileStream(pending, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                    {
                        pendingCreated = true;
                        VerifyHandle(stream, pending);

                        if (writer != null)
                        {
                            writer(stream, data);
                            FlushStream(stream);
                        }
                        else
                        {
                            WriteAndVerify(stream, data);
                        }
                    }

                    if (File.Exists(destFull))
                    {
                        throw new IOException("대상 파일이 이미 존재합니다: " + destFull);
                    }
                    File.Move(pending, destFull);
                    pendingCreated = false;
                    return backup;
                }
                catch (IOException ex)
                {
                    if (pendingCreated)
                    {
                        try
                        {
                            if (File.Exists(pending))
                            {
                                File.Delete(pending);
                            }
                        }
                        catch
                        {
                        }
                    }
                    throw new IOException("복사 저장 실패 (원본 백업 보존됨: " + backup + "): " + ex.Message, ex);
                }
                catch
                {
                    if (pendingCreated)
                    {
                        try
                        {
                            if (File.Exists(pending))
                            {
                                File.Delete(pending);
                            }
                        }
                        catch
                        {
                        }
                    }
                    throw;
                }
            });
        }

        public static void UpdateOrRestore(Stream target, byte[] before, byte[] data, string backup)
        {
            if (target == null)
            {
                throw new ArgumentNullException("target");
            }
            if (before == null)
            {
                throw new ArgumentNullException("before");
            }
            if (data == null)
            {
                throw new ArgumentNullException("data");
            }

            try
            {
                WriteAndVerify(target, data);
            }
            catch (Exception ex)
            {
                try
                {
                    target.Position = 0;
                    target.SetLength(0);
                    target.Write(before, 0, before.Length);
                    FlushStream(target);
                }
                catch (Exception rollbackEx)
                {
                    throw new IOException("세이브 갱신 및 자동 원상복구에 실패했습니다. 백업: " + backup, rollbackEx);
                }

                throw new IOException("세이브 갱신 실패로 원본 바이트를 복원했습니다. 백업: " + backup, ex);
            }
        }

        public static void WriteAndVerify(Stream target, byte[] data)
        {
            if (target == null)
            {
                throw new ArgumentNullException("target");
            }
            if (data == null)
            {
                throw new ArgumentNullException("data");
            }
            if (data.Length <= 0 || data.Length > MaxSaveBytes)
            {
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            }

            target.Position = 0;
            target.SetLength(0);
            target.Write(data, 0, data.Length);
            FlushStream(target);

            if (target.Length != data.Length)
            {
                throw new IOException("세이브 데이터 길이 검증에 실패했습니다.");
            }

            target.Position = 0;
            byte[] check = new byte[data.Length];
            int read = 0;
            while (read < check.Length)
            {
                int n = target.Read(check, read, check.Length - read);
                if (n <= 0)
                {
                    throw new IOException("세이브 데이터 다시 읽기에 실패했습니다.");
                }
                read += n;
            }

            if (!String.Equals(Hash(check), Hash(data), StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("세이브 데이터 해시 검증에 실패했습니다.");
            }
        }

        internal static void VerifyHandle(FileStream stream, string expectedFullPath)
        {
            if (stream == null)
            {
                throw new ArgumentNullException("stream");
            }

            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return;
            }

            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(), out info))
            {
                throw new IOException("파일 핸들 정보를 얻지 못했습니다: " + expectedFullPath);
            }

            if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                throw new IOException("재분석 지점(심볼릭 링크) 파일은 허용되지 않습니다: " + expectedFullPath);
            }
            if (info.nNumberOfLinks > 1)
            {
                throw new IOException("하드 링크된 파일은 허용되지 않습니다: " + expectedFullPath);
            }

            StringBuilder sb = new StringBuilder(512);
            uint len = GetFinalPathNameByHandleW(
                stream.SafeFileHandle.DangerousGetHandle(),
                sb,
                (uint)sb.Capacity,
                0);
            if (len == 0)
            {
                throw new IOException("최종 경로를 얻지 못했습니다: " + expectedFullPath);
            }
            if (len >= sb.Capacity)
            {
                sb = new StringBuilder((int)len + 1);
                len = GetFinalPathNameByHandleW(
                    stream.SafeFileHandle.DangerousGetHandle(),
                    sb,
                    (uint)sb.Capacity,
                    0);
                if (len == 0 || len >= sb.Capacity)
                {
                    throw new IOException("최종 경로를 얻지 못했습니다: " + expectedFullPath);
                }
            }

            string finalPath = sb.ToString();
            if (finalPath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("UNC 최종 경로는 허용되지 않습니다: " + finalPath);
            }
            if (finalPath.StartsWith("\\\\?\\", StringComparison.Ordinal))
            {
                finalPath = finalPath.Substring(4);
            }

            string expected = Path.GetFullPath(expectedFullPath);
            string actual = Path.GetFullPath(finalPath);
            if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("파일 핸들의 최종 경로가 예상 경로와 다릅니다: " + actual);
            }
        }

        private static void CheckNoReparse(string path)
        {
            if (!File.Exists(path) && !Directory.Exists(path))
            {
                return;
            }
            FileAttributes attrs = File.GetAttributes(path);
            if ((attrs & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException("재분석 지점(심볼릭 링크/정션)은 허용되지 않습니다: " + path);
            }
        }

        private static void FlushStream(Stream target)
        {
            FileStream fs = target as FileStream;
            if (fs != null)
            {
                fs.Flush(true);
            }
            else
            {
                target.Flush();
            }
        }

        private static byte[] ReadAllFromStream(Stream stream)
        {
            long pos = stream.Position;
            stream.Position = 0;
            long len = stream.Length;
            if (len <= 0 || len > MaxSaveBytes)
            {
                throw new IOException("파일 크기가 허용 범위를 벗어났습니다.");
            }

            byte[] bytes = new byte[(int)len];
            int read = 0;
            while (read < bytes.Length)
            {
                int n = stream.Read(bytes, read, bytes.Length - read);
                if (n <= 0)
                {
                    throw new IOException("파일을 끝까지 읽지 못했습니다.");
                }
                read += n;
            }

            stream.Position = pos;
            return bytes;
        }

        private static bool HasInvalidColon(string path)
        {
            if (String.IsNullOrEmpty(path))
            {
                return false;
            }

            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] != ':')
                {
                    continue;
                }

                if (i == 1 &&
                    path.Length >= 3 &&
                    ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
                    (path[2] == '\\' || path[2] == '/'))
                {
                    continue;
                }

                return true;
            }

            return false;
        }

        private static bool IsAllowedWritePath(string path, bool allowBackup)
        {
            if (String.IsNullOrEmpty(path) || HasInvalidColon(path))
            {
                return false;
            }

            string name;
            try
            {
                name = Path.GetFileName(path);
            }
            catch
            {
                return false;
            }

            if (String.IsNullOrEmpty(name) || name.IndexOf(':') >= 0)
            {
                return false;
            }

            int dot = name.IndexOf('.');
            string stem = dot >= 0 ? name.Substring(0, dot) : name;
            stem = stem.TrimEnd(' ', '.');
            if (IsReservedDeviceName(stem))
            {
                return false;
            }

            string ext = Path.GetExtension(name);
            if (String.Equals(ext, ".dat", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            if (allowBackup && String.Equals(ext, ".bak", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            return false;
        }

        public static void ValidateSlotSaveBytes(byte[] rawBytes)
        {
            if (rawBytes == null || rawBytes.Length <= 0 || (long)rawBytes.Length > MaxSaveBytes)
            {
                throw new IOException("저장 데이터 크기가 올바르지 않습니다.");
            }

            UTF8Encoding utf8 = new UTF8Encoding(false, true);
            string text;
            try
            {
                text = utf8.GetString(rawBytes);
            }
            catch (Exception)
            {
                throw new IOException("저장 데이터가 올바른 UTF-8 텍스트가 아닙니다.");
            }

            if (text.Length > 0 && text[0] == '\uFEFF')
            {
                text = text.Substring(1);
            }

            int start = 0;
            while (start < text.Length && IsAsciiWhitespace(text[start]))
            {
                start++;
            }

            string prefix = "COMPRESSED:";
            if (text.Length - start < prefix.Length ||
                String.CompareOrdinal(text, start, prefix, 0, prefix.Length) != 0)
            {
                throw new IOException("압축된 저장 데이터 형식이 아닙니다.");
            }

            string b64 = text.Substring(start + prefix.Length).Trim();
            byte[] compressed;
            try
            {
                compressed = Convert.FromBase64String(b64);
            }
            catch (Exception)
            {
                throw new IOException("저장 데이터의 Base64 인코딩이 올바르지 않습니다.");
            }

            byte[] mp;
            using (MemoryStream input = new MemoryStream(compressed, false))
            using (GZipStream gzip = new GZipStream(input, CompressionMode.Decompress))
            using (MemoryStream output = new MemoryStream())
            {
                byte[] chunk = new byte[65536];
                long total = 0L;
                int read;
                while ((read = gzip.Read(chunk, 0, chunk.Length)) > 0)
                {
                    total += (long)read;
                    if (total > MaxUncompressedSaveBytes)
                    {
                        throw new IOException("압축 해제 크기가 64MiB 상한을 초과했습니다.");
                    }
                    output.Write(chunk, 0, read);
                }
                mp = output.ToArray();
            }

            int pos = 0;
            MpNode root = ReadMpNode(mp, ref pos, 0);
            if (pos != mp.Length)
            {
                throw new IOException("MessagePack 데이터 뒤에 알 수 없는 바이트가 남아 있습니다.");
            }

            if (root.Kind != MpKind.Arr)
            {
                throw new IOException("저장 데이터의 루트가 배열이 아닙니다.");
            }

            MpNode[] g = root.Items;
            if (g.Length == 26)
            {
                throw new IOException("환경설정 데이터(configdata.dat)입니다.");
            }
            if (g.Length != 54)
            {
                throw new IOException("슬롯 저장 데이터의 요소 개수가 올바르지 않습니다.");
            }

            if (g[9].Kind != MpKind.Str || String.IsNullOrEmpty(g[9].StrVal))
            {
                throw new IOException("playerid 값이 올바르지 않습니다.");
            }
            RequireNilOrString(g[7], "g[7]");
            if (g[7].Kind == MpKind.Str && !String.IsNullOrEmpty(g[7].StrVal))
            {
                string[] flagSegments = g[7].StrVal.Split('|');
                for (int i = 0; i < flagSegments.Length; i++)
                {
                    string seg = flagSegments[i];
                    if (seg.Length == 0)
                    {
                        continue;
                    }
                    string[] kv = seg.Split('&');
                    if (kv.Length != 2 || String.IsNullOrEmpty(kv[0]) || !IsValidFlagInt64OrUInt64Text(kv[1]))
                    {
                        throw new IOException("g[7] 문자열 플래그 값이 올바르지 않습니다.");
                    }
                }
            }
            RequireNilOrString(g[8], "g[8]");
            RequireNilOrString(g[10], "g[10]");
            RequireNilOrString(g[51], "g[51]");

            RequireNonNegativeInteger(g[14], "g[14]");
            RequireNonNegativeInteger(g[15], "g[15]");
            RequireInteger(g[16], "g[16]");
            RequireInteger(g[24], "g[24]");
            RequireInteger(g[33], "g[33]");
            RequireFiniteFloat32(g[17], "g[17]");

            int[] nilOrArrayIndexes = new int[] { 6, 19, 20, 21, 40, 41, 42 };
            for (int i = 0; i < nilOrArrayIndexes.Length; i++)
            {
                MpNode n = g[nilOrArrayIndexes[i]];
                if (n.Kind != MpKind.Nil && n.Kind != MpKind.Arr)
                {
                    throw new IOException("g[" + nilOrArrayIndexes[i].ToString() + "] 값이 올바르지 않습니다.");
                }
            }

            int[] stringArrayIndexes = new int[] { 20, 21, 40, 41, 42 };
            for (int i = 0; i < stringArrayIndexes.Length; i++)
            {
                MpNode n = g[stringArrayIndexes[i]];
                if (n.Kind == MpKind.Arr)
                {
                    RequireStringArray(n, "g[" + stringArrayIndexes[i].ToString() + "]");
                }
            }

            if (g[6].Kind == MpKind.Arr)
            {
                for (int i = 0; i < g[6].Items.Length; i++)
                {
                    MpNode pair = g[6].Items[i];
                    if (pair.Kind != MpKind.Arr || pair.Items.Length < 2 ||
                        pair.Items[0].Kind != MpKind.Str ||
                        String.IsNullOrEmpty(pair.Items[0].StrVal) ||
                        !IsIntegerNode(pair.Items[1]))
                    {
                        throw new IOException("g[6] 값이 올바르지 않습니다.");
                    }
                }
            }

            if (g[19].Kind == MpKind.Arr)
            {
                for (int i = 0; i < g[19].Items.Length; i++)
                {
                    MpNode pair = g[19].Items[i];
                    if (pair.Kind != MpKind.Arr || pair.Items.Length < 2 ||
                        pair.Items[0].Kind != MpKind.Str ||
                        String.IsNullOrEmpty(pair.Items[0].StrVal))
                    {
                        throw new IOException("g[19] 값이 올바르지 않습니다.");
                    }
                    RequireNonNegativeInteger(pair.Items[1], "g[19][1]");
                }
            }

            if (g[21].Kind == MpKind.Arr)
            {
                if (g[21].Items.Length > 5)
                {
                    throw new IOException("g[21] 배열 길이가 올바르지 않습니다.");
                }
                for (int i = 0; i < g[21].Items.Length; i++)
                {
                    if (g[21].Items[i].Kind == MpKind.Str &&
                        String.Equals(g[21].Items[i].StrVal, g[9].StrVal, StringComparison.Ordinal))
                    {
                        throw new IOException("g[21]에 playerid가 포함되어 있습니다.");
                    }
                }
            }

            if (g[3].Kind != MpKind.Arr || g[3].Items.Length == 0)
            {
                throw new IOException("g[3] 캐릭터 배열이 올바르지 않습니다.");
            }

            for (int ci = 0; ci < g[3].Items.Length; ci++)
            {
                MpNode c = g[3].Items[ci];
                if (c.Kind != MpKind.Arr || c.Items.Length != 29)
                {
                    throw new IOException("캐릭터 데이터의 요소 개수가 올바르지 않습니다.");
                }

                if (c.Items[1].Kind != MpKind.Str || String.IsNullOrEmpty(c.Items[1].StrVal))
                {
                    throw new IOException("캐릭터 c[1] 값이 올바르지 않습니다.");
                }
                RequireFiniteFloat32(c.Items[6], "c[6]");
                RequireFiniteFloat32(c.Items[7], "c[7]");

                int[] cIntIndexes = new int[] { 9, 10, 11, 13, 28 };
                for (int i = 0; i < cIntIndexes.Length; i++)
                {
                    RequireInteger(c.Items[cIntIndexes[i]], "c[" + cIntIndexes[i].ToString() + "]");
                }

                int[] cNilOrStringIndexes = new int[] { 8, 24, 25, 26 };
                for (int i = 0; i < cNilOrStringIndexes.Length; i++)
                {
                    RequireNilOrString(c.Items[cNilOrStringIndexes[i]], "c[" + cNilOrStringIndexes[i].ToString() + "]");
                }

                int[] cNilOrStringArrayIndexes = new int[] { 15, 16, 18, 19, 20, 22 };
                for (int i = 0; i < cNilOrStringArrayIndexes.Length; i++)
                {
                    MpNode n = c.Items[cNilOrStringArrayIndexes[i]];
                    if (n.Kind != MpKind.Nil && n.Kind != MpKind.Arr)
                    {
                        throw new IOException("c[" + cNilOrStringArrayIndexes[i].ToString() + "] 값이 올바르지 않습니다.");
                    }
                    if (n.Kind == MpKind.Arr)
                    {
                        RequireStringArray(n, "c[" + cNilOrStringArrayIndexes[i].ToString() + "]");
                    }
                }

                if (c.Items[15].Kind == MpKind.Arr)
                {
                    for (int i = 0; i < c.Items[15].Items.Length; i++)
                    {
                        string[] parts = c.Items[15].Items[i].StrVal.Split(',');
                        if (parts.Length != 5)
                        {
                            throw new IOException("c[15] 문자열 형식이 올바르지 않습니다.");
                        }
                    }
                }

                if (c.Items[18].Kind == MpKind.Arr)
                {
                    for (int i = 0; i < c.Items[18].Items.Length; i++)
                    {
                        string[] parts = c.Items[18].Items[i].StrVal.Split(',');
                        if (parts.Length > 9)
                        {
                            throw new IOException("c[18] 문자열 형식이 올바르지 않습니다.");
                        }
                    }
                }

                if (c.Items[20].Kind == MpKind.Arr)
                {
                    if (c.Items[20].Items.Length != 3)
                    {
                        throw new IOException("c[20] 배열 길이가 올바르지 않습니다.");
                    }
                    for (int i = 0; i < c.Items[20].Items.Length; i++)
                    {
                        if (String.IsNullOrEmpty(c.Items[20].Items[i].StrVal))
                        {
                            throw new IOException("c[20] 문자열이 비어 있습니다.");
                        }
                    }
                }

                if (c.Items[22].Kind == MpKind.Arr)
                {
                    for (int i = 0; i < c.Items[22].Items.Length; i++)
                    {
                        string s = c.Items[22].Items[i].StrVal;
                        if (s == null || s.Length < 2 || s[1] != '|' || s[0] < '1' || s[0] > '9')
                        {
                            throw new IOException("c[22] 문자열 형식이 올바르지 않습니다.");
                        }
                    }
                }
            }
        }

        private static bool IsAsciiWhitespace(char c)
        {
            return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
        }

        private static void RequireNilOrString(MpNode n, string label)
        {
            if (n.Kind != MpKind.Nil && n.Kind != MpKind.Str)
            {
                throw new IOException(label + " 값이 올바르지 않습니다.");
            }
        }

        private static bool IsValidFlagInt64OrUInt64Text(string s)
        {
            if (String.IsNullOrEmpty(s))
            {
                return false;
            }

            if (s[0] == '-')
            {
                if (s.Length < 2)
                {
                    return false;
                }
                for (int i = 1; i < s.Length; i++)
                {
                    if (s[i] < '0' || s[i] > '9')
                    {
                        return false;
                    }
                }
                long sv;
                return Int64.TryParse(s, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out sv);
            }

            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] < '0' || s[i] > '9')
                {
                    return false;
                }
            }
            ulong uv;
            return UInt64.TryParse(s, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out uv);
        }

        private static bool IsIntegerNode(MpNode n)
        {
            return n.Kind == MpKind.UInt || n.Kind == MpKind.SInt;
        }

        private static void RequireInteger(MpNode n, string label)
        {
            if (!IsIntegerNode(n))
            {
                throw new IOException(label + " 값이 정수가 아닙니다.");
            }
        }

        private static void RequireNonNegativeInteger(MpNode n, string label)
        {
            if (!(n.Kind == MpKind.UInt || (n.Kind == MpKind.SInt && n.SVal >= 0)))
            {
                throw new IOException(label + " 값이 음수가 아닌 정수가 아닙니다.");
            }
        }

        private static void RequireFiniteFloat32(MpNode n, string label)
        {
            if (!((n.Kind == MpKind.F32 || n.Kind == MpKind.F64) &&
                  !Double.IsNaN(n.DVal) && !Double.IsInfinity(n.DVal) &&
                  !Single.IsInfinity((float)n.DVal)))
            {
                throw new IOException(label + " 값이 유한한 실수가 아닙니다.");
            }
        }

        private static void RequireStringArray(MpNode n, string label)
        {
            for (int i = 0; i < n.Items.Length; i++)
            {
                if (n.Items[i].Kind != MpKind.Str)
                {
                    throw new IOException(label + " 배열 요소가 문자열이 아닙니다.");
                }
            }
        }

        private enum MpKind
        {
            Nil,
            Bool,
            UInt,
            SInt,
            F32,
            F64,
            Str,
            Bin,
            Arr,
            Map
        }

        private sealed class MpNode
        {
            public MpKind Kind;
            public ulong UVal;
            public long SVal;
            public double DVal;
            public string StrVal;
            public MpNode[] Items;
        }

        private static MpNode ReadMpNode(byte[] buf, ref int pos, int depth)
        {
            if (depth > MaxMsgPackDepth)
            {
                throw new IOException("MessagePack 중첩 깊이가 상한을 초과했습니다.");
            }
            if (pos >= buf.Length)
            {
                throw new IOException("MessagePack 데이터가 예상보다 짧습니다.");
            }

            byte b = buf[pos++];
            MpNode node = new MpNode();

            if (b <= 0x7f)
            {
                node.Kind = MpKind.UInt;
                node.UVal = (ulong)b;
                return node;
            }
            if (b >= 0xe0)
            {
                node.Kind = MpKind.SInt;
                node.SVal = (sbyte)b;
                return node;
            }
            if (b >= 0x80 && b <= 0x8f)
            {
                uint count = (uint)(b & 0x0f);
                return ReadMpMap(buf, ref pos, depth, count, node);
            }
            if (b >= 0x90 && b <= 0x9f)
            {
                uint count = (uint)(b & 0x0f);
                return ReadMpArray(buf, ref pos, depth, count, node);
            }
            if (b >= 0xa0 && b <= 0xbf)
            {
                int len = b & 0x1f;
                node.Kind = MpKind.Str;
                node.StrVal = ReadMpString(buf, ref pos, len);
                return node;
            }

            switch (b)
            {
                case 0xc0:
                    node.Kind = MpKind.Nil;
                    return node;
                case 0xc2:
                case 0xc3:
                    node.Kind = MpKind.Bool;
                    node.UVal = (b == 0xc3) ? 1UL : 0UL;
                    return node;
                case 0xc4:
                    {
                        int len = (int)ReadUInt8(buf, ref pos);
                        node.Kind = MpKind.Bin;
                        node.Items = ReadMpBin(buf, ref pos, len);
                        return node;
                    }
                case 0xc5:
                    {
                        int len = (int)ReadUInt16(buf, ref pos);
                        node.Kind = MpKind.Bin;
                        node.Items = ReadMpBin(buf, ref pos, len);
                        return node;
                    }
                case 0xc6:
                    {
                        uint len = ReadUInt32(buf, ref pos);
                        if ((ulong)len > (ulong)(buf.Length - pos))
                        {
                            throw new IOException("MessagePack bin 길이가 올바르지 않습니다.");
                        }
                        node.Kind = MpKind.Bin;
                        node.Items = ReadMpBin(buf, ref pos, (int)len);
                        return node;
                    }
                case 0xca:
                    {
                        uint bits = ReadUInt32(buf, ref pos);
                        node.Kind = MpKind.F32;
                        byte[] tmp = BitConverter.GetBytes(bits);
                        node.DVal = (double)BitConverter.ToSingle(tmp, 0);
                        return node;
                    }
                case 0xcb:
                    {
                        ulong bits = ReadUInt64(buf, ref pos);
                        byte[] tmp = BitConverter.GetBytes(bits);
                        node.Kind = MpKind.F64;
                        node.DVal = BitConverter.ToDouble(tmp, 0);
                        return node;
                    }
                case 0xcc:
                    node.Kind = MpKind.UInt;
                    node.UVal = ReadUInt8(buf, ref pos);
                    return node;
                case 0xcd:
                    node.Kind = MpKind.UInt;
                    node.UVal = ReadUInt16(buf, ref pos);
                    return node;
                case 0xce:
                    node.Kind = MpKind.UInt;
                    node.UVal = ReadUInt32(buf, ref pos);
                    return node;
                case 0xcf:
                    node.Kind = MpKind.UInt;
                    node.UVal = ReadUInt64(buf, ref pos);
                    return node;
                case 0xd0:
                    {
                        int v = (sbyte)ReadUInt8(buf, ref pos);
                        node.Kind = MpKind.SInt;
                        node.SVal = v;
                        return node;
                    }
                case 0xd1:
                    {
                        int v = (short)ReadUInt16(buf, ref pos);
                        node.Kind = MpKind.SInt;
                        node.SVal = v;
                        return node;
                    }
                case 0xd2:
                    {
                        int v = (int)ReadUInt32(buf, ref pos);
                        node.Kind = MpKind.SInt;
                        node.SVal = v;
                        return node;
                    }
                case 0xd3:
                    {
                        long v = (long)ReadUInt64(buf, ref pos);
                        node.Kind = MpKind.SInt;
                        node.SVal = v;
                        return node;
                    }
                case 0xd9:
                    {
                        int len = (int)ReadUInt8(buf, ref pos);
                        node.Kind = MpKind.Str;
                        node.StrVal = ReadMpString(buf, ref pos, len);
                        return node;
                    }
                case 0xda:
                    {
                        int len = (int)ReadUInt16(buf, ref pos);
                        node.Kind = MpKind.Str;
                        node.StrVal = ReadMpString(buf, ref pos, len);
                        return node;
                    }
                case 0xdb:
                    {
                        uint len = ReadUInt32(buf, ref pos);
                        if ((ulong)len > (ulong)(buf.Length - pos))
                        {
                            throw new IOException("MessagePack str 길이가 올바르지 않습니다.");
                        }
                        node.Kind = MpKind.Str;
                        node.StrVal = ReadMpString(buf, ref pos, (int)len);
                        return node;
                    }
                case 0xdc:
                    {
                        uint count = (uint)ReadUInt16(buf, ref pos);
                        return ReadMpArray(buf, ref pos, depth, count, node);
                    }
                case 0xdd:
                    {
                        uint count = ReadUInt32(buf, ref pos);
                        return ReadMpArray(buf, ref pos, depth, count, node);
                    }
                case 0xde:
                    {
                        uint count = (uint)ReadUInt16(buf, ref pos);
                        return ReadMpMap(buf, ref pos, depth, count, node);
                    }
                case 0xdf:
                    {
                        uint count = ReadUInt32(buf, ref pos);
                        return ReadMpMap(buf, ref pos, depth, count, node);
                    }
                default:
                    throw new IOException("지원하지 않는 MessagePack 타입입니다.");
            }
        }

        private static MpNode ReadMpArray(byte[] buf, ref int pos, int depth, uint count, MpNode node)
        {
            if ((ulong)count > (ulong)(buf.Length - pos))
            {
                throw new IOException("MessagePack 배열 길이가 올바르지 않습니다.");
            }
            if ((ulong)count > (ulong)Int32.MaxValue)
            {
                throw new IOException("MessagePack 배열 길이가 너무 큽니다.");
            }
            node.Kind = MpKind.Arr;
            node.Items = new MpNode[(int)count];
            for (int i = 0; i < node.Items.Length; i++)
            {
                node.Items[i] = ReadMpNode(buf, ref pos, depth + 1);
            }
            return node;
        }

        private static MpNode ReadMpMap(byte[] buf, ref int pos, int depth, uint count, MpNode node)
        {
            if ((ulong)count > (ulong)((buf.Length - pos) / 2))
            {
                throw new IOException("MessagePack 맵 길이가 올바르지 않습니다.");
            }
            if ((ulong)count > (ulong)(Int32.MaxValue / 2))
            {
                throw new IOException("MessagePack 맵 길이가 너무 큽니다.");
            }
            node.Kind = MpKind.Map;
            node.Items = new MpNode[(int)count * 2];
            for (int i = 0; i < node.Items.Length; i++)
            {
                node.Items[i] = ReadMpNode(buf, ref pos, depth + 1);
            }
            return node;
        }

        private static MpNode[] ReadMpBin(byte[] buf, ref int pos, int len)
        {
            if (len < 0 || len > buf.Length - pos)
            {
                throw new IOException("MessagePack bin 길이가 올바르지 않습니다.");
            }
            pos += len;
            return null;
        }

        private static string ReadMpString(byte[] buf, ref int pos, int len)
        {
            if (len < 0 || len > buf.Length - pos)
            {
                throw new IOException("MessagePack 문자열 길이가 올바르지 않습니다.");
            }
            string s;
            try
            {
                s = new UTF8Encoding(false, true).GetString(buf, pos, len);
            }
            catch (Exception)
            {
                throw new IOException("MessagePack 문자열이 올바른 UTF-8이 아닙니다.");
            }
            pos += len;
            return s;
        }

        private static byte ReadUInt8(byte[] buf, ref int pos)
        {
            if (pos >= buf.Length)
            {
                throw new IOException("MessagePack 데이터가 예상보다 짧습니다.");
            }
            return buf[pos++];
        }

        private static ushort ReadUInt16(byte[] buf, ref int pos)
        {
            if (buf.Length - pos < 2)
            {
                throw new IOException("MessagePack 데이터가 예상보다 짧습니다.");
            }
            ushort v = (ushort)((buf[pos] << 8) | buf[pos + 1]);
            pos += 2;
            return v;
        }

        private static uint ReadUInt32(byte[] buf, ref int pos)
        {
            if (buf.Length - pos < 4)
            {
                throw new IOException("MessagePack 데이터가 예상보다 짧습니다.");
            }
            uint v = ((uint)buf[pos] << 24) | ((uint)buf[pos + 1] << 16) |
                     ((uint)buf[pos + 2] << 8) | (uint)buf[pos + 3];
            pos += 4;
            return v;
        }

        private static ulong ReadUInt64(byte[] buf, ref int pos)
        {
            if (buf.Length - pos < 8)
            {
                throw new IOException("MessagePack 데이터가 예상보다 짧습니다.");
            }
            ulong v = 0UL;
            for (int i = 0; i < 8; i++)
            {
                v = (v << 8) | (ulong)buf[pos + i];
            }
            pos += 8;
            return v;
        }

        private static bool IsReservedDeviceName(string stem)
        {
            if (String.IsNullOrEmpty(stem))
            {
                return false;
            }

            string s = stem.TrimEnd(' ', '.').ToUpperInvariant();
            if (s == "CON" || s == "PRN" || s == "AUX" || s == "NUL")
            {
                return true;
            }

            if (s.Length == 4)
            {
                if (s.StartsWith("COM", StringComparison.Ordinal) &&
                    s[3] >= '1' && s[3] <= '9')
                {
                    return true;
                }
                if (s.StartsWith("LPT", StringComparison.Ordinal) &&
                    s[3] >= '1' && s[3] <= '9')
                {
                    return true;
                }
            }

            return false;
        }
    }
}
