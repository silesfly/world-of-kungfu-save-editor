using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WorldOfKungfuSaveEditor
{
    public static class SaveStoreTests
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

        private sealed class FaultStream : MemoryStream
        {
            private readonly bool persistent;
            private int writes;

            public FaultStream(byte[] initial, bool persistentFault)
                : base()
            {
                base.Write(initial, 0, initial.Length);
                Position = 0;
                persistent = persistentFault;
                writes = 0;
            }

            public override void Write(byte[] buffer, int offset, int count)
            {
                if (persistent || writes == 0)
                {
                    writes++;
                    int n = count > 0 ? 1 : 0;
                    if (n > 0)
                    {
                        base.Write(buffer, offset, n);
                    }
                    throw new IOException("injected write fault");
                }
                writes++;
                base.Write(buffer, offset, count);
            }
        }

        public static int Main(string[] args)
        {
            Assert(args != null && args.Length == 1, "usage: SaveStoreTests <new-fixture-dir>");
            string root = Path.GetFullPath(args[0]);
            Assert(!Directory.Exists(root) && !File.Exists(root), "fixture directory already exists");
            Directory.CreateDirectory(root);
            try
            {
                Case1_ReplacePreservesBackups(root);
                Case2_StaleHash(root);
                Case3_LocksAndReadOnly(root);
                Case4_EmptyAndMissing(root);
                Case5_WriteNewFault(root);
                Case6_InvalidExtensionsAdsReserved(root);
                Case7_HardLinks(root);
                Case8_UpdateRollback();
                Case9_UpdateRollbackFailure();
                Case10_CopyBackupAndPending(root);
                Case11_ReplaceFaultLeavesTargetIntact(root);
                Case12_ConcurrentReplaceRace(root);
                Case13_ExternalLockFileContention(root);
                Case14_WriteNewLockContentionAndRace(root);
                Case15_ValidateSlotSaveBytesAndBounds();
                Console.WriteLine("ALL PASS");
                return 0;
            }
            finally
            {
                try
                {
                    if (Directory.Exists(root))
                    {
                        Directory.Delete(root, true);
                    }
                }
                catch
                {
                }
            }
        }

        private static void Assert(bool ok, string why)
        {
            if (!ok)
            {
                throw new Exception("ASSERT: " + why);
            }
            Console.WriteLine("PASS " + why);
        }

        private static void Reject(Action action, string why)
        {
            try
            {
                action();
            }
            catch (IOException)
            {
                Console.WriteLine("PASS " + why);
                return;
            }
            catch (UnauthorizedAccessException)
            {
                Console.WriteLine("PASS " + why);
                return;
            }
            throw new Exception("EXPECTED REJECTION: " + why);
        }

        private static byte[] B(params byte[] values)
        {
            return values;
        }

        private static string P(string root, string name)
        {
            return Path.Combine(root, name);
        }

        private static string[] Files(string root)
        {
            return Directory.GetFiles(root, "*", SearchOption.AllDirectories);
        }

        private static bool HasPattern(string[] files, string part)
        {
            for (int i = 0; i < files.Length; i++)
            {
                if (files[i].IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        private static void Case1_ReplacePreservesBackups(string root)
        {
            string target = P(root, "case1.dat");
            byte[] a = B(1, 2, 3, 4);
            byte[] b = B(9, 8, 7);
            byte[] c = B(5, 6);
            SaveStore.WriteNew(target, a);
            string first = SaveStore.ReplaceWithBackup(target, SaveStore.Hash(a), b);
            string second = SaveStore.ReplaceWithBackup(target, SaveStore.Hash(b), c);
            Assert(File.Exists(first) && File.Exists(second), "both backup files exist");
            Assert(File.ReadAllBytes(first).Length == a.Length, "first backup length");
            Assert(File.ReadAllBytes(second).Length == b.Length, "second backup length");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(c), "target updated");
            string before = SaveStore.Hash(File.ReadAllBytes(first));
            Reject(delegate { SaveStore.WriteNew(first, B(99, 100)); }, "WriteNew must reject existing backup path");
            Assert(File.Exists(first) && SaveStore.Hash(File.ReadAllBytes(first)) == before, "first backup preserved");
        }

        private static void Case2_StaleHash(string root)
        {
            string target = P(root, "case2.dat");
            byte[] original = B(10, 20, 30);
            SaveStore.WriteNew(target, original);
            string[] before = Files(root);
            Reject(delegate { SaveStore.ReplaceWithBackup(target, SaveStore.Hash(B(1, 2)), B(4, 5)); }, "stale expected hash");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(original), "target unchanged");
            string[] after = Files(root);
            Assert(before.Length == after.Length, "no .bak created");
        }

        private static void Case3_LocksAndReadOnly(string root)
        {
            string target = P(root, "case3.dat");
            byte[] original = B(11, 12, 13);
            SaveStore.WriteNew(target, original);
            using (FileStream fs = new FileStream(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                Reject(delegate { SaveStore.Read(target); }, "Read open lock");
                Reject(delegate { SaveStore.ReplaceWithBackup(target, SaveStore.Hash(original), B(1)); }, "Replace open lock");
                GC.KeepAlive(fs);
            }
            File.SetAttributes(target, FileAttributes.ReadOnly);
            try
            {
                Reject(delegate { SaveStore.ReplaceWithBackup(target, SaveStore.Hash(original), B(2)); }, "ReadOnly replace");
                Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(original), "ReadOnly bytes intact");
            }
            finally
            {
                File.SetAttributes(target, FileAttributes.Normal);
            }
        }

        private static void Case4_EmptyAndMissing(string root)
        {
            string target = P(root, "case4.dat");
            Reject(delegate { SaveStore.WriteNew(target, new byte[0]); }, "empty payload");
            Assert(!File.Exists(target), "empty payload no file");
            Reject(delegate { SaveStore.ReplaceWithBackup(P(root, "missing.dat"), SaveStore.Hash(B(1)), B(2)); }, "missing target replace");
            Reject(delegate { SaveStore.Read(P(root, "missing.dat")); }, "missing read");
        }

        private static void Case5_WriteNewFault(string root)
        {
            string a = P(root, "fault.dat");
            string b = P(root, "fault.bak");
            Action<Stream, byte[]> writer = delegate(Stream s, byte[] data)
            {
                s.Write(data, 0, 4);
                throw new IOException("fault");
            };
            Reject(delegate { SaveStore.WriteNew(a, B(1, 2, 3, 4, 5), writer); }, "fault.dat injection");
            Assert(!File.Exists(a), "fault.dat cleanup");
            Reject(delegate { SaveStore.WriteNew(b, B(1, 2, 3, 4, 5), writer); }, "fault.bak injection");
            Assert(!File.Exists(b), "fault.bak cleanup");
        }

        private static void Case6_InvalidExtensionsAdsReserved(string root)
        {
            string[] invalid = { "bad.txt", "bad.exe", "bigbang1data.dat:evil.dat", "CON.dat", "NUL.dat", "COM1.dat" };
            for (int i = 0; i < invalid.Length; i++)
            {
                string name = invalid[i];
                Assert(!SaveStore.IsSaveExtension(name), "invalid extension: " + name);
                string target = Path.Combine(root, name);
                Reject(delegate { SaveStore.WriteNew(target, B(1, 2)); }, "WriteNew invalid: " + name);
                Reject(delegate { SaveStore.CopyWithBackup(P(root, "case6.dat"), target, "", B(2, 3)); }, "Copy invalid: " + name);
            }
        }

        private static void Case7_HardLinks(string root)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return;
            }
            string target = P(root, "case7.dat");
            string link = P(root, "case7_link.dat");
            byte[] original = B(21, 22, 23);
            SaveStore.WriteNew(target, original);
            Assert(CreateHardLink(link, target, IntPtr.Zero), "CreateHardLink created");
            try
            {
                Reject(delegate { SaveStore.Read(link); }, "Read hardlink");
                Reject(delegate { SaveStore.ReplaceWithBackup(link, SaveStore.Hash(original), B(1)); }, "Replace hardlink");
            }
            finally
            {
                File.Delete(link);
            }
            Assert(SaveStore.Hash(SaveStore.Read(target)) == SaveStore.Hash(original), "target unchanged after link delete");
        }

        private static void Case8_UpdateRollback()
        {
            byte[] before = B(1, 2, 3, 4, 5);
            byte[] data = B(9, 8, 7, 6, 5, 4);
            using (FaultStream stream = new FaultStream(before, false))
            {
                try
                {
                    SaveStore.UpdateOrRestore(stream, before, data, "backup-8.bak");
                    Assert(false, "UpdateOrRestore should throw");
                }
                catch (IOException ex)
                {
                    Assert(ex.Message.IndexOf("backup-8.bak", StringComparison.Ordinal) >= 0, "rollback message backup");
                }
                byte[] actual = stream.ToArray();
                Assert(actual.Length == before.Length, "rollback length");
                for (int i = 0; i < before.Length; i++)
                {
                    Assert(actual[i] == before[i], "rollback byte " + i);
                }
            }
        }

        private static void Case9_UpdateRollbackFailure()
        {
            byte[] before = B(31, 32, 33);
            byte[] data = B(41, 42, 43, 44);
            using (FaultStream stream = new FaultStream(before, true))
            {
                try
                {
                    SaveStore.UpdateOrRestore(stream, before, data, "backup-9.bak");
                    Assert(false, "UpdateOrRestore should throw");
                }
                catch (IOException ex)
                {
                    Assert(ex.Message.IndexOf("자동 원상복구에 실패", StringComparison.Ordinal) >= 0, "rollback failure text");
                    Assert(ex.Message.IndexOf("backup-9.bak", StringComparison.Ordinal) >= 0, "rollback failure backup");
                }
            }
        }

        private static void Case10_CopyBackupAndPending(string root)
        {
            string source = P(root, "case10_src.dat");
            string destination = P(root, "case10_dst.dat");
            byte[] sourceBytes = B(51, 52, 53);
            byte[] newBytes = B(61, 62, 63, 64);
            SaveStore.WriteNew(source, sourceBytes);
            string backup = SaveStore.CopyWithBackup(source, destination, SaveStore.Hash(sourceBytes), newBytes);
            Assert(File.Exists(destination), "destination created");
            Assert(File.Exists(backup), "original backup created");
            Assert(SaveStore.Hash(File.ReadAllBytes(destination)) == SaveStore.Hash(newBytes), "destination bytes");
            Assert(SaveStore.Hash(File.ReadAllBytes(backup)) == SaveStore.Hash(sourceBytes), "backup bytes");
            Reject(delegate { SaveStore.CopyWithBackup(source, destination, SaveStore.Hash(sourceBytes), B(7)); }, "duplicate destination");
            Reject(delegate { SaveStore.CopyWithBackup(source, source, SaveStore.Hash(sourceBytes), B(8)); }, "same source/dest");
            string retryDest = P(root, "case10_retry.dat");
            Action<Stream, byte[]> fault = delegate(Stream s, byte[] d)
            {
                s.Write(d, 0, 1);
                throw new IOException("copy fault");
            };
            try
            {
                SaveStore.CopyWithBackup(source, retryDest, SaveStore.Hash(sourceBytes), B(71, 72, 73), fault);
                Assert(false, "fault copy should throw");
            }
            catch (IOException ex)
            {
                Assert(ex.Message.IndexOf(".original-", StringComparison.OrdinalIgnoreCase) >= 0, "fault message backup");
            }
            Assert(!File.Exists(retryDest), "failed copy leaves no destination");
            string[] files = Files(root);
            Assert(!HasPattern(files, ".pending-"), "pending files cleaned");
            string retry = SaveStore.CopyWithBackup(source, retryDest, SaveStore.Hash(sourceBytes), B(81, 82));
            Assert(File.Exists(retryDest) && File.Exists(retry), "retry succeeds");
            Assert(SaveStore.Hash(File.ReadAllBytes(retryDest)) == SaveStore.Hash(B(81, 82)), "retry bytes");
        }

        private static void Case11_ReplaceFaultLeavesTargetIntact(string root)
        {
            string dir = Path.Combine(root, "case11");
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
            Directory.CreateDirectory(dir);

            string target = P(dir, "slot.dat");
            byte[] original = B(91, 92, 93, 94);
            byte[] replacement = B(95, 96, 97, 98);
            File.WriteAllBytes(target, original);

            string originalHash = SaveStore.Hash(original);
            bool failed = false;
            try
            {
                SaveStore.ReplaceWithBackup(
                    target,
                    originalHash,
                    replacement,
                    delegate(Stream stream, byte[] bytes)
                    {
                        stream.WriteByte(bytes[0]);
                        stream.Flush();
                        throw new IOException("fault injection");
                    });
            }
            catch (IOException)
            {
                failed = true;
            }

            Assert(failed, "case11 fault injection throws");
            Assert(HasPattern(Directory.GetFiles(dir, "*.dat"), "slot.dat"), "case11 target still exists");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == originalHash, "case11 target bytes preserved");
            Assert(!HasPattern(Files(dir), ".pending-"), "case11 no pending files");
            Assert(!HasPattern(Files(dir), ".backup-"), "case11 no orphan backup files");

            string backup = SaveStore.ReplaceWithBackup(target, originalHash, replacement);
            Assert(File.Exists(backup), "case11 retry backup exists");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(replacement), "case11 retry succeeds");
            Assert(SaveStore.Hash(File.ReadAllBytes(backup)) == originalHash, "case11 retry backup bytes");
        }

        private static void Case12_ConcurrentReplaceRace(string root)
        {
            string dir = Path.Combine(root, "case12");
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
            Directory.CreateDirectory(dir);
            string target = Path.Combine(dir, "slot.dat");
            byte[] original = B(11, 22, 33, 44);
            string originalHash = SaveStore.Hash(original);
            File.WriteAllBytes(target, original);

            byte[] dataA = B(101, 102, 103, 104, 105);
            byte[] dataB = B(201, 202, 203, 204, 205);

            ManualResetEvent startGate = new ManualResetEvent(false);
            int ready = 0;
            int successCount = 0;
            int ioFailCount = 0;
            Exception unexpected = null;
            string winningBackup = null;
            byte[] winningBytes = null;
            object sync = new object();

            Thread t1 = new Thread(delegate()
            {
                Interlocked.Increment(ref ready);
                try
                {
                    if (!startGate.WaitOne(5000))
                    {
                        throw new IOException("start gate timeout");
                    }

                    string backup = SaveStore.ReplaceWithBackup(target, originalHash, dataA, delegate(Stream stream, byte[] bytes)
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush();
                        Thread.Sleep(40);
                    });

                    lock (sync)
                    {
                        successCount++;
                        winningBackup = backup;
                        winningBytes = dataA;
                    }
                }
                catch (IOException)
                {
                    lock (sync)
                    {
                        ioFailCount++;
                    }
                }
                catch (Exception ex)
                {
                    lock (sync)
                    {
                        unexpected = ex;
                    }
                }
            });

            Thread t2 = new Thread(delegate()
            {
                Interlocked.Increment(ref ready);
                try
                {
                    if (!startGate.WaitOne(5000))
                    {
                        throw new IOException("start gate timeout");
                    }

                    string backup = SaveStore.ReplaceWithBackup(target, originalHash, dataB, delegate(Stream stream, byte[] bytes)
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush();
                        Thread.Sleep(40);
                    });

                    lock (sync)
                    {
                        successCount++;
                        winningBackup = backup;
                        winningBytes = dataB;
                    }
                }
                catch (IOException)
                {
                    lock (sync)
                    {
                        ioFailCount++;
                    }
                }
                catch (Exception ex)
                {
                    lock (sync)
                    {
                        unexpected = ex;
                    }
                }
            });

            t1.Start();
            t2.Start();

            while (Volatile.Read(ref ready) < 2)
            {
                Thread.Sleep(5);
            }

            startGate.Set();
            t1.Join();
            t2.Join();
            startGate.Close();

            Assert(unexpected == null, "case12 no unexpected exception");
            Assert(successCount == 1, "case12 exactly one success");
            Assert(ioFailCount == 1, "case12 exactly one io failure");
            Assert(winningBackup != null && File.Exists(winningBackup), "case12 winning backup exists");
            Assert(SaveStore.Hash(File.ReadAllBytes(winningBackup)) == originalHash, "case12 winning backup bytes");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(winningBytes), "case12 target matches winner");
            Assert(!HasPattern(Files(dir), ".pending-"), "case12 no pending files");
            Assert(!HasPattern(Files(dir), ".lock"), "case12 no lock files");
        }

        private static void Case13_ExternalLockFileContention(string root)
        {
            string dir = Path.Combine(root, "case13");
            Directory.CreateDirectory(dir);
            string target = Path.Combine(dir, "slot.dat");
            string lockPath = target + ".lock";

            byte[] original = B(1, 2, 3, 4);
            byte[] pythonBytes = B(9, 8, 7, 6);
            byte[] csharpBytes = B(5, 4, 3, 2);
            string originalHash = SaveStore.Hash(original);
            File.WriteAllBytes(target, original);

            Exception partAError = null;
            string partABackup = null;
            long partAElapsed = 0;
            FileStream heldLock = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose);
            Thread worker = new Thread(delegate()
            {
                Stopwatch sw = Stopwatch.StartNew();
                try
                {
                    partABackup = SaveStore.ReplaceWithBackup(target, originalHash, csharpBytes);
                }
                catch (Exception ex)
                {
                    partAError = ex;
                }
                finally
                {
                    sw.Stop();
                    partAElapsed = sw.ElapsedMilliseconds;
                }
            });
            worker.Start();
            Thread.Sleep(160);
            File.WriteAllBytes(target, pythonBytes);
            heldLock.Dispose();
            worker.Join();

            Assert(partAElapsed >= 60, "case13 part A worker waited for external lock");
            Assert(partAError is IOException, "case13 part A stale hash throws IOException after lock release");
            Assert(partABackup == null, "case13 part A no backup returned on stale hash");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(pythonBytes), "case13 part A python bytes preserved");
            Assert(!HasPattern(Files(dir), ".pending-"), "case13 part A no pending files");
            Assert(!HasPattern(Files(dir), ".backup-"), "case13 part A no backup files");
            Assert(!HasPattern(Files(dir), ".lock"), "case13 part A no lock files");

            Exception partBError = null;
            string partBBackup = null;
            long partBElapsed = 0;
            ManualResetEvent holderReady = new ManualResetEvent(false);
            try
            {
                Thread holder = new Thread(delegate()
                {
                    using (FileStream stream = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose))
                    {
                        holderReady.Set();
                        Thread.Sleep(160);
                    }
                });
                holder.Start();
                Assert(holderReady.WaitOne(5000), "case13 part B holder acquired lock");
                Thread updater = new Thread(delegate()
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    try
                    {
                        partBBackup = SaveStore.ReplaceWithBackup(target, SaveStore.Hash(pythonBytes), csharpBytes);
                    }
                    catch (Exception ex)
                    {
                        partBError = ex;
                    }
                    finally
                    {
                        sw.Stop();
                        partBElapsed = sw.ElapsedMilliseconds;
                    }
                });
                updater.Start();
                holder.Join();
                updater.Join();
            }
            finally
            {
                holderReady.Close();
            }

            Assert(partBError == null, "case13 part B no error");
            Assert(partBElapsed >= 60, "case13 part B waited for external lock release");
            Assert(partBBackup != null && File.Exists(partBBackup), "case13 part B backup exists");
            Assert(SaveStore.Hash(File.ReadAllBytes(partBBackup)) == SaveStore.Hash(pythonBytes), "case13 part B backup bytes");
            Assert(SaveStore.Hash(File.ReadAllBytes(target)) == SaveStore.Hash(csharpBytes), "case13 part B target updated");
            Assert(!HasPattern(Files(dir), ".lock"), "case13 part B no lock files");
            Assert(!HasPattern(Files(dir), ".pending-"), "case13 part B no pending files");
        }

        private static void Case14_WriteNewLockContentionAndRace(string root)
        {
            string dir = Path.Combine(root, "case14");
            Directory.CreateDirectory(dir);

            string targetA = Path.Combine(dir, "slot.dat");
            string lockPathA = targetA + ".lock";
            byte[] pythonBytes = B(9, 8, 7, 6);
            byte[] csharpBytes = B(5, 4, 3, 2);
            Exception partAError = null;
            long partAElapsed = 0;
            FileStream heldLock = null;
            try
            {
                heldLock = new FileStream(lockPathA, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose);
                Thread worker = new Thread(delegate()
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    try
                    {
                        SaveStore.WriteNew(targetA, csharpBytes);
                    }
                    catch (Exception ex)
                    {
                        partAError = ex;
                    }
                    finally
                    {
                        sw.Stop();
                        partAElapsed = sw.ElapsedMilliseconds;
                    }
                });
                worker.Start();
                Thread.Sleep(160);
                Assert(!File.Exists(targetA), "case14 part A WriteNew blocked while external lock held");
                File.WriteAllBytes(targetA, pythonBytes);
                heldLock.Dispose();
                heldLock = null;
                worker.Join();
            }
            finally
            {
                if (heldLock != null)
                {
                    heldLock.Dispose();
                }
            }
            Assert(partAElapsed >= 60, "case14 part A WriteNew waited for lock");
            Assert(partAError is IOException, "case14 part A WriteNew lock timeout");
            Assert(SaveStore.Hash(File.ReadAllBytes(targetA)) == SaveStore.Hash(pythonBytes), "case14 part A target remains external bytes");
            Assert(!HasPattern(Files(dir), ".lock"), "case14 part A no lock files");
            Assert(!HasPattern(Files(dir), ".pending-"), "case14 part A no pending files");

            string targetB = Path.Combine(dir, "slot2.dat");
            ManualResetEvent startGate = new ManualResetEvent(false);
            int ready = 0;
            object sync = new object();
            int successCount = 0;
            int ioFailCount = 0;
            Exception unexpected = null;
            byte[] winningBytes = null;

            Thread thread1 = new Thread(delegate()
            {
                lock (sync)
                {
                    ready++;
                }
                startGate.WaitOne(5000);
                byte[] threadBytes = B(11, 22, 33, 44);
                try
                {
                    SaveStore.WriteNew(targetB, threadBytes, delegate(Stream stream, byte[] bytes)
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush();
                        Thread.Sleep(40);
                    });
                    lock (sync)
                    {
                        successCount++;
                        winningBytes = threadBytes;
                    }
                }
                catch (IOException)
                {
                    lock (sync)
                    {
                        ioFailCount++;
                    }
                }
                catch (Exception ex)
                {
                    lock (sync)
                    {
                        unexpected = ex;
                    }
                }
            });
            Thread thread2 = new Thread(delegate()
            {
                lock (sync)
                {
                    ready++;
                }
                startGate.WaitOne(5000);
                byte[] threadBytes = B(55, 66, 77, 88);
                try
                {
                    SaveStore.WriteNew(targetB, threadBytes, delegate(Stream stream, byte[] bytes)
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush();
                        Thread.Sleep(40);
                    });
                    lock (sync)
                    {
                        successCount++;
                        winningBytes = threadBytes;
                    }
                }
                catch (IOException)
                {
                    lock (sync)
                    {
                        ioFailCount++;
                    }
                }
                catch (Exception ex)
                {
                    lock (sync)
                    {
                        unexpected = ex;
                    }
                }
            });

            thread1.Start();
            thread2.Start();
            while (true)
            {
                lock (sync)
                {
                    if (ready >= 2)
                    {
                        break;
                    }
                }
                Thread.Sleep(1);
            }
            startGate.Set();
            thread1.Join();
            thread2.Join();
            startGate.Dispose();

            Assert(unexpected == null, "case14 part B no unexpected exceptions");
            Assert(successCount == 1, "case14 part B one WriteNew succeeded");
            Assert(ioFailCount == 1, "case14 part B one WriteNew failed with IOException");
            Assert(winningBytes != null, "case14 part B winning bytes recorded");
            Assert(SaveStore.Hash(File.ReadAllBytes(targetB)) == SaveStore.Hash(winningBytes), "case14 part B target matches winner");
            Assert(!HasPattern(Files(dir), ".lock"), "case14 part B no lock files");

            string bakPath = Path.Combine(dir, "manual.bak");
            SaveStore.WriteNew(bakPath, pythonBytes);
            Assert(SaveStore.Hash(File.ReadAllBytes(bakPath)) == SaveStore.Hash(pythonBytes), "case14 part C bak bytes");
            Assert(!HasPattern(Files(dir), ".lock"), "case14 part C no lock files");
        }

        private static void Case15_ValidateSlotSaveBytesAndBounds()
        {
            SaveStore.ValidateSlotSaveBytes(BuildMinimalSlotDat());
            SaveStore.ValidateSlotSaveBytes(BuildSlotDatWithG4Raw(new byte[] { 0xc4, 0x02, 0xde, 0xad }));
            Assert(true, "case15 g4 bin8 accepted");

            Reject("case15 g4 fixext1", BuildSlotDatWithG4Raw(new byte[] { 0xd4, 0x01, 0x2a }));
            Reject("case15 g4 ext8", BuildSlotDatWithG4Raw(new byte[] { 0xc7, 0x01, 0x01, 0x2a }));
            Reject("case15 26-field config", BuildMinimalSlotDat(26, "1001,1,0,0,False", "1|101", "", "10001", 100, 1.0f));
            Reject("case15 kungfu 4 fields", BuildMinimalSlotDat(54, "1001,1,0,0", "1|101", "", "10001", 100, 1.0f));
            Reject("case15 equip trait 0|101", BuildMinimalSlotDat(54, "1001,1,0,0,False", "0|101", "", "10001", 100, 1.0f));
            Reject("case15 equip trait 10|101", BuildMinimalSlotDat(54, "1001,1,0,0,False", "10|101", "", "10001", 100, 1.0f));
            Reject("case15 follow list playerid", BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "9001", "10001", 100, 1.0f));
            Reject("case15 empty item id", BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "", 100, 1.0f));
            Reject("case15 negative money", BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "10001", -1, 1.0f));
            Reject("case15 nan g17", BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "10001", 100, Single.NaN));
            Reject("case15 gzip bomb", BuildGZipBomb(65 * 1024 * 1024));
            Reject("case15 depth 66", BuildDepth66Dat());
            Reject(delegate { SaveStore.NoLinks("C:\\Saves\\..\\Saves\\bigbang1data.dat"); }, "case15 dotdot win backslash");
            Reject(delegate { SaveStore.NoLinks("C:/Saves/../Saves/bigbang1data.dat"); }, "case15 dotdot forward slash");
            SaveStore.ValidateSlotSaveBytes(BuildSlotDatWithFlags("flag_k", "str_k&18446744073709551615|-min&-9223372036854775808"));
            Reject("case15 empty int flag key", BuildSlotDatWithFlags("", "str_k&1"));
            Reject("case15 empty str flag key", BuildSlotDatWithFlags("flag_k", "&1"));
            Reject("case15 str flag > MAX_U64", BuildSlotDatWithFlags("flag_k", "str_k&18446744073709551616"));
            Reject("case15 str flag < MIN_I64", BuildSlotDatWithFlags("flag_k", "str_k&-9223372036854775809"));
            Reject("case15 str flag non-int", BuildSlotDatWithFlags("flag_k", "str_k&abc"));
            SaveStore.ValidateSlotSaveBytes(BuildSlotDatWithFlags("flag_k", "str_k&" + new string('0', 4301) + "1|-z&-" + new string('0', 4301) + "1|-zero&-" + new string('0', 4301) + "|u&" + new string('0', 4301) + "18446744073709551615|m&-" + new string('0', 4301) + "9223372036854775808"));
            Reject("case15 str flag 4301 nines", BuildSlotDatWithFlags("flag_k", "str_k&" + new string('9', 4301)));
            Reject("case15 str flag -4301 nines", BuildSlotDatWithFlags("flag_k", "str_k&-" + new string('9', 4301)));
            Reject("case15 str flag leading0 > MAX_U64", BuildSlotDatWithFlags("flag_k", "str_k&" + new string('0', 4301) + "18446744073709551616"));
            Reject("case15 str flag leading0 < MIN_I64", BuildSlotDatWithFlags("flag_k", "str_k&-" + new string('0', 4301) + "9223372036854775809"));
            Reject("case15 str flag trailing LF", BuildSlotDatWithFlags("flag_k", "str_k&1\n"));
            Reject("case15 str flag trailing CR", BuildSlotDatWithFlags("flag_k", "str_k&1\r"));
            Reject("case15 str flag trailing CRLF", BuildSlotDatWithFlags("flag_k", "str_k&1\r\n"));
            Reject("case15 str flag leading LF", BuildSlotDatWithFlags("flag_k", "str_k&\n1"));
        }

        private static void Reject(string label, byte[] dat)
        {
            bool rejected = false;
            try
            {
                SaveStore.ValidateSlotSaveBytes(dat);
            }
            catch (Exception)
            {
                rejected = true;
            }
            Assert(rejected, label);
        }

        private static byte[] BuildMinimalSlotDat()
        {
            return BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "10001", 100, 1.0f);
        }

        private static byte[] BuildSlotDatWithG4Raw(byte[] g4Raw)
        {
            return BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "10001", 100, 1.0f, g4Raw);
        }

        private static byte[] BuildSlotDatWithFlags(string intFlagKey, string strFlags)
        {
            return BuildMinimalSlotDat(54, "1001,1,0,0,False", "1|101", "", "10001", 100, 1.0f, null, intFlagKey, strFlags);
        }

        private static byte[] BuildMinimalSlotDat(int rootCount, string kungfuCsv, string equipTrait, string followId, string itemId, int money, float g17)
        {
            return BuildMinimalSlotDat(rootCount, kungfuCsv, equipTrait, followId, itemId, money, g17, null);
        }

        private static byte[] BuildMinimalSlotDat(int rootCount, string kungfuCsv, string equipTrait, string followId, string itemId, int money, float g17, byte[] g4Raw, string intFlagKey = "flag_k", string strFlags = null)
        {
            List<byte> mp = new List<byte>();
            if (rootCount != 54)
            {
                WriteArrayHeader(mp, rootCount);
                for (int i = 0; i < rootCount; i++)
                {
                    mp.Add(0xc0);
                }
                return EncodeCompressed(mp.ToArray());
            }

            WriteArrayHeader(mp, 54);
            for (int i = 0; i < 54; i++)
            {
                if (i == 3)
                {
                    WriteArrayHeader(mp, 1);
                    WriteArrayHeader(mp, 29);
                    for (int ci = 0; ci < 29; ci++)
                    {
                        if (ci == 1)
                        {
                            WriteString(mp, "9001");
                        }
                        else if (ci == 6 || ci == 7)
                        {
                            WriteFloat32(mp, 100.0f);
                        }
                        else if (ci == 9 || ci == 10 || ci == 11 || ci == 13 || ci == 28)
                        {
                            WriteInt(mp, 1);
                        }
                        else if (ci == 15)
                        {
                            WriteArrayHeader(mp, 1);
                            WriteString(mp, kungfuCsv);
                        }
                        else if (ci == 20)
                        {
                            WriteArrayHeader(mp, 3);
                            WriteString(mp, "0");
                            WriteString(mp, "0");
                            WriteString(mp, "0");
                        }
                        else if (ci == 22)
                        {
                            WriteArrayHeader(mp, 1);
                            WriteString(mp, equipTrait);
                        }
                        else
                        {
                            mp.Add(0xc0);
                        }
                    }
                }
                else if (i == 4 && g4Raw != null)
                {
                    mp.AddRange(g4Raw);
                }
                else if (i == 6)
                {
                    WriteArrayHeader(mp, 1);
                    WriteArrayHeader(mp, 2);
                    WriteString(mp, intFlagKey);
                    WriteInt(mp, 1);
                }
                else if (i == 7 && strFlags != null)
                {
                    WriteString(mp, strFlags);
                }
                else if (i == 9)
                {
                    WriteString(mp, "9001");
                }
                else if (i == 14)
                {
                    WriteInt(mp, money);
                }
                else if (i == 15 || i == 16 || i == 24 || i == 33)
                {
                    WriteInt(mp, 1);
                }
                else if (i == 17)
                {
                    WriteFloat32(mp, g17);
                }
                else if (i == 19)
                {
                    WriteArrayHeader(mp, 1);
                    WriteArrayHeader(mp, 2);
                    WriteString(mp, itemId);
                    WriteInt(mp, 5);
                }
                else if (i == 20)
                {
                    WriteArrayHeader(mp, 1);
                    WriteString(mp, "9001");
                }
                else if (i == 21)
                {
                    if (String.IsNullOrEmpty(followId))
                    {
                        WriteArrayHeader(mp, 0);
                    }
                    else
                    {
                        WriteArrayHeader(mp, 1);
                        WriteString(mp, followId);
                    }
                }
                else
                {
                    mp.Add(0xc0);
                }
            }

            return EncodeCompressed(mp.ToArray());
        }

        private static byte[] BuildGZipBomb(int zeroBytes)
        {
            using (MemoryStream output = new MemoryStream())
            {
                using (GZipStream gzip = new GZipStream(output, CompressionMode.Compress, true))
                {
                    byte[] chunk = new byte[64 * 1024];
                    int remaining = zeroBytes;
                    while (remaining > 0)
                    {
                        int n = remaining < chunk.Length ? remaining : chunk.Length;
                        gzip.Write(chunk, 0, n);
                        remaining -= n;
                    }
                }
                return Encoding.ASCII.GetBytes("COMPRESSED:" + Convert.ToBase64String(output.ToArray()));
            }
        }

        private static byte[] BuildDepth66Dat()
        {
            byte[] nested = new byte[67];
            for (int i = 0; i < 66; i++)
            {
                nested[i] = 0x91;
            }
            nested[66] = 0x00;
            return EncodeCompressed(nested);
        }

        private static byte[] EncodeCompressed(byte[] messagePack)
        {
            return Encoding.ASCII.GetBytes("COMPRESSED:" + Convert.ToBase64String(GZipBytes(messagePack)));
        }

        private static byte[] GZipBytes(byte[] input)
        {
            using (MemoryStream output = new MemoryStream())
            {
                using (GZipStream gzip = new GZipStream(output, CompressionMode.Compress, true))
                {
                    gzip.Write(input, 0, input.Length);
                }
                return output.ToArray();
            }
        }

        private static void WriteArrayHeader(List<byte> b, int count)
        {
            if (count <= 15)
            {
                b.Add((byte)(0x90 | count));
            }
            else if (count <= 65535)
            {
                b.Add(0xdc);
                b.Add((byte)((count >> 8) & 0xFF));
                b.Add((byte)(count & 0xFF));
            }
            else
            {
                b.Add(0xdd);
                b.Add((byte)((count >> 24) & 0xFF));
                b.Add((byte)((count >> 16) & 0xFF));
                b.Add((byte)((count >> 8) & 0xFF));
                b.Add((byte)(count & 0xFF));
            }
        }

        private static void WriteString(List<byte> b, string value)
        {
            if (value == null)
            {
                value = "";
            }
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            if (bytes.Length <= 31)
            {
                b.Add((byte)(0xa0 | bytes.Length));
            }
            else if (bytes.Length <= 255)
            {
                b.Add(0xd9);
                b.Add((byte)bytes.Length);
            }
            else if (bytes.Length <= 65535)
            {
                b.Add(0xda);
                b.Add((byte)((bytes.Length >> 8) & 0xFF));
                b.Add((byte)(bytes.Length & 0xFF));
            }
            else
            {
                b.Add(0xdb);
                b.Add((byte)((bytes.Length >> 24) & 0xFF));
                b.Add((byte)((bytes.Length >> 16) & 0xFF));
                b.Add((byte)((bytes.Length >> 8) & 0xFF));
                b.Add((byte)(bytes.Length & 0xFF));
            }
            b.AddRange(bytes);
        }

        private static void WriteInt(List<byte> b, int value)
        {
            if (value >= 0 && value <= 127)
            {
                b.Add((byte)value);
                return;
            }
            if (value >= -32 && value < 0)
            {
                b.Add((byte)(0x100 + value));
                return;
            }
            b.Add(0xd2);
            b.Add((byte)((value >> 24) & 0xFF));
            b.Add((byte)((value >> 16) & 0xFF));
            b.Add((byte)((value >> 8) & 0xFF));
            b.Add((byte)(value & 0xFF));
        }

        private static void WriteFloat32(List<byte> b, float value)
        {
            b.Add(0xca);
            byte[] bytes = BitConverter.GetBytes(value);
            if (BitConverter.IsLittleEndian)
            {
                Array.Reverse(bytes);
            }
            b.AddRange(bytes);
        }
    }
}
