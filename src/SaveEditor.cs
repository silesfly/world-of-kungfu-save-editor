using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("World of Kungfu: Dragon and Eagle Save Editor")]
[assembly: AssemblyProduct("World of Kungfu: Dragon and Eagle Save Editor")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace WorldOfKungfuSaveEditor
{
    internal sealed class Program
    {
        private const string GameRunningMessage = "게임 실행 중이 감지되었습니다. 게임을 종료한 뒤 저장하세요.";

        public static Form MainForm;
        public static WebView2 Web;
        public static string RuntimeFolder;
        public static string TestRoot;
        public static string SeedSourceSav;
        public static bool TestRootOwned;

        private static string activePath;
        private static string activeHash;
        private static string activeSession;
        private static string pendingOpenPath;
        private static string pendingOpenHash;
        private static string pendingOpenSession;
        private static string lastFolder;
        public static int ExitCode;
        private static bool closingAllowed;
        private static bool selfTestStarted;
        private static bool webDirty;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 32 };

        [STAThread]
        private static int Main(string[] args)
        {
            if (args != null && args.Length >= 2 && args[0] == "--self-test")
            {
                if (args.Length != 2 && args.Length != 3)
                {
                    Console.Error.WriteLine("usage: WorldOfKungfuSaveEditor-v1.0.exe --self-test <test-root> [<seed-dat>]");
                    return 2;
                }
                SaveStore.NoLinks(args[1]);
                TestRoot = Path.GetFullPath(args[1]);
                if (Directory.Exists(TestRoot) || File.Exists(TestRoot))
                {
                    Console.Error.WriteLine("self-test root already exists: " + TestRoot);
                    return 2;
                }
                SaveStore.NoLinks(TestRoot);
                Directory.CreateDirectory(TestRoot);
                SaveStore.NoLinks(TestRoot);
                TestRootOwned = true;
                RuntimeFolder = TestRoot;
                if (args.Length == 3)
                {
                    SaveStore.NoLinks(args[2]);
                    SeedSourceSav = Path.GetFullPath(args[2]);
                }
            }
            else if (args != null && args.Length != 0)
            {
                Console.Error.WriteLine("usage: WorldOfKungfuSaveEditor-v1.0.exe [--self-test <root> [<seed-dat>]]");
                return 2;
            }
            else
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                RuntimeFolder = Path.Combine(localAppData, "WorldOfKungfuSaveEditor", "runtime-1.0.0");
            }

            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;

            try
            {
                Run();
            }
            catch (Exception ex)
            {
                Fail(ex);
                return ExitCode;
            }

            return ExitCode;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            SaveStore.NoLinks(RuntimeFolder);
            Directory.CreateDirectory(RuntimeFolder);
            SaveStore.NoLinks(RuntimeFolder);
            ExtractLoaderDll();

            CoreWebView2Environment.SetLoaderDllFolderPath(RuntimeFolder);

            MainForm = new Form();
            MainForm.Text = "대강호: 창룡과 백조 세이브 에디터 v1.0";
            MainForm.Width = 1180;
            MainForm.Height = 820;
            MainForm.MinimumSize = new Size(880, 600);
            MainForm.StartPosition = FormStartPosition.CenterScreen;
            MainForm.FormClosing += OnFormClosing;

            if (TestRoot != null)
            {
                MainForm.WindowState = FormWindowState.Minimized;
                MainForm.ShowInTaskbar = false;
            }

            Web = new WebView2();
            Web.Dock = DockStyle.Fill;
            MainForm.Controls.Add(Web);
            MainForm.FormClosed += delegate { Web.Dispose(); };

            MainForm.Shown += async delegate
            {
                try
                {
                    await InitWebViewAsync();
                }
                catch (Exception ex)
                {
                    Fail(ex);
                }
            };

            Application.Run(MainForm);
        }

        private static void ExtractLoaderDll()
        {
            SaveStore.NoLinks(RuntimeFolder);
            byte[] embedded = ReadResource("WebView2Loader.dll");
            if (embedded == null)
            {
                throw new InvalidOperationException("WebView2Loader.dll is not embedded in this build.");
            }
            string expected = SaveStore.Hash(embedded);
            string destination = Path.Combine(RuntimeFolder, "WebView2Loader.dll");
            SaveStore.NoLinks(destination);

            if (File.Exists(destination))
            {
                FileStream existingStream = null;
                try
                {
                    existingStream = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                    SaveStore.VerifyHandle(existingStream, destination);
                    if (existingStream.Length == embedded.Length)
                    {
                        int length = (int)existingStream.Length;
                        byte[] existing = new byte[length];
                        int offset = 0;
                        while (offset < length)
                        {
                            int read = existingStream.Read(existing, offset, length - offset);
                            if (read <= 0)
                            {
                                break;
                            }
                            offset += read;
                        }
                        if (offset == length && String.Equals(SaveStore.Hash(existing), expected, StringComparison.Ordinal))
                        {
                            return;
                        }
                    }
                }
                catch (FileNotFoundException)
                {
                }
                finally
                {
                    if (existingStream != null)
                    {
                        existingStream.Dispose();
                    }
                }
            }

            string pending = destination + ".pending-" + Guid.NewGuid().ToString("N");
            try
            {
                FileStream ps = new FileStream(pending, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
                try
                {
                    SaveStore.VerifyHandle(ps, pending);
                    ps.Write(embedded, 0, embedded.Length);
                    ps.Flush(true);
                }
                finally
                {
                    ps.Dispose();
                }
                SaveStore.NoLinks(destination);
                SaveStore.AtomicReplaceFile(pending, destination);
            }
            catch (Exception)
            {
                try
                {
                    if (File.Exists(pending))
                    {
                        File.Delete(pending);
                    }
                }
                catch (Exception)
                {
                }
                throw;
            }

            FileStream checkStream = null;
            try
            {
                checkStream = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                SaveStore.VerifyHandle(checkStream, destination);
                int checkLength = (int)checkStream.Length;
                byte[] check = new byte[checkLength];
                int checkOffset = 0;
                while (checkOffset < checkLength)
                {
                    int read = checkStream.Read(check, checkOffset, checkLength - checkOffset);
                    if (read <= 0)
                    {
                        break;
                    }
                    checkOffset += read;
                }
                if (checkOffset != checkLength || !String.Equals(SaveStore.Hash(check), expected, StringComparison.Ordinal))
                {
                    throw new IOException("WebView2Loader.dll SHA-256 verification failed.");
                }
            }
            finally
            {
                if (checkStream != null)
                {
                    checkStream.Dispose();
                }
            }
        }

        private static void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!closingAllowed && Program.TestRoot != null)
            {
                e.Cancel = true;
                return;
            }

            if (!closingAllowed && Program.TestRoot == null && webDirty)
            {
                DialogResult result = MessageBox.Show(MainForm, "저장하지 않은 변경 사항이 있습니다. 저장하지 않고 종료하시겠습니까?", "대강호 세이브 에디터", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (result != DialogResult.Yes)
                {
                    e.Cancel = true;
                }
            }
        }

        private static async Task InitWebViewAsync()
        {
            string profileFolder = Path.Combine(RuntimeFolder, "Profile");
            SaveStore.NoLinks(profileFolder);
            CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions("--disable-background-networking");
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileFolder, options);
            await Web.EnsureCoreWebView2Async(environment);

            CoreWebView2Settings settings = Web.CoreWebView2.Settings;
            settings.AreDevToolsEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsWebMessageEnabled = true;
            try
            {
                settings.AreHostObjectsAllowed = false;
            }
            catch (Exception)
            {
                // older runtimes
            }

            Web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };
            Web.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
            {
                e.State = CoreWebView2PermissionState.Deny;
                e.Handled = true;
            };

            bool initialNavigationSeen = false;
            Web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                string uri = e.Uri == null ? "" : e.Uri;
                if (!initialNavigationSeen && (uri.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)))
                {
                    initialNavigationSeen = true;
                    return;
                }
                e.Cancel = true;
            };

            Web.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            Web.CoreWebView2.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e)
            {
                string uri = e.Request.Uri == null ? "" : e.Request.Uri;
                if (uri.StartsWith("http:", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
                {
                    MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes("Offline"));
                    e.Response = Web.CoreWebView2.Environment.CreateWebResourceResponse(
                        stream, 403, "Offline", "Content-Type: text/plain");
                }
            };

            Web.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e)
            {
                string raw = e.WebMessageAsJson;
                try
                {
                    HandleRequest(raw);
                }
                catch (Exception ex)
                {
                    try
                    {
                        Dictionary<string, object> failure = new Dictionary<string, object>();
                        failure["ok"] = false;
                        failure["error"] = ex.Message;
                        string replyId = null;
                        object replySeq = null;
                        try
                        {
                            object parsed = Json.DeserializeObject(raw);
                            Dictionary<string, object> root = parsed as Dictionary<string, object>;
                            if (root != null)
                            {
                                replyId = GetString(root, "id");
                                object seqValue;
                                if (root.TryGetValue("seq", out seqValue))
                                {
                                    replySeq = seqValue;
                                }
                            }
                        }
                        catch (Exception)
                        {
                        }
                        Reply(replyId, replySeq, failure);
                    }
                    catch (Exception)
                    {
                    }
                }
            };

            string html = Encoding.UTF8.GetString(ReadResource("editor.html"));
            Web.CoreWebView2.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                {
                    Fail(new InvalidOperationException("WebView2 navigation failed: " + e.WebErrorStatus));
                    return;
                }

                if (Program.TestRoot != null && !selfTestStarted)
                {
                    selfTestStarted = true;
                    try
                    {
                        await SelfTest();
                    }
                    catch (Exception ex)
                    {
                        Fail(ex);
                    }
                }
            };
            Web.CoreWebView2.NavigateToString(html);
        }

        private static void Fail(Exception ex)
        {
            ExitCode = 1;
            if (Program.TestRoot != null)
            {
                try
                {
                    string path = Path.Combine(Program.TestRoot, "failure.txt");
                    File.WriteAllText(path, ex.ToString(), Encoding.UTF8);
                }
                catch (Exception)
                {
                }
            }
            else
            {
                try
                {
                    MessageBox.Show(ex.ToString(), "World of Kungfu Save Editor", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                catch (Exception)
                {
                }
            }

            closingAllowed = true;
            if (MainForm != null)
            {
                try
                {
                    MainForm.Close();
                }
                catch (Exception)
                {
                }
            }
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name == "Microsoft.Web.WebView2.Core" || name == "Microsoft.Web.WebView2.WinForms")
            {
                byte[] bytes = ReadResource(name + ".dll");
                if (bytes != null)
                {
                    return Assembly.Load(bytes);
                }
            }
            return null;
        }

        public static byte[] Resource(string name)
        {
            return ReadResource(name);
        }

        private static byte[] ReadResource(string name)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            Stream stream = assembly.GetManifestResourceStream(name);
            if (stream == null)
            {
                return null;
            }
            using (stream)
            {
                long length = stream.Length;
                byte[] buffer = new byte[(int)length];
                int read = 0;
                while (read < buffer.Length)
                {
                    int n = stream.Read(buffer, read, buffer.Length - read);
                    if (n <= 0)
                    {
                        break;
                    }
                    read += n;
                }
                return buffer;
            }
        }

        public static void CheckGameNotRunning()
        {
            if (Environment.GetEnvironmentVariable("WOKSE_SIMULATE_GAME_RUNNING") == "1")
            {
                throw new IOException(GameRunningMessage);
            }
            Process[] processes = Process.GetProcesses();
            try
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    string pname = processes[i].ProcessName;
                    if (pname == null)
                    {
                        continue;
                    }
                    string lower = pname.ToLowerInvariant();
                    if (lower.IndexOf("theworldofkongfu", StringComparison.Ordinal) >= 0
                        || lower.IndexOf("theworldofkungfu", StringComparison.Ordinal) >= 0)
                    {
                        throw new IOException(GameRunningMessage);
                    }
                }
            }
            finally
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    try
                    {
                        processes[i].Dispose();
                    }
                    catch (Exception)
                    {
                    }
                }
            }
        }

        public static string GetDefaultWokSaveDir()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            string direct = Path.Combine(baseDir, "save");
            if (Directory.Exists(direct))
            {
                return direct;
            }

            string parent = Path.GetDirectoryName(baseDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (!String.IsNullOrEmpty(parent))
            {
                string parentSave = Path.Combine(parent, "save");
                if (Directory.Exists(parentSave))
                {
                    return parentSave;
                }
            }

            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (!String.IsNullOrEmpty(documents))
            {
                string stable = Path.Combine(documents, "TheWorldOfKongFu_Stable");
                if (Directory.Exists(stable))
                {
                    return stable;
                }
                string legacy = Path.Combine(documents, "TheWorldOfKongFu");
                if (Directory.Exists(legacy))
                {
                    return legacy;
                }
            }

            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!String.IsNullOrEmpty(userProfile))
            {
                string profileDocs = Path.Combine(userProfile, "Documents");
                string stable = Path.Combine(profileDocs, "TheWorldOfKongFu_Stable");
                if (Directory.Exists(stable))
                {
                    return stable;
                }
                string legacy = Path.Combine(profileDocs, "TheWorldOfKongFu");
                if (Directory.Exists(legacy))
                {
                    return legacy;
                }
            }

            return baseDir;
        }

        private static string GetString(Dictionary<string, object> root, string key)
        {
            object value;
            if (root == null || !root.TryGetValue(key, out value) || value == null)
            {
                return null;
            }
            return value as string;
        }

        private static void Reply(string id, object seq, Dictionary<string, object> payload)
        {
            if (payload == null)
            {
                payload = new Dictionary<string, object>();
            }
            payload["id"] = id;
            if (seq != null)
            {
                payload["seq"] = seq;
            }
            Web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(payload));
        }

        private static void HandleRequest(string raw)
        {
            object parsed = Json.DeserializeObject(raw);
            Dictionary<string, object> root = parsed as Dictionary<string, object>;
            if (root == null)
            {
                return;
            }

            string id = GetString(root, "id");
            object seqValue = null;
            object rawSeq;
            if (root.TryGetValue("seq", out rawSeq))
            {
                seqValue = rawSeq;
            }
            string kind = GetString(root, "kind");

            if (kind == "dirty")
            {
                object dirtyObj;
                webDirty = root.TryGetValue("dirty", out dirtyObj) && dirtyObj is bool && (bool)dirtyObj;
                return;
            }
            if (kind == "detach")
            {
                activePath = null;
                activeHash = null;
                activeSession = null;
                pendingOpenPath = null;
                pendingOpenHash = null;
                pendingOpenSession = null;
                object detachDirtyObj;
                if (root.TryGetValue("dirty", out detachDirtyObj) && detachDirtyObj is bool)
                {
                    webDirty = (bool)detachDirtyObj;
                }
                else
                {
                    webDirty = false;
                }
                Dictionary<string, object> detached = new Dictionary<string, object>();
                detached["ok"] = true;
                detached["kind"] = kind;
                Reply(id, seqValue, detached);
                return;
            }
            if (kind == "commit-open")
            {
                string commitSession = GetString(root, "session");
                if (!(!String.IsNullOrEmpty(pendingOpenSession) && !String.IsNullOrEmpty(pendingOpenPath) && String.Equals(commitSession, pendingOpenSession, StringComparison.Ordinal)))
                {
                    throw new IOException("열기 세션 토큰이 일치하지 않습니다.");
                }
                activePath = pendingOpenPath;
                activeHash = pendingOpenHash;
                activeSession = pendingOpenSession;
                lastFolder = Path.GetDirectoryName(activePath);
                pendingOpenPath = null;
                pendingOpenHash = null;
                pendingOpenSession = null;
                object commitDirtyObj;
                if (root.TryGetValue("dirty", out commitDirtyObj) && commitDirtyObj is bool)
                {
                    webDirty = (bool)commitDirtyObj;
                }
                else
                {
                    webDirty = false;
                }
                Dictionary<string, object> committed = new Dictionary<string, object>();
                committed["ok"] = true;
                committed["kind"] = kind;
                committed["session"] = activeSession;
                committed["name"] = Path.GetFileName(activePath);
                committed["path"] = activePath;
                Reply(id, seqValue, committed);
                return;
            }
            if (kind == "abort-open")
            {
                string abortSession = GetString(root, "session");
                if (String.IsNullOrEmpty(abortSession) || String.Equals(abortSession, pendingOpenSession, StringComparison.Ordinal))
                {
                    pendingOpenPath = null;
                    pendingOpenHash = null;
                    pendingOpenSession = null;
                }
                object abortDirtyObj;
                if (root.TryGetValue("dirty", out abortDirtyObj) && abortDirtyObj is bool)
                {
                    webDirty = (bool)abortDirtyObj;
                }
                Dictionary<string, object> aborted = new Dictionary<string, object>();
                aborted["ok"] = true;
                aborted["kind"] = kind;
                Reply(id, seqValue, aborted);
                return;
            }
            if (kind == "ready")
            {
                if (Program.TestRoot == null)
                {
                    string folder = lastFolder;
                    if (String.IsNullOrEmpty(folder))
                    {
                        folder = GetDefaultWokSaveDir();
                    }
                    if (!String.IsNullOrEmpty(folder))
                    {
                        for (int slot = 1; slot <= 24; slot++)
                        {
                            string candidate = Path.Combine(folder, "bigbang" + slot + "data.dat");
                            if (File.Exists(candidate))
                            {
                                byte[] bytes = SaveStore.Read(candidate);
                                pendingOpenPath = Path.GetFullPath(candidate);
                                pendingOpenHash = SaveStore.Hash(bytes);
                                pendingOpenSession = Guid.NewGuid().ToString("N");
                                Dictionary<string, object> reply = new Dictionary<string, object>();
                                reply["ok"] = true;
                                reply["kind"] = kind;
                                reply["session"] = pendingOpenSession;
                                reply["name"] = Path.GetFileName(pendingOpenPath);
                                reply["path"] = pendingOpenPath;
                                reply["base64"] = Convert.ToBase64String(bytes);
                                Reply(id, seqValue, reply);
                                return;
                            }
                        }
                    }
                }
                Dictionary<string, object> ready = new Dictionary<string, object>();
                ready["ok"] = true;
                ready["kind"] = kind;
                Reply(id, seqValue, ready);
                return;
            }

            if (kind == "open")
            {
                string fullPath = null;
                if (Program.TestRoot != null)
                {
                    fullPath = Path.Combine(Path.Combine(Program.TestRoot, "save"), "bigbang1data.dat");
                }
                else
                {
                    using (OpenFileDialog dialog = new OpenFileDialog())
                    {
                        dialog.Filter = "대강호 세이브 (*.dat)|*.dat";
                        dialog.CheckFileExists = true;
                        if (!String.IsNullOrEmpty(lastFolder))
                        {
                            dialog.InitialDirectory = lastFolder;
                        }
                        if (dialog.ShowDialog(MainForm) != DialogResult.OK)
                        {
                            Dictionary<string, object> cancelled = new Dictionary<string, object>();
                            cancelled["ok"] = true;
                            cancelled["kind"] = kind;
                            cancelled["cancelled"] = true;
                            Reply(id, seqValue, cancelled);
                            return;
                        }
                        fullPath = dialog.FileName;
                    }
                }

                byte[] bytes = SaveStore.Read(fullPath);
                pendingOpenPath = Path.GetFullPath(fullPath);
                pendingOpenHash = SaveStore.Hash(bytes);
                pendingOpenSession = Guid.NewGuid().ToString("N");
                Dictionary<string, object> reply = new Dictionary<string, object>();
                reply["ok"] = true;
                reply["kind"] = kind;
                reply["session"] = pendingOpenSession;
                reply["name"] = Path.GetFileName(pendingOpenPath);
                reply["path"] = pendingOpenPath;
                reply["base64"] = Convert.ToBase64String(bytes);
                Reply(id, seqValue, reply);
                return;
            }

            if (kind == "save")
            {
                CheckGameNotRunning();
                if (activePath == null)
                {
                    throw new IOException("먼저 세이브 파일을 열어야 합니다.");
                }
                string requestSession = GetString(root, "session");
                if (!String.Equals(requestSession, activeSession, StringComparison.Ordinal))
                {
                    throw new IOException("세션 토큰이 일치하지 않습니다. 세이브 파일을 다시 열어주세요.");
                }
                string b64 = GetString(root, "base64");
                if (b64 == null)
                {
                    throw new IOException("저장 데이터가 비어 있습니다.");
                }
                byte[] data = Convert.FromBase64String(b64);
                SaveStore.ValidateSlotSaveBytes(data);

                string reqName = GetString(root, "name");
                if (!String.IsNullOrEmpty(reqName) && !String.Equals(reqName, Path.GetFileName(activePath), StringComparison.OrdinalIgnoreCase))
                {
                    Dictionary<string, object> err = new Dictionary<string, object>();
                    err["ok"] = false;
                    err["error"] = "name mismatch";
                    Reply(id, seqValue, err);
                    return;
                }
                string backup = SaveStore.ReplaceWithBackup(activePath, activeHash, data);
                activeHash = SaveStore.Hash(data);
                activeSession = Guid.NewGuid().ToString("N");
                webDirty = false;

                Dictionary<string, object> reply = new Dictionary<string, object>();
                reply["ok"] = true;
                reply["kind"] = kind;
                reply["session"] = activeSession;
                reply["path"] = activePath;
                reply["name"] = Path.GetFileName(activePath);
                reply["backup"] = backup;
                Reply(id, seqValue, reply);
                return;
            }

            if (kind == "save-copy")
            {
                CheckGameNotRunning();
                string dest = null;
                using (SaveFileDialog dialog = new SaveFileDialog())
                {
                    dialog.Filter = "대강호 세이브 (*.dat)|*.dat";
                    dialog.DefaultExt = "dat";
                    dialog.AddExtension = true;
                    dialog.OverwritePrompt = true;
                    if (!String.IsNullOrEmpty(lastFolder))
                    {
                        dialog.InitialDirectory = lastFolder;
                    }
                    string suggested = GetString(root, "name");
                    if (suggested == null)
                    {
                        suggested = "bigbang1data_copy.dat";
                    }
                    dialog.FileName = suggested;
                    if (dialog.ShowDialog(MainForm) != DialogResult.OK)
                    {
                        Dictionary<string, object> cancelled = new Dictionary<string, object>();
                        cancelled["ok"] = true;
                        cancelled["cancelled"] = true;
                        Reply(id, seqValue, cancelled);
                        return;
                    }
                    dest = dialog.FileName;
                }

                if (!SaveStore.IsSaveExtension(dest))
                {
                    throw new IOException("세이브 확장자(.dat)만 허용됩니다: " + dest);
                }

                string b64 = GetString(root, "base64");
                if (b64 == null)
                {
                    throw new IOException("복사할 데이터가 비어 있습니다.");
                }
                byte[] data = Convert.FromBase64String(b64);
                SaveStore.ValidateSlotSaveBytes(data);

                string backup = null;
                if (activePath != null && !String.IsNullOrEmpty(activeSession) && String.Equals(GetString(root, "session"), activeSession, StringComparison.Ordinal) && File.Exists(activePath))
                {
                    backup = SaveStore.CopyWithBackup(activePath, dest, activeHash, data);
                }
                else
                {
                    SaveStore.WriteNew(dest, data);
                }

                Dictionary<string, object> reply = new Dictionary<string, object>();
                reply["ok"] = true;
                reply["kind"] = kind;
                reply["path"] = Path.GetFullPath(dest);
                reply["backup"] = backup;
                Reply(id, seqValue, reply);
                return;
            }

            throw new IOException("알 수 없는 요청입니다: " + kind);
        }

        private static async Task Until(string expression)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 30000)
            {
                string result = await Web.CoreWebView2.ExecuteScriptAsync(expression);
                if (result != null && result.Trim() == "true")
                {
                    return;
                }
                await Task.Delay(100);
            }
            throw new TimeoutException("조건 대기 실패: " + expression);
        }

        private static async Task<string> Eval(string expression)
        {
            return await Web.CoreWebView2.ExecuteScriptAsync(expression);
        }

        private static async Task SelfTest()
        {
            string sourceMode;
            byte[] seedBytes;
            if (String.IsNullOrEmpty(SeedSourceSav))
            {
                sourceMode = "demo";
                await Eval("(function(){window.__demoStr=null;window.__demoErr=null;window.WokEditorCore.createDemoDatAsync().then(function(s){window.__demoStr=s;}).catch(function(e){window.__demoErr=String(e);});return true;})()");
                await Until("window.__demoStr !== null || window.__demoErr !== null");
                string demoErr = UnquoteJson(await Eval("window.__demoErr === null ? '' : String(window.__demoErr)"));
                if (!String.IsNullOrEmpty(demoErr))
                {
                    throw new InvalidOperationException(demoErr);
                }
                string demoStr = UnquoteJson(await Eval("window.__demoStr"));
                seedBytes = Encoding.UTF8.GetBytes(demoStr);
            }
            else
            {
                sourceMode = "seed";
                seedBytes = SaveStore.Read(SeedSourceSav);
            }
            string saveDir = Path.Combine(TestRoot, "save");
            Directory.CreateDirectory(saveDir);
            string savPath = Path.Combine(saveDir, "bigbang1data.dat");
            SaveStore.WriteNew(savPath, seedBytes);
            string originalDatHash = SaveStore.Hash(seedBytes);

            await Until("Boolean(window.WokEditorUI) && !window.WokEditorUI.isBusy()");
            await Eval("document.getElementById('btn-native-open').click(); true");
            await Until("!window.WokEditorUI.isBusy() && window.WokEditorUI.getNativeSession() !== null && window.WokEditorUI.getSession() !== null");
            string origKey = UnquoteJson(await Eval("window.WokEditorUI.getSession().getSummary().key + ':' + window.WokEditorUI.getSession().getSummary().version + ':' + window.WokEditorUI.getSession().getSummary().charaCount"));

            await Eval("document.querySelector('[data-preset=\"rich_epiphany\"]').click(); true");
            await Until("window.hasUnsavedChanges() === true && window.WokEditorUI.getSession().validate().valid === true");

            await Eval("window.__prevSession = window.WokEditorUI.getNativeSession(); document.getElementById('btn-native-save').click(); true");
            await Until("!window.WokEditorUI.isBusy() && window.hasUnsavedChanges() === false && window.WokEditorUI.getNativeSession() !== window.__prevSession");

            string[] backups = Directory.GetFiles(saveDir, "bigbang1data.dat.backup-*.bak");
            if (backups.Length != 1)
            {
                throw new InvalidOperationException("Expected exactly one backup file, found " + backups.Length);
            }
            if (SaveStore.Hash(File.ReadAllBytes(backups[0])) != originalDatHash)
            {
                throw new InvalidOperationException("Backup hash mismatch");
            }

            await Eval("window.__prevSession = window.WokEditorUI.getNativeSession(); document.getElementById('btn-native-open').click(); true");
            await Until("!window.WokEditorUI.isBusy() && window.WokEditorUI.getNativeSession() !== null && window.WokEditorUI.getNativeSession() !== window.__prevSession && window.WokEditorUI.getSession() !== null");

            string reloadJson = UnquoteJson(await Eval("JSON.stringify({ valid: window.WokEditorUI.getSession().validate().valid, money: window.WokEditorUI.getSession().getSummary().money, epiphany: window.WokEditorUI.getSession().getSummary().epiphany, shovel: window.WokEditorUI.getSession().getSummary().shovelDurable, meta: window.WokEditorUI.getSession().getSummary().key + ':' + window.WokEditorUI.getSession().getSummary().version + ':' + window.WokEditorUI.getSession().getSummary().charaCount })"));
            Dictionary<string, object> summary = Json.DeserializeObject(reloadJson) as Dictionary<string, object>;
            if (summary == null || !(summary["valid"] is bool) || !(bool)summary["valid"])
            {
                throw new InvalidOperationException("Reloaded save did not validate");
            }
            if (ToInt(summary["money"]) < 9999999)
            {
                throw new InvalidOperationException("Money preset was not persisted");
            }
            if (ToInt(summary["epiphany"]) < 999)
            {
                throw new InvalidOperationException("Epiphany preset was not persisted");
            }
            if (ToInt(summary["shovel"]) < 9999)
            {
                throw new InvalidOperationException("Shovel preset was not persisted");
            }
            if (GetString(summary, "meta") != origKey)
            {
                throw new InvalidOperationException("Metadata was not preserved");
            }

            Dictionary<string, object> receipt = new Dictionary<string, object>();
            receipt["status"] = "PASS";
            receipt["sourceMode"] = sourceMode;
            receipt["moneyAfterReload"] = ToInt(summary["money"]);
            receipt["epiphanyAfterReload"] = ToInt(summary["epiphany"]);
            receipt["shovelAfterReload"] = ToInt(summary["shovel"]);
            receipt["backupVerified"] = true;
            receipt["metadataPreserved"] = true;
            receipt["htmlHash"] = SaveStore.Hash(Program.Resource("editor.html"));
            File.WriteAllText(Path.Combine(TestRoot, "receipt.json"), Json.Serialize(receipt), Encoding.UTF8);
            closingAllowed = true;
            MainForm.Close();
        }

        private static int ToInt(object value)
        {
            if (value == null)
            {
                return 0;
            }
            if (value is int)
            {
                return (int)value;
            }
            if (value is long)
            {
                return (int)(long)value;
            }
            if (value is double)
            {
                return (int)(double)value;
            }
            if (value is string)
            {
                int parsed;
                if (Int32.TryParse((string)value, out parsed))
                {
                    return parsed;
                }
            }
            return 0;
        }

        private static string UnquoteJson(string value)
        {
            if (value == null)
            {
                return null;
            }
            string trimmed = value.Trim();
            if (trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"')
            {
                try
                {
                    object parsed = Json.DeserializeObject(trimmed);
                    string strValue = parsed as string;
                    if (strValue != null)
                    {
                        return strValue;
                    }
                }
                catch (Exception)
                {
                }
                return trimmed.Substring(1, trimmed.Length - 2);
            }
            return trimmed;
        }
    }
}
