#!/usr/bin/env python3
import argparse
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML_IN = os.path.join(ROOT, "src", "editor-page.html")
HTML_OUT = os.path.join(ROOT, "dist", "WorldOfKungfuSaveEditor-v1.0.html")
EXE_OUT = os.path.join(ROOT, "dist", "WorldOfKungfuSaveEditor-v1.0.exe")
SCRIPT_ORDER = ("catalog-data.js", "msgpack-codec.js", "editor-core.js", "editor-ui.js")
BUNDLE_START = "<!-- BUNDLE_SCRIPTS_START -->"
BUNDLE_END = "<!-- BUNDLE_SCRIPTS_END -->"
CSC = os.environ.get("WOKSE_CSC", "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe")
EXTERNAL_REF_RE = re.compile(r'''(?i)\b(?:https?|ftp|wss?)://|\b(?:src|href|action|poster|data|cite)\s*=\s*["']?\s*//|\burl\(\s*["']?\s*(?:https?|ftp|wss?)?//''')


def has_external_url_ref(html_text):
    return EXTERNAL_REF_RE.search(html_text) is not None


def build_html():
    with open(HTML_IN, "r", encoding="utf-8") as f:
        html = f.read()
    start = html.find(BUNDLE_START)
    if start == -1:
        raise RuntimeError("bundle start marker not found")
    end = html.find(BUNDLE_END, start + len(BUNDLE_START))
    if end == -1:
        raise RuntimeError("bundle end marker not found")
    blocks = []
    for name in SCRIPT_ORDER:
        with open(os.path.join(ROOT, "src", name), "r", encoding="utf-8") as f:
            code = f.read()
        code = re.sub(r"(?i)</script", lambda m: "<\\/script", code)
        blocks.append("<script>\n" + code + "\n</script>")
    out_html = html[:start] + "\n".join(blocks) + html[end + len(BUNDLE_END):]
    out_html = out_html.replace("\r\n", "\n").replace("\r", "\n")
    if has_external_url_ref(out_html):
        raise RuntimeError("external URL reference found")
    if len(out_html.encode("utf-8")) >= 10 * 1024 * 1024:
        raise RuntimeError("bundled HTML is too large")
    os.makedirs(os.path.dirname(HTML_OUT), exist_ok=True)
    with open(HTML_OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out_html)
    return out_html


def build_exe(webview2_dir):
    core = os.path.join(webview2_dir, "Microsoft.Web.WebView2.Core.dll")
    winforms = os.path.join(webview2_dir, "Microsoft.Web.WebView2.WinForms.dll")
    loader = os.path.join(webview2_dir, "WebView2Loader.dll")
    license_file = os.path.join(webview2_dir, "LICENSE.txt")
    for path in (core, winforms, loader, license_file):
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
    if not os.path.isfile(HTML_OUT):
        build_html()
    os.makedirs(os.path.dirname(EXE_OUT), exist_ok=True)
    command = [
        CSC,
        "/nologo",
        "/target:winexe",
        "/platform:x64",
        "/optimize+",
        "/debug-",
        f"/out:{EXE_OUT}",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        "/reference:System.Web.Extensions.dll",
        f"/reference:{core}",
        f"/reference:{winforms}",
        f"/resource:{core},Microsoft.Web.WebView2.Core.dll",
        f"/resource:{winforms},Microsoft.Web.WebView2.WinForms.dll",
        f"/resource:{loader},WebView2Loader.dll",
        f"/resource:{license_file},WebView2-LICENSE.txt",
        f"/resource:{HTML_OUT},editor.html",
        os.path.join(ROOT, "src", "SaveStore.cs"),
        os.path.join(ROOT, "src", "SaveEditor.cs"),
    ]
    subprocess.run(command, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", action="store_true")
    parser.add_argument("--webview2")
    args = parser.parse_args(argv)
    if args.exe:
        if not args.webview2:
            parser.error("--webview2 is required with --exe")
        build_html()
        build_exe(args.webview2)
    else:
        if args.webview2:
            parser.error("--webview2 requires --exe")
        build_html()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
