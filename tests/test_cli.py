import base64
import glob
import hashlib
import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

import wok_editor
import build


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _read_bytes(path):
    return Path(path).read_bytes()


def _write_bytes(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(data)


def _backup_files(path):
    p = Path(path)
    return sorted(p.parent.glob(p.name + ".backup-*.bak"))


def _request(conn, method, path, body=None, headers=None):
    conn.request(method, path, body=body, headers=headers or {})
    resp = conn.getresponse()
    data = resp.read()
    return resp.status, dict(resp.getheaders()), data


def _load_session_from_path(path):
    data = _read_bytes(path)
    attempts = [
        lambda: wok_editor.WokSaveSession(data),
        lambda: wok_editor.WokSaveSession.from_bytes(data),
        lambda: wok_editor.WokSaveSession.open(path),
        lambda: wok_editor.WokSaveSession.from_path(path),
    ]
    last = None
    for attempt in attempts:
        try:
            return attempt()
        except Exception as exc:
            last = exc
    raise last


def _session_validate_ok(data):
    attempts = [
        lambda: wok_editor.WokSaveSession(data).validate()["ok"],
        lambda: wok_editor.WokSaveSession.from_bytes(data).validate()["ok"],
    ]
    last = None
    for attempt in attempts:
        try:
            return bool(attempt())
        except Exception as exc:
            last = exc
    raise last


def _hero_name(session):
    summary = session.summary()
    return summary["heroName"]


def _item_amount(session, item_id):
    for item in session.list_inventory():
        if str(item.get("id")) == str(item_id):
            return item.get("amount", 0)
    return 0


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="wokse-cli-")
        self.save_dir = Path(self.tmp) / "save"
        self.save_dir.mkdir(parents=True, exist_ok=True)
        self.demo_bytes = wok_editor.create_demo_dat_bytes()
        self.demo_path = self.save_dir / "bigbang1data.dat"
        _write_bytes(self.demo_path, self.demo_bytes)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_demo_roundtrip_and_cli_inspect_validate_presets(self):
        node, raw_mp = wok_editor.decode_dat_bytes(self.demo_bytes)
        self.assertEqual(wok_editor.encode_msgpack(node), raw_mp)
        self.assertEqual(wok_editor.main(["inspect", str(self.demo_path), "--json"]), 0)
        self.assertEqual(wok_editor.main(["validate", str(self.demo_path), "--json"]), 0)
        self.assertEqual(wok_editor.main(["presets", "--json"]), 0)

    def test_cli_edit_backup_and_mutations(self):
        original_hash = _sha256_bytes(_read_bytes(self.demo_path))
        item_id = next(iter(wok_editor.load_catalog()["items"]))
        rc = wok_editor.main([
            "edit",
            str(self.demo_path),
            "--preset",
            "rich_epiphany",
            "--preset",
            "hero_six_attributes",
            "--name",
            "적열검협",
            "--set-stat",
            "1003=6000",
            "--set-item",
            f"{item_id}:5",
        ])
        self.assertEqual(rc, 0)
        backups = _backup_files(self.demo_path)
        self.assertEqual(len(backups), 1)
        self.assertEqual(_sha256_bytes(_read_bytes(backups[0])), original_hash)
        session = _load_session_from_path(self.demo_path)
        self.assertEqual(_hero_name(session), "적열검협")
        self.assertEqual(int(_item_amount(session, item_id)), 5)
        before_bad = _read_bytes(self.demo_path)
        self.assertEqual(
            wok_editor.main([
                "edit",
                str(self.demo_path),
                "--name",
                "가,나",
            ]),
            2,
        )
        self.assertEqual(_read_bytes(self.demo_path), before_bad)

    def test_non_slot_rejection(self):
        bad_config = self.save_dir / "configdata.dat"
        _write_bytes(bad_config, wok_editor.encode_dat_bytes(wok_editor.mp_arr([wok_editor.mp_int(i) for i in range(26)])))
        self.assertEqual(wok_editor.main(["validate", str(bad_config), "--json"]), 2)
        malformed = self.save_dir / "malformed.dat"
        _write_bytes(malformed, b"not-a-compressed-dat")
        self.assertEqual(wok_editor.main(["validate", str(malformed), "--json"]), 2)

        corrupt_char = self.save_dir / "corrupt_char.dat"
        ast, _ = wok_editor.decode_dat_bytes(self.demo_bytes)
        ast.raw = None
        ast.val[3].raw = None
        ast.val[3].val[0] = wok_editor.MPNode("nil", None)
        _write_bytes(corrupt_char, wok_editor.encode_dat_bytes(ast))
        with self.assertRaises(ValueError):
            wok_editor.WokSaveSession(corrupt_char.read_bytes())
        self.assertEqual(wok_editor.main(["validate", str(corrupt_char), "--json"]), 2)

    def test_path_and_process_guards(self):
        target = self.save_dir / "target.dat"
        _write_bytes(target, self.demo_bytes)
        symlink_path = self.save_dir / "link.dat"
        try:
            os.symlink(target, symlink_path)
        except (OSError, NotImplementedError):
            symlink_path = None
        if symlink_path is not None:
            with self.assertRaises(PermissionError):
                wok_editor.save_dat_safely(symlink_path, self.demo_bytes)
        hardlink_path = self.save_dir / "hard.dat"
        try:
            os.link(target, hardlink_path)
        except OSError:
            hardlink_path = None
        if hardlink_path is not None:
            with self.assertRaises(PermissionError):
                wok_editor.save_dat_safely(hardlink_path, self.demo_bytes)
        for name in ("CON.dat", "COM1.dat", "../evil.dat", "a.dat:b.dat"):
            self.assertFalse(wok_editor._valid_save_name(name))
        import unittest.mock

        # Truncated 15-char /proc/<pid>/comm detection.
        with tempfile.TemporaryDirectory() as td:
            fake_proc = os.path.join(td, "proc")
            os.makedirs(fake_proc)
            for pid, comm in (("101", "TheWorldOfKongF\n"), ("202", "TheWorldOfKungF\n")):
                pid_dir = os.path.join(fake_proc, pid)
                os.makedirs(pid_dir)
                with open(os.path.join(pid_dir, "comm"), "w", encoding="utf-8") as fh:
                    fh.write(comm)
            self.assertTrue(wok_editor._scan_proc_for_game(fake_proc))

        # Sol-R5-2: POSIX ps fallback must handle spaces, 15-char comm, wine,
        # self PID exclusion, and trailing save-path arguments.
        self.assertTrue(wok_editor._scan_posix_ps_for_game(
            ps_comm_output="",
            ps_args_output="101 /Users/test/Library/Application Support/Steam/steamapps/common/TheWorldOfKongFu.app/Contents/MacOS/TheWorldOfKongFu\n",
        ))
        self.assertTrue(wok_editor._scan_posix_ps_for_game(
            ps_comm_output="202 TheWorldOfKongF\n",
            ps_args_output="",
        ))
        self.assertTrue(wok_editor._scan_posix_ps_for_game(
            ps_comm_output="303 wine64-preloader\n",
            ps_args_output="303 wine64-preloader Z:\\Games\\TheWorldOfKungFu.exe\n",
        ))
        self.assertFalse(wok_editor._scan_posix_ps_for_game(
            ps_comm_output=f"{os.getpid()} TheWorldOfKongFu\n",
            ps_args_output="",
        ))
        self.assertFalse(wok_editor._scan_posix_ps_for_game(
            ps_comm_output="",
            ps_args_output="99999 python3 wok_editor.py edit /Users/test/TheWorldOfKongFu_Stable/bigbang1data.dat\n",
        ))
        with unittest.mock.patch("wok_editor.Path.is_dir", return_value=False), unittest.mock.patch(
            "wok_editor.subprocess.run"
        ) as run_mock:
            run_mock.return_value = unittest.mock.Mock(
                returncode=0,
                stdout="101 /Applications/TheWorldOfKongFu.app/Contents/MacOS/TheWorldOfKongFu\n",
            )
            self.assertTrue(wok_editor.is_game_running())
            run_mock.assert_called()

        # IO failures must preserve the original file and leave no temp/backup files.
        original = self.demo_path.read_bytes()
        temp_glob = str(self.demo_path.parent / ".woktmp-*")
        bak_glob = str(self.demo_path.parent / (self.demo_path.name + ".backup-*.bak"))
        for patch_target in ("wok_editor._open_temp_save_file", "wok_editor.os.fsync"):
            with unittest.mock.patch(patch_target, side_effect=OSError("io fault")):
                with self.assertRaises(OSError):
                    wok_editor.save_dat_safely(self.demo_path, self.demo_bytes)
            self.assertEqual(self.demo_path.read_bytes(), original)
            self.assertEqual(glob.glob(temp_glob), [])
            self.assertEqual(glob.glob(bak_glob), [])

        preexisting_bak = self.demo_path.with_name(self.demo_path.name + '.backup-20261114-120000-deadbeef.bak')
        preexisting_bak.write_bytes(b'KEEP_EXISTING_BACKUP')
        fake_dt = unittest.mock.Mock()
        fake_dt.datetime.now.return_value.strftime.return_value = '20261114-120000'
        fake_dt.now.return_value.strftime.return_value = '20261114-120000'
        with unittest.mock.patch('wok_editor.os.urandom', return_value=b'\xde\xad\xbe\xef'):
            with unittest.mock.patch('wok_editor.datetime', fake_dt):
                with self.assertRaises(OSError):
                    wok_editor.save_dat_safely(self.demo_path, self.demo_bytes)
        self.assertTrue(preexisting_bak.exists())
        self.assertEqual(preexisting_bak.read_bytes(), b'KEEP_EXISTING_BACKUP')
        preexisting_bak.unlink()
        self.assertEqual(self.demo_path.read_bytes(), original)

        old = os.environ.get("WOKSE_SIMULATE_GAME_RUNNING")
        os.environ["WOKSE_SIMULATE_GAME_RUNNING"] = "1"
        try:
            with self.assertRaises(RuntimeError):
                wok_editor.save_dat_safely(self.demo_path, self.demo_bytes)
        finally:
            if old is None:
                os.environ.pop("WOKSE_SIMULATE_GAME_RUNNING", None)
            else:
                os.environ["WOKSE_SIMULATE_GAME_RUNNING"] = old

    def test_http_server_security_and_roundtrip(self):
        _write_bytes(self.save_dir / "bigbang1data.dat", self.demo_bytes)
        _write_bytes(
            self.save_dir / "configdata.dat",
            wok_editor.encode_dat_bytes(wok_editor.mp_arr([wok_editor.mp_int(i) for i in range(26)])),
        )
        _write_bytes(
            self.save_dir / "StatsAndAchievementdata.dat",
            wok_editor.encode_dat_bytes(wok_editor.mp_arr([wok_editor.mp_int(i) for i in range(26)])),
        )
        srv = wok_editor.create_http_server(save_dir=str(self.save_dir), host="127.0.0.1", port=0)
        port = srv.server_port
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            status, headers, body = _request(conn, "GET", "/")
            self.assertEqual(status, 200)
            lower_headers = {k.lower(): v for k, v in headers.items()}
            self.assertIn("content-security-policy", lower_headers)
            self.assertEqual(lower_headers.get("cross-origin-resource-policy"), "same-origin")
            html_text = body.decode("utf-8", "replace")
            self.assertFalse(build.has_external_url_ref(html_text))
            status, _, _ = _request(conn, "GET", "/", headers={"Host": "evil.example"})
            self.assertEqual(status, 403)
            status, _, _ = _request(conn, "GET", "/api/saves", headers={"Sec-Fetch-Site": "cross-site"})
            self.assertEqual(status, 403)
            status, _, _ = _request(conn, "POST", "/api/save", body=b"{}", headers={"Content-Type": "text/plain"})
            self.assertEqual(status, 415)
            status, _, _ = _request(conn, "POST", "/api/save", body=b"{}", headers={"Content-Type": "application/json"})
            self.assertEqual(status, 403)
            status, _, _ = _request(
                conn,
                "POST",
                "/api/save",
                body=b"{}",
                headers={"Content-Type": "application/json", "Origin": "http://evil.example"},
            )
            self.assertEqual(status, 403)
            status, _, body = _request(conn, "GET", "/api/saves")
            self.assertEqual(status, 200)
            payload = json.loads(body.decode("utf-8"))
            token = payload.get("csrfToken")
            self.assertTrue(token)
            names = []
            if isinstance(payload, dict):
                for key in ("saves", "files", "items"):
                    if isinstance(payload.get(key), list):
                        names = [x.get("name") if isinstance(x, dict) else x for x in payload[key]]
                        break
                if not names and isinstance(payload.get("name"), str):
                    names = [payload["name"]]
            else:
                names = [x.get("name") if isinstance(x, dict) else x for x in payload]
            self.assertIn("bigbang1data.dat", names)
            self.assertNotIn("configdata.dat", names)
            self.assertNotIn("StatsAndAchievementdata.dat", names)
            status, _, body = _request(conn, "GET", "/api/load?name=bigbang1data.dat")
            self.assertEqual(status, 200)
            load_payload = json.loads(body.decode("utf-8"))
            raw = base64.b64decode(load_payload["base64"])
            ses = wok_editor.WokSaveSession(raw)
            ses.apply_preset("rich_epiphany")
            save_body = json.dumps({
                "name": "bigbang1data.dat",
                "base64": base64.b64encode(ses.to_bytes()).decode("ascii"),
                "expectedSha256": load_payload["sha256"],
            }).encode("utf-8")
            before_backups = _backup_files(self.save_dir / "bigbang1data.dat")
            status, _, _ = _request(
                conn,
                "POST",
                "/api/save",
                body=save_body,
                headers={"Content-Type": "application/json", "X-Wok-Token": token},
            )
            self.assertEqual(status, 200)
            after_backups = _backup_files(self.save_dir / "bigbang1data.dat")
            self.assertEqual(len(after_backups), len(before_backups) + 1)

            stale_body = json.dumps({
                "name": "bigbang1data.dat",
                "base64": base64.b64encode(ses.to_bytes()).decode("ascii"),
                "expectedSha256": load_payload["sha256"],
            }).encode("utf-8")
            status, _, _ = _request(
                conn,
                "POST",
                "/api/save",
                body=stale_body,
                headers={"Content-Type": "application/json", "X-Wok-Token": token},
            )
            self.assertEqual(status, 409)
            old = os.environ.get("WOKSE_SIMULATE_GAME_RUNNING")
            os.environ["WOKSE_SIMULATE_GAME_RUNNING"] = "1"
            try:
                status, _, _ = _request(
                    conn,
                    "POST",
                    "/api/save",
                    body=save_body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Wok-Token": token,
                    },
                )
                self.assertEqual(status, 409)
            finally:
                if old is None:
                    os.environ.pop("WOKSE_SIMULATE_GAME_RUNNING", None)
                else:
                    os.environ["WOKSE_SIMULATE_GAME_RUNNING"] = old
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=5)

    def test_real_saves_if_configured(self):
        real_dir = os.environ.get("WOKSE_REAL_SAVES_DIR")
        if not real_dir:
            self.skipTest("WOKSE_REAL_SAVES_DIR not configured")
        root = Path(real_dir)
        dat_files = sorted(root.glob("*.dat"))
        for path in dat_files:
            data = _read_bytes(path)
            node, raw_mp = wok_editor.decode_dat_bytes(data)
            self.assertEqual(wok_editor.encode_msgpack(node), raw_mp, str(path))
        bigbang_files = sorted(root.glob("bigbang*data.dat"))
        self.assertEqual(len(bigbang_files), 24)
        for path in bigbang_files:
            self.assertTrue(_session_validate_ok(_read_bytes(path)), str(path))

    def test_r3_nonminimal_headers_int_bounds_and_cross_process_lock(self):
        import http.client
        import json
        import subprocess
        import sys
        import threading
        import time

        def sha256_bytes(data):
            try:
                return _sha256_bytes(data)
            except NameError:
                import hashlib
                return hashlib.sha256(data).hexdigest()

        # Sol-R3-2: non-minimal MessagePack headers must survive decode/encode.
        raw = (
            b"\xdc\x00\x09"
            + b"\xd9\x01a"
            + b"\xda\x00\x01b"
            + b"\xdb\x00\x00\x00\x01c"
            + b"\xc4\x02\x01\x02"
            + b"\xc5\x00\x02\x03\x04"
            + b"\xc6\x00\x00\x00\x02\x05\x06"
            + b"\xdd\x00\x00\x00\x01\xcd\x00\x05"
            + b"\xde\x00\x01\xd9\x01k\xd2\x00\x00\x00\x07"
            + b"\xdf\x00\x00\x00\x01\xcc\x01\xce\x00\x00\x00\x02"
        )
        self.assertEqual(wok_editor.encode_msgpack(wok_editor.decode_msgpack(raw)), raw)

        ast, _ = wok_editor.decode_dat_bytes(self.demo_bytes)
        ast.tag = "arr32"
        ast.val[10].tag = "str16"
        ast.val[14].tag = "u32"
        custom_dat = wok_editor.encode_dat_bytes(ast)
        _, custom_mp = wok_editor.decode_dat_bytes(custom_dat)
        re_dat = wok_editor.WokSaveSession(custom_dat).to_bytes()
        _, re_mp = wok_editor.decode_dat_bytes(re_dat)
        self.assertEqual(re_mp, custom_mp)

        # Sol-R3-3: integer bounds must be rejected without touching the target.
        with self.assertRaises(ValueError):
            wok_editor.mp_int(1 << 64)
        with self.assertRaises(ValueError):
            wok_editor.mp_int(-(1 << 63) - 1)

        before = _read_bytes(self.demo_path)
        for money in ("18446744073709551616", "-9223372036854775809"):
            try:
                rc = wok_editor.main(["edit", str(self.demo_path), "--money", money])
            except (ValueError, SystemExit):
                rc = None
            else:
                self.assertNotEqual(rc, 0)
            self.assertEqual(_read_bytes(self.demo_path), before)

        # Sol-R3-1: cross-process serialization of save_dat_safely(...).
        tmp = self.save_dir
        payload_a = tmp / "r3_payload_a.dat"
        payload_b = tmp / "r3_payload_b.dat"
        target = self.demo_path
        orig_sha = sha256_bytes(_read_bytes(target))
        _write_bytes(tmp / "r3_money_a.dat", self.demo_bytes)
        _write_bytes(tmp / "r3_money_b.dat", self.demo_bytes)
        base_args = ["edit", str(tmp / "r3_money_a.dat"), "--money", "11111"]
        self.assertEqual(wok_editor.main(base_args), 0)
        base_args_b = ["edit", str(tmp / "r3_money_b.dat"), "--money", "22222"]
        self.assertEqual(wok_editor.main(base_args_b), 0)
        bytes_a = _read_bytes(tmp / "r3_money_a.dat")
        bytes_b = _read_bytes(tmp / "r3_money_b.dat")
        payload_a.write_bytes(bytes_a)
        payload_b.write_bytes(bytes_b)
        _write_bytes(tmp / "r3_money_a.dat", self.demo_bytes)
        _write_bytes(tmp / "r3_money_b.dat", self.demo_bytes)

        ready_a = tmp / "r3_ready_a"
        ready_b = tmp / "r3_ready_b"
        start_file = tmp / "r3_start"
        for p in (ready_a, ready_b, start_file):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

        worker_code = r'''
import sys, time
from pathlib import Path
import wok_editor

target = Path(sys.argv[1])
payload = Path(sys.argv[2]).read_bytes()
ready = Path(sys.argv[3])
start = Path(sys.argv[4])
expected = sys.argv[5]
ready.write_text("ready", encoding="utf-8")
while not start.exists():
    time.sleep(0.002)
try:
    wok_editor.save_dat_safely(target, payload, expected_sha256=expected)
except Exception as exc:
    sys.stderr.write(str(exc) + "\n")
    sys.exit(1)
sys.stdout.write("OK\n")
sys.exit(0)
'''
        cwd = str(Path(wok_editor.__file__).resolve().parent)
        cmd_a = [sys.executable, "-c", worker_code, str(target), str(payload_a), str(ready_a), str(start_file), orig_sha]
        cmd_b = [sys.executable, "-c", worker_code, str(target), str(payload_b), str(ready_b), str(start_file), orig_sha]
        proc_a = subprocess.Popen(cmd_a, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        proc_b = subprocess.Popen(cmd_b, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 10
            while time.time() < deadline and not (ready_a.exists() and ready_b.exists()):
                time.sleep(0.01)
            self.assertTrue(ready_a.exists() and ready_b.exists())
            start_file.write_text("go", encoding="utf-8")
            out_a, err_a = proc_a.communicate(timeout=15)
            out_b, err_b = proc_b.communicate(timeout=15)
        finally:
            for proc in (proc_a, proc_b):
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate()

        results = [
            (proc_a.returncode, out_a + err_a, bytes_a),
            (proc_b.returncode, out_b + err_b, bytes_b),
        ]
        self.assertEqual(sorted(p[0] for p in results), [0, 1])
        winners = [payload for code, output, payload in results if code == 0]
        losers = [output for code, output, payload in results if code == 1]
        self.assertEqual(len(winners), 1)
        self.assertEqual(len(losers), 1)
        self.assertIn("sha256 mismatch", losers[0].lower())
        self.assertEqual(_read_bytes(target), winners[0])

        _write_bytes(target, self.demo_bytes)

        # Sol-R5-1: real two-process edit race, serialized by src_sha256 check.
        cli_ready_a = tmp / "cli_ready_a"
        cli_ready_b = tmp / "cli_ready_b"
        cli_start = tmp / "cli_start"
        child_script = r'''
import sys, time
from pathlib import Path
import wok_editor

ready = Path(sys.argv[2])
start = Path(sys.argv[3])
target = sys.argv[1]
money = sys.argv[4]
_orig_apply_edit = wok_editor._apply_edit

def _gated_apply_edit(session, args):
    result = _orig_apply_edit(session, args)
    ready.write_text("ready", encoding="utf-8")
    while not start.exists():
        time.sleep(0.002)
    return result

wok_editor._apply_edit = _gated_apply_edit
sys.exit(wok_editor.main(["edit", target, "--money", money]))
'''
        proc_a = subprocess.Popen([
            sys.executable, "-c", child_script, str(target), str(cli_ready_a), str(cli_start), "777771"
        ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=cwd)
        proc_b = subprocess.Popen([
            sys.executable, "-c", child_script, str(target), str(cli_ready_b), str(cli_start), "777772"
        ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=cwd)
        deadline = time.time() + 15
        while not (cli_ready_a.exists() and cli_ready_b.exists()):
            if time.time() > deadline:
                proc_a.kill()
                proc_b.kill()
                self.fail("timed out waiting for gated edit processes")
            time.sleep(0.01)
        cli_start.write_text("go", encoding="utf-8")
        out_a, _ = proc_a.communicate(timeout=15)
        out_b, _ = proc_b.communicate(timeout=15)
        self.assertEqual(sorted([proc_a.returncode, proc_b.returncode]), [0, 2])
        loser_output = out_a if proc_a.returncode else out_b
        self.assertIn("sha256 mismatch", loser_output.lower())
        winning_money = 777771 if proc_a.returncode == 0 else 777772
        self.assertEqual(
            wok_editor.WokSaveSession(_read_bytes(target)).summary()["m_Money"],
            winning_money,
        )
        _write_bytes(target, self.demo_bytes)

        # Sol-R3-1: two HTTP servers sharing save_dir race POST /api/save.
        srv1 = wok_editor.create_http_server(save_dir=str(tmp), host="127.0.0.1", port=0)
        srv2 = wok_editor.create_http_server(save_dir=str(tmp), host="127.0.0.1", port=0)
        thread1 = threading.Thread(target=srv1.serve_forever, daemon=True)
        thread2 = threading.Thread(target=srv2.serve_forever, daemon=True)
        thread1.start()
        thread2.start()

        def request(port, method, path, body=None, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            try:
                conn.request(method, path, body=body, headers=headers or {})
                resp = conn.getresponse()
                data = resp.read()
                return resp.status, data
            finally:
                conn.close()

        try:
            ports = []
            for srv in (srv1, srv2):
                if hasattr(srv, "server_address"):
                    ports.append(srv.server_address[1])
                elif hasattr(srv, "socket"):
                    ports.append(srv.socket.getsockname()[1])
                else:
                    raise AssertionError("server has no bound address")
            port1, port2 = ports

            def get_json(port, path):
                status, data = request(port, "GET", path)
                self.assertEqual(status, 200)
                return json.loads(data.decode("utf-8"))

            saves1 = get_json(port1, "/api/saves")
            saves2 = get_json(port2, "/api/saves")
            csrf1 = saves1.get("csrfToken") or saves1.get("csrf_token")
            csrf2 = saves2.get("csrfToken") or saves2.get("csrf_token")
            self.assertTrue(csrf1)
            self.assertTrue(csrf2)
            load1 = get_json(port1, "/api/load?name=bigbang1data.dat")
            load2 = get_json(port2, "/api/load?name=bigbang1data.dat")
            expected_sha = load1.get("sha256") or load2.get("sha256")
            self.assertTrue(expected_sha)

            results = []
            barrier = threading.Barrier(2)

            def post_save(port, csrf, payload):
                body = json.dumps({
                    "name": "bigbang1data.dat",
                    "base64": base64.b64encode(payload).decode("ascii"),
                    "csrfToken": csrf,
                    "expectedSha256": expected_sha,
                }).encode("utf-8")
                barrier.wait(timeout=10)
                status, data = request(
                    port,
                    "POST",
                    "/api/save",
                    body=body,
                    headers={"Content-Type": "application/json", "X-Wok-Token": csrf},
                )
                results.append((status, payload, data))

            t1 = threading.Thread(target=post_save, args=(port1, csrf1, bytes_a))
            t2 = threading.Thread(target=post_save, args=(port2, csrf2, bytes_b))
            t1.start()
            t2.start()
            t1.join(timeout=15)
            t2.join(timeout=15)
            self.assertFalse(t1.is_alive())
            self.assertFalse(t2.is_alive())
            self.assertEqual(sorted(status for status, _, _ in results), [200, 409])
            winner_payload = next(payload for status, payload, _ in results if status == 200)
            self.assertEqual(_read_bytes(tmp / "bigbang1data.dat"), winner_payload)
        finally:
            for srv in (srv1, srv2):
                try:
                    srv.shutdown()
                except Exception:
                    pass
                try:
                    srv.server_close()
                except Exception:
                    pass
            thread1.join(timeout=5)
            thread2.join(timeout=5)


    def test_r6_nil_containers_int_flags_and_shared_lock_file(self):
        ast, _ = wok_editor.decode_dat_bytes(self.demo_bytes)
        hero = next(ch for ch in ast.val[3].val if str(ch.val[1].val) == "9001")
        for k in (15, 16, 18, 19, 20, 22):
            hero.val[k] = wok_editor.MPNode("nil", None)
        for k in (6, 19, 20, 21):
            ast.val[k] = wok_editor.MPNode("nil", None)
        ast.val[7] = wok_editor.MPNode("str", "STAGE_01_0&2")
        nil_dat = wok_editor.encode_dat_bytes(ast)

        ses0 = wok_editor.WokSaveSession(nil_dat)
        ses0.remove_kungfu("9001", "999999")
        ses0.remove_trait("9001", "999999")
        ses0.remove_item("888888")
        rt0 = ses0.to_bytes()
        ast0, _ = wok_editor.decode_dat_bytes(rt0)
        hero0 = next(ch for ch in ast0.val[3].val if str(ch.val[1].val) == "9001")
        for k in (15, 16, 18, 19, 20, 22):
            self.assertEqual(hero0.val[k].tag, "nil")
        for k in (6, 19, 20, 21):
            self.assertEqual(ast0.val[k].tag, "nil")

        ses = wok_editor.WokSaveSession(nil_dat)
        ses.set_char_basic("9001", hero_name="무영검")
        ses.set_char_stat("9001", "2001", 45)
        kf_id = next(iter(wok_editor.load_catalog()["kungfu"]))
        ses.upsert_kungfu("9001", kf_id, lv=10, prof=9999, in_battle=True)
        trait_id = next(iter(wok_editor.load_catalog()["traits"]))
        ses.add_trait("9001", trait_id)
        ses.set_equip_trait("9001", 1, trait_id)
        item_id = next(iter(wok_editor.load_catalog()["items"]))
        ses.set_equip("9001", 0, item_id)
        ses.set_item(item_id, 7)
        ses.set_party("105", in_full_team=True, in_follow=True)
        ses.set_int_flag("tutorial_done", 5)
        out_bytes = ses.to_bytes()
        ses2 = wok_editor.WokSaveSession(out_bytes)
        self.assertEqual(ses2.summary()["heroName"], "무영검")
        self.assertTrue(any(k["id"] == str(kf_id) for k in ses2.get_character("9001")["kungfu"]))
        self.assertIn(str(trait_id), ses2.get_character("9001")["traits"])
        self.assertEqual(ses2.get_character("9001")["equipSlots"], [str(item_id), "0", "0"])
        self.assertEqual(_item_amount(ses2, item_id), 7)
        self.assertIn("105", ses2.summary()["party"])
        self.assertIn("105", ses2.summary()["follow"])
        self.assertIn({"key": "tutorial_done", "value": 5, "source": "flag"}, ses2.list_flags())
        self.assertEqual(ses2._as_str(ses2.root.val[7]), "STAGE_01_0&2")

        nil_path = self.save_dir / "bigbang2data.dat"
        nil_path.write_bytes(nil_dat)
        self.assertEqual(
            wok_editor.main([
                "edit",
                str(nil_path),
                "--set-int-flag",
                "tutorial_done=9",
                "--set-int-flag",
                "boss_clear=1",
            ]),
            0,
        )
        ses3 = _load_session_from_path(nil_path)
        self.assertIn({"key": "tutorial_done", "value": 9, "source": "flag"}, ses3.list_flags())
        self.assertIn({"key": "boss_clear", "value": 1, "source": "flag"}, ses3.list_flags())
        self.assertEqual(ses3._as_str(ses3.root.val[7]), "STAGE_01_0&2")
        self.assertEqual(list(self.save_dir.glob("*.woklock")), [])

    def test_r7a_api_save_requires_expected_sha256(self):
        ses = wok_editor.WokSaveSession(self.demo_bytes)
        ses.set_world(money=123456)
        bytes_a = ses.to_bytes()
        ses = wok_editor.WokSaveSession(self.demo_bytes)
        ses.set_world(money=654321)
        bytes_b = ses.to_bytes()

        srv = wok_editor.create_http_server(save_dir=str(self.save_dir), host="127.0.0.1", port=0)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
            st, _, body = _request(conn, "GET", "/api/saves")
            self.assertEqual(st, 200)
            token = json.loads(body.decode("utf-8"))["csrfToken"]
            headers = {"Content-Type": "application/json", "X-Wok-Token": token}
            slot_name = "bigbang1data.dat"
            def post(raw, extra=None):
                payload = {"name": slot_name, "base64": base64.b64encode(raw).decode("ascii")}
                if extra:
                    payload.update(extra)
                c = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
                try:
                    return _request(c, "POST", "/api/save", body=json.dumps(payload).encode("utf-8"), headers=headers)[0]
                finally:
                    c.close()
            for extra in ({}, {"force": True}, {"expectedSha256": None}, {"expectedSha256": ""}, {"expectedSha256": "not-a-valid-sha256"}, {"expectedSha256": 12345}):
                self.assertEqual(post(bytes_a, extra), 400)
            self.assertEqual(post(bytes_a), 400)
            self.assertEqual(post(bytes_b), 400)
            self.assertEqual(_read_bytes(self.demo_path), self.demo_bytes)
            self.assertEqual(_backup_files(self.demo_path), [])

            slot_name = "bigbang9data.dat"
            results = []
            res_lock = threading.Lock()
            barrier = threading.Barrier(2)
            def race(raw):
                conn2 = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
                try:
                    barrier.wait()
                    payload = {"name": slot_name, "base64": base64.b64encode(raw).decode("ascii")}
                    st2 = _request(conn2, "POST", "/api/save", body=json.dumps(payload).encode("utf-8"), headers=headers)[0]
                    with res_lock:
                        results.append((st2, raw))
                finally:
                    conn2.close()
            threads = [threading.Thread(target=race, args=(raw,)) for raw in (bytes_a, bytes_b)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
            self.assertEqual(sorted(st for st, _ in results), [200, 400])
            slot_path = self.save_dir / "bigbang9data.dat"
            self.assertEqual(_backup_files(slot_path), [])
            self.assertEqual(_read_bytes(slot_path), next(raw for st, raw in results if st == 200))

            digest = _sha256_bytes(_read_bytes(slot_path)).upper()
            payload = {"name": "bigbang9data.dat", "base64": base64.b64encode(bytes_a).decode("ascii"), "expectedSha256": digest}
            self.assertEqual(_request(conn, "POST", "/api/save", body=json.dumps(payload).encode("utf-8"), headers=headers)[0], 200)
            self.assertEqual(len(_backup_files(slot_path)), 1)
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=5)

    def test_r7b_rejects_map_containers(self):
        import os
        import tempfile

        def _put(root, node, idx, val):
            node.val[idx] = val
            node.raw = None
            return root

        load_mutators = (
            lambda ast: wok_editor.MPNode(
                "map16",
                [(wok_editor.mp_int(i), wok_editor.MPNode("nil", None)) for i in range(54)],
            ),
            lambda ast: _put(
                ast,
                ast,
                3,
                wok_editor.MPNode("map", [(wok_editor.MPNode("str", "k"), ast.val[3].val[0])]),
            ),
            lambda ast: _put(ast, ast.val[3].val[0], 15, wok_editor.MPNode("map", [])),
            lambda ast: _put(ast, ast, 19, wok_editor.MPNode("map", [])),
            lambda ast: _put(ast, ast, 6, wok_editor.MPNode("map", [])),
            lambda ast: _put(ast, ast, 7, wok_editor.MPNode("map", [])),
            lambda ast: _put(ast, ast.val[3].val[0], 15, wok_editor.mp_arr([wok_editor.mp_int(123)])),
            lambda ast: _put(ast, ast, 20, wok_editor.mp_arr([wok_editor.mp_int(9001)])),
            lambda ast: _put(
                ast,
                ast,
                19,
                wok_editor.mp_arr(
                    [
                        wok_editor.mp_arr(
                            [
                                wok_editor.MPNode("str", "10001"),
                                wok_editor.MPNode("str", "bad"),
                            ]
                        )
                    ]
                ),
            ),
            lambda ast: _put(
                ast,
                ast,
                6,
                wok_editor.mp_arr(
                    [
                        wok_editor.mp_arr(
                            [wok_editor.mp_int(1), wok_editor.mp_int(2)]
                        )
                    ]
                ),
            ),
        )
        for fn in load_mutators:
            ast, _ = wok_editor.decode_dat_bytes(self.demo_bytes)
            ast.raw = None
            ast.val[3].raw = None
            ast.val[3].val[0].raw = None
            bad_dat = wok_editor.encode_dat_bytes(fn(ast))
            with self.assertRaises(ValueError):
                wok_editor.WokSaveSession(bad_dat)
            with tempfile.TemporaryDirectory() as td:
                bad_path = os.path.join(td, "bad.dat")
                with open(bad_path, "wb") as f:
                    f.write(bad_dat)
                self.assertEqual(
                    wok_editor.main(["validate", str(bad_path), "--json"]), 2
                )

        post_mutators = (
            lambda ses: _put(ses, ses.root.val[3].val[0], 15, wok_editor.MPNode("map", [])),
            lambda ses: _put(ses, ses.root, 19, wok_editor.MPNode("map", [])),
            lambda ses: _put(ses, ses.root, 7, wok_editor.MPNode("map", [])),
            lambda ses: ses.root.val[3].val[0].val[15].val.append(wok_editor.mp_int(1)),
            lambda ses: ses.root.val[6].val.append(wok_editor.MPNode("map", [])),
        )
        for mfn in post_mutators:
            ses = wok_editor.WokSaveSession(self.demo_bytes)
            mfn(ses)
            self.assertFalse(ses.validate()["ok"])
            with self.assertRaises(ValueError):
                ses.to_bytes()

    def test_r8a_rejects_invalid_scalar_field_tags(self):
        def _put(root, node, idx, val):
            node.val[idx] = val
            node.raw = None
            return root

        mutators = [
            lambda a: _put(a, a, 14, wok_editor.MPNode("str", "broken")),
            lambda a: _put(a, a, 15, wok_editor.MPNode("nil", None)),
            lambda a: _put(a, a, 16, wok_editor.MPNode("str", "bad")),
            lambda a: _put(a, a, 17, wok_editor.mp_int(1)),
            lambda a: _put(a, a, 24, wok_editor.MPNode("bool", True)),
            lambda a: _put(a, a, 33, wok_editor.MPNode("str", "bad")),
            lambda a: _put(a, a, 8, wok_editor.mp_int(1001)),
            lambda a: _put(a, a.val[3].val[0], 6, wok_editor.mp_int(100)),
            lambda a: _put(a, a.val[3].val[0], 9, wok_editor.MPNode("str", "99")),
            lambda a: _put(a, a.val[3].val[0], 25, wok_editor.mp_int(123)),
        ]

        first_bad = None
        for fn in mutators:
            ast, _ = wok_editor.decode_dat_bytes(self.demo_bytes)
            ast.raw = None
            ast.val[3].raw = None
            ast.val[3].val[0].raw = None
            bad_dat = wok_editor.encode_dat_bytes(fn(ast))
            if first_bad is None:
                first_bad = bad_dat

            ses = wok_editor.WokSaveSession(bad_dat)
            self.assertFalse(ses.validate()["ok"])
            with self.assertRaises(ValueError):
                ses.to_bytes()

            with self.assertRaises(ValueError):
                wok_editor.save_dat_safely(self.demo_path, bad_dat, force=True)
            self.assertEqual(_read_bytes(self.demo_path), self.demo_bytes)

        with tempfile.TemporaryDirectory() as td:
            bad_path = os.path.join(td, "bad.dat")
            with open(bad_path, "wb") as f:
                f.write(first_bad)
            self.assertEqual(wok_editor.main(["validate", str(bad_path), "--json"]), 2)

        b64_bad = base64.b64encode(first_bad).decode("ascii")
        srv = wok_editor.create_http_server(save_dir=str(self.save_dir), host="127.0.0.1", port=0)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
            try:
                status, _, body = _request(c, "GET", "/api/saves")
            finally:
                c.close()
            self.assertEqual(status, 200)
            token = json.loads(body.decode("utf-8"))["csrfToken"]
            headers = {"Content-Type": "application/json", "X-Wok-Token": token}

            def _post(obj):
                c = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
                try:
                    return _request(c, "POST", "/api/save", body=json.dumps(obj).encode("utf-8"), headers=headers)[0]
                finally:
                    c.close()

            self.assertEqual(_post({"name": "bigbang9data.dat", "base64": b64_bad}), 400)
            self.assertFalse((self.save_dir / "bigbang9data.dat").exists())
            self.assertEqual(
                _post({
                    "name": "bigbang1data.dat",
                    "base64": b64_bad,
                    "expectedSha256": _sha256_bytes(self.demo_bytes),
                }),
                400,
            )
            self.assertEqual(_read_bytes(self.demo_path), self.demo_bytes)
            self.assertEqual(_backup_files(self.demo_path), [])
        finally:
            srv.shutdown()
            srv.server_close()
            th.join(timeout=10)

    def test_r9_case_alias_edit_conflict(self):
        import os
        import unittest.mock
        from pathlib import Path

        alias_out = self.save_dir / 'BIGBANG1DATA.DAT'
        other_out = self.save_dir / 'bigbang2data.dat'

        if not alias_out.exists():
            alias_out.write_bytes(self.demo_bytes)
            self.assertFalse(os.path.samefile(alias_out, self.demo_path))
            with unittest.mock.patch('wok_editor.os.path.normcase', side_effect=str.lower):
                self.assertFalse(wok_editor._same_save_path(alias_out, self.demo_path))
                with self.assertRaises(SystemExit):
                    wok_editor.main(['edit', str(self.demo_path), '-o', str(alias_out), '--money', '123456'])
                c0 = wok_editor.WokSaveSession(self.demo_bytes)
                c0.set_world(money=123456)
                c0_bytes = c0.to_bytes()
                with self.assertRaises(FileExistsError):
                    wok_editor.save_dat_safely(self.demo_path, c0_bytes, output_path=alias_out, force=False)
                self.assertEqual(_read_bytes(alias_out), self.demo_bytes)
                self.assertEqual(_backup_files(alias_out), [])
            alias_out.unlink()
            lock_p = self.save_dir / 'BIGBANG1DATA.DAT.lock'
            try:
                lock_p.unlink()
            except FileNotFoundError:
                pass

        with unittest.mock.patch('wok_editor.os.path.normcase', side_effect=str.lower):
            with unittest.mock.patch('wok_editor.os.path.samefile', return_value=False):
                self.assertFalse(wok_editor._same_save_path(alias_out, self.demo_path))

        with unittest.mock.patch('wok_editor.os.path.normcase', side_effect=str.lower):
            with wok_editor._save_target_lock(self.demo_path):
                pass
            with wok_editor._save_target_lock(alias_out):
                pass
            self.assertIs(
                wok_editor._SAVE_LOCKS[os.path.abspath(str(self.demo_path)).lower()],
                wok_editor._SAVE_LOCKS[os.path.abspath(str(alias_out)).lower()],
            )
            lock_path = self.save_dir / 'BIGBANG1DATA.DAT.lock'
            if lock_path.exists() and not alias_out.exists():
                try:
                    lock_path.unlink()
                except FileNotFoundError:
                    pass

        ci_samefile = lambda p1, p2: os.path.abspath(str(p1)).lower() == os.path.abspath(str(p2)).lower()
        with unittest.mock.patch('wok_editor.os.path.samefile', side_effect=ci_samefile):
            self.assertTrue(wok_editor._same_save_path(alias_out, self.demo_path))
            self.assertFalse(wok_editor._same_save_path(other_out, self.demo_path))

        ext_ses = wok_editor.WokSaveSession(self.demo_bytes)
        ext_ses.set_world(money=777777)
        ext_bytes = ext_ses.to_bytes()
        orig_sha = _sha256_bytes(self.demo_bytes)
        orig_save = wok_editor.save_dat_safely
        seen = []

        def wrapped_save(target_path, new_bytes, output_path=None, force=False, expected_sha256=None, require_expected_sha256=False, source_sha256=None):
            seen.append({
                'expected_sha256': expected_sha256,
                'source_sha256': source_sha256,
                'force': force,
                'output_path': output_path,
            })
            self.demo_path.write_bytes(ext_bytes)
            eff_out = self.demo_path if (output_path is not None and Path(output_path) == alias_out and not alias_out.exists()) else output_path
            return orig_save(
                target_path,
                new_bytes,
                output_path=eff_out,
                force=force,
                expected_sha256=expected_sha256,
                require_expected_sha256=require_expected_sha256,
                source_sha256=source_sha256,
            )

        with unittest.mock.patch('wok_editor.os.path.normcase', side_effect=str.lower):
            with unittest.mock.patch('wok_editor.os.path.samefile', side_effect=ci_samefile):
                with unittest.mock.patch('wok_editor.save_dat_safely', side_effect=wrapped_save):
                    rc = wok_editor.main(['edit', str(self.demo_path), '-o', str(alias_out), '--force', '--money', '888888'])
                    self.assertEqual(rc, 2)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]['expected_sha256'], orig_sha)
        self.assertEqual(seen[0]['source_sha256'], orig_sha)
        self.assertEqual(_read_bytes(self.demo_path), ext_bytes)
        self.assertEqual(_backup_files(self.demo_path), [])

        cand_ses = wok_editor.WokSaveSession(self.demo_bytes)
        cand_ses.set_world(money=999999)
        cand_bytes = cand_ses.to_bytes()
        with self.assertRaises(RuntimeError):
            orig_save(
                self.demo_path,
                cand_bytes,
                output_path=self.demo_path,
                force=True,
                expected_sha256=None,
                source_sha256=orig_sha,
            )
        self.assertEqual(_read_bytes(self.demo_path), ext_bytes)
        self.assertEqual(_backup_files(self.demo_path), [])

    def test_r11_fallback_build_editor_html_inlines_scripts_safely(self):
        import shutil
        import tempfile
        from pathlib import Path
        import unittest.mock

        src_dir = Path(wok_editor.__file__).resolve().parent / "src"
        with tempfile.TemporaryDirectory() as td:
            tmp_src = Path(td) / "src"
            tmp_src.mkdir()
            shutil.copy2(src_dir / "editor-page.html", tmp_src / "editor-page.html")
            for script_name in wok_editor.SCRIPT_ORDER:
                shutil.copy2(src_dir / script_name, tmp_src / script_name)

            with open(tmp_src / "editor-ui.js", "a", encoding="utf-8") as handle:
                handle.write("\n// literal </script> marker\n")

            with unittest.mock.patch.object(wok_editor, "SCRIPT_DIR", Path(td)):
                html = wok_editor._build_editor_html().decode("utf-8")

        self.assertNotIn("<!-- BUNDLE_SCRIPTS_START -->", html)
        self.assertNotIn("<!-- BUNDLE_SCRIPTS_END -->", html)
        self.assertNotIn('<script src="', html.lower())
        self.assertIn("WokCatalog", html)
        self.assertIn("WokMsgPack", html)
        self.assertIn("WokEditorCore", html)
        self.assertIn("WokEditorUI", html)
        self.assertIn("literal <\\/script> marker", html)

    def test_r12_presets_validation_bounds_http_and_reparse(self):
        import base64
        import gzip
        import json
        import os
        import socket
        import stat
        import threading
        import time
        import types
        import unittest.mock
        from pathlib import Path

        ses = wok_editor.WokSaveSession(self.demo_bytes)
        ses.root.raw = None
        ses.root.val[20].raw = None
        ses.root.val[3].raw = None
        ses.root.val[3].val[0].raw = None
        ses.root.val[3].val[0].val[15].raw = None
        ses.root.val[9] = wok_editor.MPNode("str", "9777")
        ses.root.val[20].val[0] = wok_editor.MPNode("str", "9777")
        ses.root.val[3].val[0].val[1] = wok_editor.MPNode("str", "9777")
        ses.root.val[3].val[0].val[15].val.append(
            wok_editor.MPNode("str", "10999,1,0,10,True")
        )
        ses.root.val[21] = wok_editor.MPNode(
            "arr", [wok_editor.MPNode("str", "105")]
        )
        base_custom = ses.to_bytes()

        presets = [
            "rich_epiphany",
            "hero_max_growth",
            "hero_six_attributes",
            "hero_all_mastery",
            "master_all_kungfu",
            "party_recover_boost",
        ]
        for preset in presets:
            s = wok_editor.WokSaveSession(base_custom)
            if preset == "party_recover_boost":
                char312_before = next(
                    c for c in s.root.val[3].val if c.val[1].val == "312"
                )
                before_c11 = char312_before.val[11].val
                before_c13 = char312_before.val[13].val
            s.apply_preset(preset)
            result = s.validate()
            self.assertTrue(result["ok"], result)
            self.assertIn(
                "10999,1,0,10,True",
                [n.val for n in s.root.val[3].val[0].val[15].val],
            )
            if preset == "party_recover_boost":
                char312 = next(c for c in s.root.val[3].val if c.val[1].val == "312")
                char9777 = next(c for c in s.root.val[3].val if c.val[1].val == "9777")
                char105 = next(c for c in s.root.val[3].val if c.val[1].val == "105")
                self.assertEqual(char312.val[11].val, before_c11)
                self.assertEqual(char312.val[13].val, before_c13)
                self.assertGreaterEqual(char9777.val[13].val, 100)
                self.assertGreaterEqual(char105.val[11].val, 100)
                self.assertGreaterEqual(char105.val[13].val, 100)

        invalid_cases = []

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[19].raw = None
        s.root.val[19].val.append(
            wok_editor.MPNode(
                "arr", [wok_editor.MPNode("str", ""), wok_editor.mp_int(1)]
            )
        )
        invalid_cases.append(s)

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[3].raw = None
        s.root.val[3].val[0].raw = None
        s.root.val[3].val[0].val[15].raw = None
        s.root.val[3].val[0].val[15].val.append(
            wok_editor.MPNode("str", "1001,1,0,0")
        )
        invalid_cases.append(s)

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[3].raw = None
        s.root.val[3].val[0].raw = None
        s.root.val[3].val[0].val[22] = wok_editor.MPNode(
            "arr", [wok_editor.MPNode("str", "0|101")]
        )
        invalid_cases.append(s)

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[3].raw = None
        s.root.val[3].val[0].raw = None
        s.root.val[3].val[0].val[22] = wok_editor.MPNode(
            "arr", [wok_editor.MPNode("str", "10|101")]
        )
        invalid_cases.append(s)

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[21].raw = None
        s.root.val[21].val.append(wok_editor.MPNode("str", s.root.val[9].val))
        invalid_cases.append(s)

        for case in invalid_cases:
            self.assertFalse(case.validate()["ok"])

        with self.assertRaises(ValueError):
            wok_editor.decode_msgpack(b"\x91" * 66 + b"\x00")
        with self.assertRaises(ValueError):
            wok_editor.decode_msgpack(b"\xdd\xff\xff\xff\xff")
        with self.assertRaises(ValueError):
            compressed = b"COMPRESSED:" + base64.b64encode(
                gzip.compress(b"\x00" * (65 * 1024 * 1024), compresslevel=1)
            )
            wok_editor.decode_dat_bytes(compressed)

        srv = wok_editor.create_http_server(save_dir=str(self.save_dir), host="127.0.0.1", port=0)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            conn = socket.create_connection(("127.0.0.1", srv.server_port), timeout=5)
            try:
                conn.sendall(
                    b"GET /api/saves HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\n"
                    b"Connection: close\r\n\r\n"
                )
                data = b""
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
            finally:
                conn.close()
            body = data.split(b"\r\n\r\n", 1)[1]
            token = json.loads(body.decode("utf-8"))["csrfToken"]

            for content_length, expected in [(-5, b" 400 "), (60000000, b" 413 ")]:
                conn = socket.create_connection(("127.0.0.1", srv.server_port), timeout=5)
                try:
                    request = (
                        "POST /api/save HTTP/1.1\r\n"
                        "Host: 127.0.0.1\r\n"
                        "Content-Type: application/json\r\n"
                        f"X-Wok-Token: {token}\r\n"
                        f"Content-Length: {content_length}\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode("ascii")
                    conn.sendall(request)
                    response = b""
                    while True:
                        chunk = conn.recv(65536)
                        if not chunk:
                            break
                        response += chunk
                finally:
                    conn.close()
                self.assertIn(expected, response.split(b"\r\n", 1)[0])
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=5)

        jdir = self.save_dir / "jparent"
        jdir.mkdir()
        child = jdir / "bigbang1data.dat"
        jdir_abs = os.path.abspath(str(jdir))
        real_lstat = os.lstat

        def fake_lstat(path, *args, **kwargs):
            if os.path.abspath(str(path)) == jdir_abs:
                return types.SimpleNamespace(
                    st_mode=stat.S_IFDIR | 0o755,
                    st_nlink=1,
                    st_file_attributes=0x410,
                )
            return real_lstat(path, *args, **kwargs)

        with unittest.mock.patch("wok_editor.os.lstat", side_effect=fake_lstat):
            with self.assertRaises(PermissionError):
                wok_editor.assert_no_symlinks(child)

    def test_r13_fmtnum_single_handle_bounded_read_and_ext_rejection(self):
        import base64
        import ctypes
        import gzip
        import types
        wintypes = types.SimpleNamespace(DWORD=ctypes.c_ulong)
        import unittest.mock

        s = wok_editor.WokSaveSession(self.demo_bytes)
        rows = s.root.val[3].val[0].val[18].val
        target = None
        for row in rows:
            if str(getattr(row, "val", "")).startswith("2001,"):
                target = row
                break
        if target is None:
            target = wok_editor.MPNode("str", "2001,,-0.00001,0,0,0,0,0,0")
            rows.append(target)
        target.val = "2001,,-0.00001,0,0,0,0,0,0"
        target.raw = None
        s.apply_preset("hero_six_attributes")
        rows = s.root.val[3].val[0].val[18].val
        found = [getattr(row, "val", row) for row in rows if str(getattr(row, "val", row)).startswith("2001,")]
        self.assertEqual(found, ["2001,,0,40,0,0,0,0,0"])

        p = self.save_dir / "bigbang9data.dat"
        p.write_bytes(self.demo_bytes)

        total_returned = 0

        def fake_read(fd, n):
            nonlocal total_returned
            data = b"A" * min(n, 65536)
            total_returned += len(data)
            return data

        with unittest.mock.patch("wok_editor.os.read", side_effect=fake_read):
            with self.assertRaises(ValueError):
                wok_editor._read_save_bytes(p)
        self.assertEqual(total_returned, wok_editor.MAX_COMPRESSED_DAT_BYTES + 1)

        def run_windows_case(final_path_value, file_size, expected_exc):
            class Info(ctypes.Structure):
                _fields_ = [
                    ("dwFileAttributes", wintypes.DWORD),
                    ("nNumberOfLinks", wintypes.DWORD),
                    ("nFileSizeHigh", wintypes.DWORD),
                    ("nFileSizeLow", wintypes.DWORD),
                ]

            kernel32 = unittest.mock.Mock()
            closed = []
            opened = []
            read_sizes = []

            def create_file_w(path, access, share, sec, creation, flags, template):
                self.assertEqual(access, 0x80000000)
                self.assertNotEqual(flags & 0x00200000, 0)
                opened.append(path)
                return 777

            def get_info(h, info_ptr):
                self.assertEqual(h, 777)
                info_obj = info_ptr._obj
                info_obj.dwFileAttributes = 0x80
                info_obj.nNumberOfLinks = 1
                info_obj.nFileSizeHigh = 0
                info_obj.nFileSizeLow = file_size
                return 1

            def get_final(h, buf, cap, flags):
                self.assertEqual(h, 777)
                val = opened[0] if final_path_value is None else final_path_value
                buf.value = val
                return len(val)

            def read_file(h, buf, to_read, nread_ptr, overlapped):
                self.assertEqual(h, 777)
                nread_ptr._obj.value = int(to_read)
                read_sizes.append(int(to_read))
                return 1

            def close_handle(h):
                self.assertEqual(h, 777)
                closed.append(h)
                return 1

            kernel32.CreateFileW.side_effect = create_file_w
            kernel32.GetFileInformationByHandle.side_effect = get_info
            kernel32.GetFinalPathNameByHandleW.side_effect = get_final
            kernel32.ReadFile.side_effect = read_file
            kernel32.CloseHandle.side_effect = close_handle

            with unittest.mock.patch.object(wok_editor.os, "name", "nt"), \
                    unittest.mock.patch("wok_editor.assert_no_symlinks", lambda *_: None), \
                    unittest.mock.patch("wok_editor._win32_setup_kernel32", return_value=(ctypes, wintypes, kernel32, Info)):
                with self.assertRaises(expected_exc):
                    wok_editor._read_save_bytes(p)
            self.assertEqual(closed, [777])
            return sum(read_sizes)

        self.assertEqual(run_windows_case("C:\\Other\\bigbang9data.dat", 1024, PermissionError), 0)
        self.assertEqual(run_windows_case(None, 1024, ValueError), wok_editor.MAX_COMPRESSED_DAT_BYTES + 1)

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[4] = wok_editor.MPNode("bin8", b"\xaa")
        mp = wok_editor.encode_msgpack(s.root)
        self.assertIn(b"\xc4\x01\xaa", mp)
        wrapped = b"COMPRESSED:" + base64.b64encode(gzip.compress(mp))
        self.assertIs(wok_editor.WokSaveSession(wrapped).validate()["ok"], True)

        bad = mp.replace(b"\xc4\x01\xaa", b"\xd4\x01\xaa", 1)
        self.assertNotEqual(bad, mp)
        with self.assertRaises(ValueError):
            wok_editor.WokSaveSession(b"COMPRESSED:" + base64.b64encode(gzip.compress(bad)))

        s = wok_editor.WokSaveSession(self.demo_bytes)
        s.root.raw = None
        s.root.val[4] = wok_editor.MPNode("bin8", b"\xbb\xcc")
        mp = wok_editor.encode_msgpack(s.root)
        self.assertIn(b"\xc4\x02\xbb\xcc", mp)
        bad = mp.replace(b"\xc4\x02\xbb\xcc", b"\xc7\x01\x01\xaa", 1)
        self.assertNotEqual(bad, mp)
        with self.assertRaises(ValueError):
            wok_editor.WokSaveSession(b"COMPRESSED:" + base64.b64encode(gzip.compress(bad)))

        s_big = wok_editor.WokSaveSession(self.demo_bytes)
        big_rows = s_big.root.val[3].val[0].val[18].val
        new_2001 = '2001,,1e21,0,1e30,0,0,0,0'
        new_2002 = '2002,,-1e21,0,1.2345678901234567e20,0,0,0,0'
        seen_2001 = seen_2002 = False
        for row in big_rows:
            v = getattr(row, 'val', row)
            if isinstance(v, str) and v.startswith('2001,'):
                row.val = new_2001
                row.raw = None
                seen_2001 = True
            elif isinstance(v, str) and v.startswith('2002,'):
                row.val = new_2002
                row.raw = None
                seen_2002 = True
        if not seen_2001:
            big_rows.append(wok_editor.MPNode('str', new_2001))
        if not seen_2002:
            big_rows.append(wok_editor.MPNode('str', new_2002))
        s_big.apply_preset('hero_six_attributes')
        out_rows = [getattr(r, 'val', r) for r in s_big.root.val[3].val[0].val[18].val]
        self.assertEqual(next(r for r in out_rows if r.startswith('2001,')), '2001,,1e+21,40,1e+30,0,0,0,0')
        self.assertEqual(next(r for r in out_rows if r.startswith('2002,')), '2002,,-1e+21,40,123456789012345670000,0,0,0,0')

        other_dir = self.save_dir / 'other_real'
        other_dir.mkdir()
        other_target = other_dir / 'bigbang9data.dat'
        other_target.write_bytes(self.demo_bytes)
        swapped_parent = self.save_dir / 'swapped_parent'
        os.symlink(other_dir, swapped_parent)
        orig_assert_no_symlinks = wok_editor.assert_no_symlinks
        wok_editor.assert_no_symlinks = lambda *_: None
        try:
            with self.assertRaises(PermissionError):
                wok_editor._read_save_bytes(swapped_parent / 'bigbang9data.dat')
            with self.assertRaises(PermissionError):
                wok_editor.save_dat_safely(swapped_parent / 'bigbang9data.dat', self.demo_bytes, force=True)
            with self.assertRaises(PermissionError):
                wok_editor._read_save_bytes(Path(str(other_dir) + "/../other_real/bigbang9data.dat"))
        finally:
            wok_editor.assert_no_symlinks = orig_assert_no_symlinks

        if os.name != "nt":
            edited_sess = wok_editor.WokSaveSession(self.demo_bytes)
            edited_sess.set_world(money=777777)
            edited_bytes = edited_sess.to_bytes()

            outside_dir = self.save_dir / "outside_swap_target"
            outside_dir.mkdir()
            (outside_dir / "keep.txt").write_bytes(b"KEEP")
            (outside_dir / "bigbang9data.dat").write_bytes(b"OUTSIDE_UNTOUCHED")

            victim_dir1 = self.save_dir / "victim_swap_1"
            victim_dir1.mkdir()
            (victim_dir1 / "bigbang9data.dat").write_bytes(self.demo_bytes)
            moved_dir1 = self.save_dir / "victim_swap_1_moved"
            real_posix_read = wok_editor._posix_read_from_dirfd

            def swap_after_backup_read(parent_fd, leaf, label, max_bytes, allow_empty):
                res = real_posix_read(parent_fd, leaf, label, max_bytes, allow_empty)
                if ".backup-" in leaf:
                    os.rename(victim_dir1, moved_dir1)
                    os.symlink(outside_dir, victim_dir1)
                return res

            with unittest.mock.patch(
                "wok_editor._posix_read_from_dirfd",
                side_effect=swap_after_backup_read,
            ):
                with self.assertRaises(PermissionError):
                    wok_editor.save_dat_safely(
                        victim_dir1 / "bigbang9data.dat",
                        edited_bytes,
                        force=True,
                    )

            self.assertEqual(
                sorted(p.name for p in outside_dir.iterdir()),
                ["bigbang9data.dat", "keep.txt"],
            )
            self.assertEqual(
                (outside_dir / "bigbang9data.dat").read_bytes(),
                b"OUTSIDE_UNTOUCHED",
            )
            self.assertEqual(
                (moved_dir1 / "bigbang9data.dat").read_bytes(),
                self.demo_bytes,
            )
            self.assertEqual(
                [
                    p.name
                    for p in moved_dir1.iterdir()
                    if ".backup-" in p.name or ".woktmp-" in p.name
                ],
                [],
            )

            victim_dir2 = self.save_dir / "victim_swap_2"
            victim_dir2.mkdir()
            (victim_dir2 / "bigbang9data.dat").write_bytes(self.demo_bytes)
            moved_dir2 = self.save_dir / "victim_swap_2_moved"
            captured_leaf = []
            real_open_temp = wok_editor._open_temp_save_file

            def swap_before_temp_open(dest_parent, dir_fd):
                os.rename(victim_dir2, moved_dir2)
                os.symlink(outside_dir, victim_dir2)
                fd, leaf = real_open_temp(dest_parent, dir_fd)
                (outside_dir / leaf).write_bytes(b"DECOY_OUTSIDE_TMP")
                captured_leaf.append(leaf)
                return (fd, leaf)

            with unittest.mock.patch(
                "wok_editor._open_temp_save_file",
                side_effect=swap_before_temp_open,
            ):
                with self.assertRaises(PermissionError):
                    wok_editor.save_dat_safely(
                        victim_dir2 / "bigbang9data.dat",
                        edited_bytes,
                        force=True,
                    )

            self.assertEqual(len(captured_leaf), 1)
            self.assertEqual(
                (outside_dir / captured_leaf[0]).read_bytes(),
                b"DECOY_OUTSIDE_TMP",
            )
            self.assertEqual(
                (outside_dir / "bigbang9data.dat").read_bytes(),
                b"OUTSIDE_UNTOUCHED",
            )
            self.assertEqual(
                (moved_dir2 / "bigbang9data.dat").read_bytes(),
                self.demo_bytes,
            )
            self.assertEqual(
                [
                    p.name
                    for p in moved_dir2.iterdir()
                    if ".backup-" in p.name or ".woktmp-" in p.name
                ],
                [],
            )

        s_kf = wok_editor.WokSaveSession(self.demo_bytes)
        s_kf.root.val[3].val[0].val[15].val.append(wok_editor.MPNode("str", "1001,1,0,0, True "))
        s_kf.apply_preset("master_all_kungfu")
        s_kf.apply_preset("party_recover_boost")
        self.assertEqual(s_kf.root.val[3].val[0].val[15].val[-1].val, "1001,1,0,0, True ")

        for value in (1 << 64, -(1 << 63) - 1):
            with self.assertRaises(ValueError):
                s_kf.set_str_flag("x", value)
            with self.assertRaises(ValueError):
                s_kf.set_int_flag("x", value)
        before_demo = Path(self.demo_path).read_bytes()
        try:
            rc = wok_editor.main(["edit", str(self.demo_path), "--set-flag", "x=18446744073709551616"])
        except SystemExit as exc:
            rc = exc.code
        self.assertNotEqual(rc, 0)
        self.assertEqual(Path(self.demo_path).read_bytes(), before_demo)
        s_kf.set_str_flag("x", (1 << 64) - 1); s_kf.set_str_flag("y", -(1 << 63)); self.assertTrue(s_kf.validate()["ok"])

        s_bad = wok_editor.WokSaveSession(self.demo_bytes)
        s_bad.root.val[7] = wok_editor.MPNode("str", "x&18446744073709551616")
        self.assertFalse(s_bad.validate()["ok"])
        s_bad = wok_editor.WokSaveSession(self.demo_bytes)
        s_bad.root.val[7] = wok_editor.MPNode("str", "&1")
        self.assertFalse(s_bad.validate()["ok"])
        s_bad = wok_editor.WokSaveSession(self.demo_bytes)
        s_bad.root.val[6] = wok_editor.MPNode("arr", [wok_editor.MPNode("arr", [wok_editor.MPNode("str", ""), wok_editor.mp_int(1)])])
        self.assertFalse(s_bad.validate()["ok"])
        self.assertIn("GameData[6] 정수 플래그 키가 비어 있습니다.", s_bad.validate()["errors"])
        for nl_raw in ("x&1\n", "x&1\r", "x&1\r\n", "x&\n1"):
            s_nl = wok_editor.WokSaveSession(self.demo_bytes)
            s_nl.root.val[7] = wok_editor.MPNode("str", nl_raw)
            res_nl = s_nl.validate()
            self.assertIs(res_nl["ok"], False)
            self.assertIn("GameData[7] 문자열 플래그 형식이 올바르지 않습니다.", res_nl["errors"])

        for raw in (
            "x&" + ("9" * 4301),
            "x&-" + ("9" * 4301),
            "x&" + ("0" * 4301) + "18446744073709551616",
            "x&-" + ("0" * 4301) + "9223372036854775809",
        ):
            s_long_bad = wok_editor.WokSaveSession(self.demo_bytes)
            s_long_bad.root.val[7] = wok_editor.MPNode("str", raw)
            res_long_bad = s_long_bad.validate()
            self.assertIs(res_long_bad["ok"], False)
            self.assertTrue(any("64비트 정수 범위" in e for e in res_long_bad["errors"]))

        s_long_ok = wok_editor.WokSaveSession(self.demo_bytes)
        s_long_ok.root.val[7] = wok_editor.MPNode(
            "str",
            "x&" + ("0" * 4301) + "1|" +
            "y&-" + ("0" * 4301) + "1|" +
            "z&-" + ("0" * 4301) + "|" +
            "u&" + ("0" * 4301) + "18446744073709551615|" +
            "m&-" + ("0" * 4301) + "9223372036854775808",
        )
        self.assertIs(s_long_ok.validate()["ok"], True)
        flags_long_ok = {f["key"]: f["value"] for f in s_long_ok.list_flags() if f["source"] == "strFlagDatas"}
        self.assertEqual(flags_long_ok["x"], 1)
        self.assertEqual(flags_long_ok["y"], -1)
        self.assertEqual(flags_long_ok["z"], 0)
        self.assertEqual(flags_long_ok["u"], 18446744073709551615)
        self.assertEqual(flags_long_ok["m"], -9223372036854775808)

        s_set = wok_editor.WokSaveSession(self.demo_bytes)
        s_set.set_str_flag("x", ("0" * 4301) + "42")
        self.assertEqual(s_set._as_str(s_set.root.val[7]), "x&42")
        with self.assertRaises(ValueError):
            s_set.set_str_flag("x", "9" * 4301)
        before_main = self.demo_path.read_bytes()
        rc_main = wok_editor.main(["edit", str(self.demo_path), "--set-flag", "x=" + ("9" * 4301)])
        self.assertNotEqual(rc_main, 0)
        self.assertEqual(self.demo_path.read_bytes(), before_main)

        import unittest.mock
        for raw in (r"C:\Saves\..\Saves\bigbang1data.dat", "C:/Saves/../Saves/bigbang1data.dat"):
            with self.assertRaises(PermissionError):
                wok_editor.assert_no_symlinks(Path(raw))
            with unittest.mock.patch("wok_editor.os.name", "nt"):
                with self.assertRaises(PermissionError):
                    wok_editor.assert_no_symlinks(Path(raw))

if __name__ == "__main__":
    unittest.main()
