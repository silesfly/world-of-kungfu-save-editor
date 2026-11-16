"""wok_editor.py - Lossless editor for The World of Kongfu (대강호) save files.

Part 1: catalog loader, msgpack AST codec, WokSaveSession, safety guards.
Pure Python 3 stdlib only.
"""
from __future__ import annotations

import base64
import datetime
import decimal
import errno
import gzip
import io
import hashlib
import json
import math
import os
import re
import shlex
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
COMPRESSED_PREFIX = "COMPRESSED:"
MAX_COMPRESSED_DAT_BYTES = 32 * 1024 * 1024
MAX_UNCOMPRESSED_MP_BYTES = 64 * 1024 * 1024
MAX_MSGPACK_DEPTH = 64
MAX_HTTP_BODY_BYTES = 48 * 1024 * 1024
NON_SLOT_FILES = {
    "configdata.dat",
    "configdata",
    "statsandachievementdata.dat",
    "unlockatlasdata.dat",
}

WINDOWS_RESERVED_STEMS = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}

SHOVEL_MINE_RE = re.compile(r"^Mine\d+&\d+&\d+$")


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


@dataclass
class MPNode:
    tag: str
    val: Any
    raw: Optional[bytes] = None


_MP_INT_TAGS = ("pfixint", "nfixint", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64")
_MP_INT_MIN = -9223372036854775808
_MP_INT_MAX = 0xffffffffffffffff
_MP_INT_RANGES = {
    "pfixint": (0, 0x7f),
    "nfixint": (-32, -1),
    "u8": (0, 0xff),
    "u16": (0, 0xffff),
    "u32": (0, 0xffffffff),
    "u64": (0, 0xffffffffffffffff),
    "i8": (-128, 127),
    "i16": (-32768, 32767),
    "i32": (-2147483648, 2147483647),
    "i64": (-9223372036854775808, 0x7fffffffffffffff),
}


def _mp_pack_int(tag: str, v: int) -> bytes:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v < _MP_INT_MIN or v > _MP_INT_MAX:
        raise ValueError(f"integer out of MessagePack range: {v}")
    if tag not in _MP_INT_RANGES:
        raise ValueError(f"bad int tag {tag}")
    lo, hi = _MP_INT_RANGES[tag]
    if not (lo <= v <= hi):
        tag = _choose_uint_tag(v) if v >= 0 else _choose_int_tag(v)
    if tag == "pfixint":
        return bytes([v])
    if tag == "nfixint":
        return bytes([v & 0xff])
    if tag == "u8":
        return b"\xcc" + struct.pack(">B", v)
    if tag == "u16":
        return b"\xcd" + struct.pack(">H", v)
    if tag == "u32":
        return b"\xce" + struct.pack(">I", v)
    if tag == "u64":
        return b"\xcf" + struct.pack(">Q", v)
    if tag == "i8":
        return b"\xd0" + struct.pack(">b", v)
    if tag == "i16":
        return b"\xd1" + struct.pack(">h", v)
    if tag == "i32":
        return b"\xd2" + struct.pack(">i", v)
    if tag == "i64":
        return b"\xd3" + struct.pack(">q", v)
    raise ValueError(f"bad int tag {tag}")


def _choose_uint_tag(v: int) -> str:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v < 0 or v > 0xffffffffffffffff:
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v <= 0x7f:
        return "pfixint"
    if v <= 0xff:
        return "u8"
    if v <= 0xffff:
        return "u16"
    if v <= 0xffffffff:
        return "u32"
    return "u64"


def _choose_int_tag(v: int) -> str:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v < -9223372036854775808 or v > 0x7fffffffffffffff:
        raise ValueError(f"integer out of MessagePack range: {v}")
    if -32 <= v < 0:
        return "nfixint"
    if -128 <= v <= 127:
        return "i8"
    if -32768 <= v <= 32767:
        return "i16"
    if -2147483648 <= v <= 2147483647:
        return "i32"
    return "i64"

def _encode_str_bytes(s: str) -> bytes:
    b = s.encode("utf-8")
    n = len(b)
    if n <= 31:
        return bytes([0xa0 | n]) + b
    if n <= 0xff:
        return b"\xd9" + struct.pack(">B", n) + b
    if n <= 0xffff:
        return b"\xda" + struct.pack(">H", n) + b
    return b"\xdb" + struct.pack(">I", n) + b


def encode_msgpack(node: MPNode, depth: int = 0) -> bytes:
    if depth > MAX_MSGPACK_DEPTH:
        raise ValueError("msgpack nesting depth exceeded")
    t = node.tag
    v = node.val
    if t in _MP_INT_TAGS:
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError(f"integer out of MessagePack range: {v}")
        return _mp_pack_int(t, v)
    if t == "nil":
        return b"\xc0"
    if t == "bool":
        return b"\xc3" if v else b"\xc2"
    if t == "f32":
        if node.raw is not None and len(node.raw) == 4:
            return b"\xca" + node.raw
        return b"\xca" + struct.pack(">f", float(v))
    if t == "f64":
        if node.raw is not None and len(node.raw) == 8:
            return b"\xcb" + node.raw
        return b"\xcb" + struct.pack(">d", float(v))
    if t in ("str", "str8", "str16", "str32"):
        b = v.encode("utf-8")
        n = len(b)
        if n > 0xffffffff:
            raise ValueError("string too long for MessagePack")
        if t == "str" and n <= 31:
            return bytes([0xa0 | n]) + b
        if t == "str8" and n <= 0xff:
            return b"\xd9" + struct.pack(">B", n) + b
        if t == "str16" and n <= 0xffff:
            return b"\xda" + struct.pack(">H", n) + b
        if t == "str32" and n <= 0xffffffff:
            return b"\xdb" + struct.pack(">I", n) + b
        return _encode_str_bytes(v)
    if t in ("bin", "bin8", "bin16", "bin32"):
        b = v if isinstance(v, (bytes, bytearray)) else bytes(v)
        n = len(b)
        if n > 0xffffffff:
            raise ValueError("binary too long for MessagePack")
        if t == "bin8" and n <= 0xff:
            return b"\xc4" + struct.pack(">B", n) + b
        if t == "bin16" and n <= 0xffff:
            return b"\xc5" + struct.pack(">H", n) + b
        if t == "bin32" and n <= 0xffffffff:
            return b"\xc6" + struct.pack(">I", n) + b
        if n <= 0xff:
            return b"\xc4" + struct.pack(">B", n) + b
        if n <= 0xffff:
            return b"\xc5" + struct.pack(">H", n) + b
        return b"\xc6" + struct.pack(">I", n) + b
    if t in ("arr", "arr16", "arr32"):
        n = len(v)
        if n > 0xffffffff:
            raise ValueError("array too long for MessagePack")
        if t == "arr" and n <= 0x0f:
            return bytes([0x90 | n]) + b"".join(encode_msgpack(x, depth + 1) for x in v)
        if t == "arr16" and n <= 0xffff:
            return b"\xdc" + struct.pack(">H", n) + b"".join(encode_msgpack(x, depth + 1) for x in v)
        if t == "arr32" and n <= 0xffffffff:
            return b"\xdd" + struct.pack(">I", n) + b"".join(encode_msgpack(x, depth + 1) for x in v)
        if n <= 0x0f:
            return bytes([0x90 | n]) + b"".join(encode_msgpack(x, depth + 1) for x in v)
        if n <= 0xffff:
            return b"\xdc" + struct.pack(">H", n) + b"".join(encode_msgpack(x, depth + 1) for x in v)
        return b"\xdd" + struct.pack(">I", n) + b"".join(encode_msgpack(x, depth + 1) for x in v)
    if t in ("map", "map16", "map32"):
        n = len(v)
        if n > 0xffffffff:
            raise ValueError("map too long for MessagePack")
        if t == "map" and n <= 0x0f:
            return bytes([0x80 | n]) + b"".join(
                encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
            )
        if t == "map16" and n <= 0xffff:
            return b"\xde" + struct.pack(">H", n) + b"".join(
                encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
            )
        if t == "map32" and n <= 0xffffffff:
            return b"\xdf" + struct.pack(">I", n) + b"".join(
                encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
            )
        if n <= 0x0f:
            return bytes([0x80 | n]) + b"".join(
                encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
            )
        if n <= 0xffff:
            return b"\xde" + struct.pack(">H", n) + b"".join(
                encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
            )
        return b"\xdf" + struct.pack(">I", n) + b"".join(
            encode_msgpack(k, depth + 1) + encode_msgpack(val, depth + 1) for k, val in v
        )
    raise ValueError(f"unknown msgpack tag {t!r}")


def decode_msgpack(buf: bytes) -> MPNode:
    if len(buf) > MAX_UNCOMPRESSED_MP_BYTES:
        raise ValueError("decompressed msgpack exceeds maximum size")
    pos = 0
    end = len(buf)

    def read(n: int) -> bytes:
        nonlocal pos
        if pos + n > end:
            raise ValueError("truncated msgpack buffer")
        b = buf[pos:pos + n]
        pos += n
        return b

    def dec(depth: int = 0) -> MPNode:
        nonlocal pos
        if depth > MAX_MSGPACK_DEPTH:
            raise ValueError("msgpack nesting depth exceeded")
        b = read(1)[0]
        if b <= 0x7f:
            return MPNode("pfixint", b)
        if b >= 0xe0:
            return MPNode("nfixint", b - 0x100)
        if 0x80 <= b <= 0x8f:
            n = b & 0x0f
            if n > (end - pos) // 2:
                raise ValueError("truncated msgpack map")
            return MPNode("map", [(dec(depth + 1), dec(depth + 1)) for _ in range(n)])
        if 0x90 <= b <= 0x9f:
            n = b & 0x0f
            if n > end - pos:
                raise ValueError("truncated msgpack array")
            return MPNode("arr", [dec(depth + 1) for _ in range(n)])
        if 0xa0 <= b <= 0xbf:
            n = b & 0x1f
            return MPNode("str", read(n).decode("utf-8"))
        if b == 0xc0:
            return MPNode("nil", None)
        if b == 0xc2:
            return MPNode("bool", False)
        if b == 0xc3:
            return MPNode("bool", True)
        if b == 0xc4:
            return MPNode("bin8", read(read(1)[0]))
        if b == 0xc5:
            return MPNode("bin16", read(struct.unpack(">H", read(2))[0]))
        if b == 0xc6:
            return MPNode("bin32", read(struct.unpack(">I", read(4))[0]))
        if b == 0xca:
            raw = read(4)
            return MPNode("f32", struct.unpack(">f", raw)[0], raw)
        if b == 0xcb:
            raw = read(8)
            return MPNode("f64", struct.unpack(">d", raw)[0], raw)
        if b == 0xcc:
            return MPNode("u8", read(1)[0])
        if b == 0xcd:
            return MPNode("u16", struct.unpack(">H", read(2))[0])
        if b == 0xce:
            return MPNode("u32", struct.unpack(">I", read(4))[0])
        if b == 0xcf:
            return MPNode("u64", struct.unpack(">Q", read(8))[0])
        if b == 0xd0:
            return MPNode("i8", struct.unpack(">b", read(1))[0])
        if b == 0xd1:
            return MPNode("i16", struct.unpack(">h", read(2))[0])
        if b == 0xd2:
            return MPNode("i32", struct.unpack(">i", read(4))[0])
        if b == 0xd3:
            return MPNode("i64", struct.unpack(">q", read(8))[0])
        if b == 0xd9:
            return MPNode("str8", read(read(1)[0]).decode("utf-8"))
        if b == 0xda:
            return MPNode("str16", read(struct.unpack(">H", read(2))[0]).decode("utf-8"))
        if b == 0xdb:
            return MPNode("str32", read(struct.unpack(">I", read(4))[0]).decode("utf-8"))
        if b == 0xdc:
            n = struct.unpack(">H", read(2))[0]
            if n > end - pos:
                raise ValueError("truncated msgpack array")
            return MPNode("arr16", [dec(depth + 1) for _ in range(n)])
        if b == 0xdd:
            n = struct.unpack(">I", read(4))[0]
            if n > end - pos:
                raise ValueError("truncated msgpack array")
            return MPNode("arr32", [dec(depth + 1) for _ in range(n)])
        if b == 0xde:
            n = struct.unpack(">H", read(2))[0]
            if n > (end - pos) // 2:
                raise ValueError("truncated msgpack map")
            return MPNode("map16", [(dec(depth + 1), dec(depth + 1)) for _ in range(n)])
        if b == 0xdf:
            n = struct.unpack(">I", read(4))[0]
            if n > (end - pos) // 2:
                raise ValueError("truncated msgpack map")
            return MPNode("map32", [(dec(depth + 1), dec(depth + 1)) for _ in range(n)])
        raise ValueError(f"unsupported msgpack byte 0x{b:02x}")

    node = dec()
    if pos != end:
        raise ValueError(f"trailing bytes in msgpack ({end - pos} left)")
    return node


def decode_dat_bytes(raw_bytes: bytes) -> Tuple[MPNode, bytes]:
    if len(raw_bytes) > MAX_COMPRESSED_DAT_BYTES:
        raise ValueError("compressed .dat exceeds maximum size")
    stripped = raw_bytes.lstrip(b"\xef\xbb\xbf \t\r\n")
    if not stripped.startswith(COMPRESSED_PREFIX.encode("ascii")):
        raise ValueError("missing COMPRESSED: header")
    b64_part = stripped[len(COMPRESSED_PREFIX):].strip()
    try:
        compressed = base64.b64decode(b64_part, validate=True)
    except Exception as exc:
        raise ValueError(f"invalid base64 payload: {exc}") from exc
    try:
        out = bytearray()
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as gz:
            while True:
                chunk = gz.read(65536)
                if not chunk:
                    break
                out.extend(chunk)
                if len(out) > MAX_UNCOMPRESSED_MP_BYTES:
                    raise ValueError("decompressed gzip payload exceeds maximum size")
        decompressed = bytes(out)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"invalid gzip payload: {exc}") from exc
    return decode_msgpack(decompressed), decompressed

def encode_dat_bytes(ast: MPNode) -> bytes:
    raw = encode_msgpack(ast)
    compressed = gzip.compress(raw)
    b64 = base64.b64encode(compressed).decode("ascii")
    return (COMPRESSED_PREFIX + b64).encode("ascii")


# ---------------------------------------------------------------------------
# MPNode helpers
# ---------------------------------------------------------------------------

def mp_to_plain(node: MPNode, depth: int = 0) -> Any:
    if depth > MAX_MSGPACK_DEPTH:
        raise ValueError("msgpack nesting depth exceeded")
    t = node.tag
    if t in ("pfixint", "nfixint", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"):
        return int(node.val)
    if t in ("f32", "f64"):
        return float(node.val)
    if t == "nil":
        return None
    if t == "bool":
        return bool(node.val)
    if t in ("str", "str8", "str16", "str32"):
        return str(node.val)
    if t in ("bin", "bin8", "bin16", "bin32"):
        return bytes(node.val)
    if t in ("arr", "arr16", "arr32"):
        return [mp_to_plain(x, depth + 1) for x in node.val]
    if t in ("map", "map16", "map32"):
        return {mp_to_plain(k, depth + 1): mp_to_plain(v, depth + 1) for k, v in node.val}
    raise ValueError(f"unhandled tag {t}")


def mp_f32(v: float) -> MPNode:
    return MPNode("f32", float(v))


def mp_str(s: str) -> MPNode:
    return MPNode("str", str(s))


def mp_arr(items: List[MPNode]) -> MPNode:
    return MPNode("arr", list(items))


def load_catalog() -> Dict[str, Any]:
    path = Path(__file__).resolve().parent / "src" / "catalog-data.js"
    if not path.exists():
        path = Path.cwd() / "src" / "catalog-data.js"
    text = path.read_text(encoding="utf-8")
    ret = text.find("return {")
    if ret < 0:
        raise ValueError("catalog-data.js에서 return {를 찾을 수 없습니다.")
    obj, _ = json.JSONDecoder().raw_decode(text, ret + len("return "))
    out: Dict[str, Any] = {}
    for key in ("stats", "origins", "characters", "kungfu", "traits", "items"):
        table = obj.get(key, {})
        if isinstance(table, list):
            out[key] = {str(x["id"]): x for x in table if isinstance(x, dict) and "id" in x}
        elif isinstance(table, dict):
            out[key] = {str(k): v for k, v in table.items()}
        else:
            out[key] = {}
    return out




def mp_int(v: int) -> MPNode:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v < _MP_INT_MIN or v > _MP_INT_MAX:
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v >= 0:
        return MPNode(_choose_uint_tag(v), v)
    return MPNode(_choose_int_tag(v), v)


def set_mp_int(node: MPNode, v: int) -> None:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"integer out of MessagePack range: {v}")
    if v < _MP_INT_MIN or v > _MP_INT_MAX:
        raise ValueError(f"integer out of MessagePack range: {v}")
    new_tag = _choose_uint_tag(v) if v >= 0 else _choose_int_tag(v)
    if (
        not isinstance(node.val, bool)
        and isinstance(node.val, int)
        and node.val == v
        and node.tag in _MP_INT_RANGES
        and _MP_INT_RANGES[node.tag][0] <= v <= _MP_INT_RANGES[node.tag][1]
    ):
        return
    node.tag = new_tag
    node.val = v
    node.raw = None


def _is_int_node(node: Any) -> bool:
    return (
        isinstance(node, MPNode)
        and node.tag in _MP_INT_TAGS
        and isinstance(node.val, int)
        and not isinstance(node.val, bool)
        and _MP_INT_MIN <= node.val <= _MP_INT_MAX
    )


def _is_finite_f32_node(node: MPNode) -> bool:
    if not isinstance(node, MPNode) or node.tag not in ("f32", "f64"):
        return False
    if not isinstance(node.val, (int, float)) or isinstance(node.val, bool):
        return False
    fv = float(node.val)
    if not math.isfinite(fv):
        return False
    try:
        packed = struct.pack(">f", fv)
    except OverflowError:
        return False
    return math.isfinite(struct.unpack(">f", packed)[0])


def set_mp_f32(node: MPNode, v: float) -> None:
    fv = float(v)
    if not math.isfinite(fv):
        raise ValueError("float32 값은 유한한 숫자여야 합니다.")
    try:
        packed = struct.pack(">f", fv)
    except OverflowError as exc:
        raise ValueError("float32 허용 범위를 벗어난 숫자입니다.") from exc
    unpacked = struct.unpack(">f", packed)[0]
    if not math.isfinite(unpacked):
        raise ValueError("float32 허용 범위를 벗어난 숫자입니다.")
    if node.tag == "f32" and node.val == unpacked:
        return
    node.tag = "f32"
    node.val = unpacked
    node.raw = None


def set_mp_str(node: MPNode, s: str) -> None:
    sv = str(s)
    if isinstance(node.val, str) and node.val == sv and node.tag in ("str", "str8", "str16", "str32"):
        return
    node.tag = "str"
    node.val = sv
    node.raw = None


PRESETS: Dict[str, str] = {
    "rich_epiphany": "은량(9,999,999)·돈오점(999)·삽 내구도(9,999) 하한 보정",
    "hero_max_growth": "주인공 레벨(60)·재능(+100, 최소 200)·기혈/내력 상한(5,000) 및 현재치 보정",
    "hero_six_attributes": "주인공 6대 선천자질(2001~2006) 영속 합산 40 이상 보정",
    "hero_all_mastery": "주인공 14종 무학조예(3001~3014) 영속 합산 220 이상 보정",
    "master_all_kungfu": "대상 캐릭터(기본 주인공)의 폐기되지 않은 보유 무공 레벨 상한·숙련도 9,999 보정",
    "party_recover_boost": "주인공·출전 동료 재능(100)·호감도(100)·보유 무공 숙련(9,999)·기혈/내력 회복·이동속도(2.25) 보정",
}


class WokSaveSession:
    def __init__(self, raw_bytes: bytes, catalog: Optional[Dict[str, Any]] = None):
        ast, self._mp_bytes = decode_dat_bytes(raw_bytes)
        if ast.tag in ("arr", "arr16", "arr32") and len(ast.val) == 26:
            raise ValueError("환경설정 데이터(configdata.dat)입니다. 슬롯 세이브 파일(bigbang1data.dat ~ bigbang24data.dat)을 선택해 주세요.")
        if (
            ast.tag not in ("arr", "arr16", "arr32")
            or len(ast.val) != 54
            or ast.val[3].tag not in ("arr", "arr16", "arr32")
            or len(ast.val[3].val) < 1
            or ast.val[9].tag not in ("str", "str8", "str16", "str32")
            or str(ast.val[9].val) == ""
        ):
            raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
        if not (
            isinstance(ast.val[7], MPNode)
            and (ast.val[7].tag == "nil" or ast.val[7].tag in ("str", "str8", "str16", "str32"))
        ):
            raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
        for chara in ast.val[3].val:
            if not (
                isinstance(chara, MPNode)
                and chara.tag in ("arr", "arr16", "arr32")
                and len(chara.val) == 29
                and chara.val[1].tag in ("str", "str8", "str16", "str32")
                and str(chara.val[1].val) != ""
            ):
                raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
            for k in (15, 16, 18, 19, 20, 22):
                if not (
                    isinstance(chara.val[k], MPNode)
                    and (
                        chara.val[k].tag == "nil"
                        or (
                            chara.val[k].tag in ("arr", "arr16", "arr32")
                            and isinstance(chara.val[k].val, list)
                            and all(
                                isinstance(e, MPNode)
                                and e.tag in ("str", "str8", "str16", "str32")
                                for e in chara.val[k].val
                            )
                        )
                    )
                ):
                    raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
        for k in (6, 19, 20, 21, 30, 40, 41, 42, 43):
            if not (
                isinstance(ast.val[k], MPNode)
                and (
                    ast.val[k].tag == "nil"
                    or (
                        ast.val[k].tag in ("arr", "arr16", "arr32")
                        and isinstance(ast.val[k].val, list)
                    )
                )
            ):
                raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
            if k in (20, 21, 40, 41, 42, 43) and ast.val[k].tag in ("arr", "arr16", "arr32"):
                if not all(
                    isinstance(e, MPNode)
                    and e.tag in ("str", "str8", "str16", "str32")
                    for e in ast.val[k].val
                ):
                    raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
            if k in (6, 19) and ast.val[k].tag in ("arr", "arr16", "arr32"):
                for row in ast.val[k].val:
                    if not (
                        isinstance(row, MPNode)
                        and row.tag in ("arr", "arr16", "arr32")
                        and isinstance(row.val, list)
                        and len(row.val) >= 2
                        and isinstance(row.val[0], MPNode)
                        and row.val[0].tag in ("str", "str8", "str16", "str32")
                        and isinstance(row.val[1], MPNode)
                        and row.val[1].tag in _MP_INT_TAGS
                        and isinstance(row.val[1].val, int)
                        and not isinstance(row.val[1].val, bool)
                    ):
                        raise ValueError("유효한 대강호 슬롯 세이브(GameData 54필드)가 아닙니다.")
        self.root = ast
        self.catalog = catalog if catalog is not None else load_catalog()
        self._dynamic_items: set[str] = set()
        self._dynamic_kungfu: set[str] = set()
        self._refresh_dynamic_ids()

    @property
    def game(self) -> MPNode:
        return self.root

    def _refresh_dynamic_ids(self) -> None:
        self._dynamic_items = set()
        self._dynamic_kungfu = set()
        for idx, target in ((40, self._dynamic_items), (42, self._dynamic_items), (41, self._dynamic_kungfu)):
            if len(self.root.val) <= idx:
                continue
            node = self.root.val[idx]
            if node.tag not in ("arr", "arr16", "arr32"):
                continue
            for elem in node.val:
                if elem.tag not in ("str", "str8", "str16", "str32"):
                    continue
                parts = str(elem.val).split(";")
                if parts and parts[0]:
                    target.add(parts[0].strip())
                    m = re.search(r"\^Mine\d+&", str(elem.val))
                    if m:
                        self._dynamic_items.add(m.group(0)[1:-1])

    def _is_arr(self, node: MPNode) -> bool:
        return (
            isinstance(node, MPNode)
            and node.tag in ("arr", "arr16", "arr32")
            and isinstance(node.val, list)
        )

    def _ensure_arr(self, node: MPNode) -> list[MPNode]:
        if node.tag not in ("arr", "arr16", "arr32") or not isinstance(node.val, list):
            node.tag = "arr"
            node.val = []
            node.raw = None
        return node.val

    def _as_int(self, node: MPNode, default: int = 0) -> int:
        try:
            return int(node.val)
        except Exception:
            return default

    def _as_float(self, node: MPNode, default: float = 0.0) -> float:
        try:
            return float(node.val)
        except Exception:
            return default

    def _as_str(self, node: MPNode, default: str = "") -> str:
        if node.tag in ("str", "str8", "str16", "str32"):
            return str(node.val)
        return default

    def _char_rows(self, chara: MPNode, index: int) -> list[MPNode]:
        if len(chara.val) <= index or not self._is_arr(chara.val[index]):
            return []
        return list(chara.val[index].val)

    def _hero_name(self, chara: MPNode) -> str:
        for row in self._char_rows(chara, 18):
            if row.tag in ("str", "str8", "str16", "str32"):
                parts = str(row.val).split(",")
                if parts and parts[0] == "12003" and len(parts) > 1:
                    return parts[1]
        if len(chara.val) > 25 and chara.val[25].tag in ("str", "str8", "str16", "str32"):
            return str(chara.val[25].val)
        return ""

    def _find_character_node(self, chara_id: Any) -> Optional[MPNode]:
        cid = str(chara_id)
        for chara in self.root.val[3].val:
            if len(chara.val) > 1 and chara.val[1].tag in ("str", "str8", "str16", "str32") and str(chara.val[1].val) == cid:
                return chara
        return None

    def _parse_fields(self, text: str, count: int = 9) -> list[str]:
        return str(text).split(",")

    def _csv_join(self, parts: list[Any], count: int) -> str:
        vals = [str(x) for x in parts[:count]]
        while len(vals) < count:
            vals.append("")
        return ",".join(vals)

    def summary(self) -> Dict[str, Any]:
        g = self.root.val
        hero_name = ""
        if g[3].val:
            hero_name = self._hero_name(g[3].val[0])
        special_wanted = [self._as_str(x) for x in (g[43].val if self._is_arr(g[43]) else [])]
        return {
            "heroName": hero_name,
            "playerid": self._as_str(g[9]),
            "bornid": self._as_str(g[8]),
            "SceneBefore": self._as_str(g[10]),
            "m_Money": self._as_int(g[14]),
            "m_Epiphany": self._as_int(g[15]),
            "m_PlayRound": self._as_int(g[16]),
            "m_FieldMoveSpeedRate": self._as_float(g[17]),
            "m_ShovelDurable": self._as_int(g[33]),
            "Game_Mode": self._as_int(g[24]),
            "gameDateVersion": self._as_str(g[51]),
            "character_count": len(g[3].val),
            "item_count": len(g[19].val if self._is_arr(g[19]) else []),
            "party": [self._as_str(x) for x in (g[20].val if self._is_arr(g[20]) else [])],
            "follow": [self._as_str(x) for x in (g[21].val if self._is_arr(g[21]) else [])],
            "m_ArenaWinCount": self._as_int(g[25]) if _is_int_node(g[25]) else 0,
            "m_Arena_Rewards_JunShan": self._as_str(g[26]),
            "simpleWantedInfos_count": len(g[30].val) if self._is_arr(g[30]) else 0,
            "m_DaTianWangSiLevel": self._as_int(g[36]) if _is_int_node(g[36]) else 0,
            "m_Arena_Rewards_DaTianWangSi": self._as_str(g[37]),
            "m_DongShuFactionMember": self._as_str(g[38]),
            "m_SpecialWantedList": special_wanted,
            "m_JinWuFactionMember": self._as_str(g[47]),
            "m_XiBoFactionMember": self._as_str(g[48]),
            "m_BeiGuFactionMember": self._as_str(g[52]),
        }

    def get_extended_world(self) -> Dict[str, Any]:
        g = self.root.val
        simple_wanted = mp_to_plain(g[30]) if self._is_arr(g[30]) else []
        special_wanted = [self._as_str(x) for x in (g[43].val if self._is_arr(g[43]) else [])]

        def split_members(idx: int) -> List[str]:
            text = self._as_str(g[idx])
            return [part for part in text.split("|") if part] if text else []

        return {
            "m_ArenaWinCount": self._as_int(g[25]) if _is_int_node(g[25]) else 0,
            "m_Arena_Rewards_JunShan": self._as_str(g[26]),
            "simpleWantedInfos": simple_wanted if isinstance(simple_wanted, list) else [],
            "simpleWantedInfos_count": len(simple_wanted) if isinstance(simple_wanted, list) else 0,
            "m_DaTianWangSiLevel": self._as_int(g[36]) if _is_int_node(g[36]) else 0,
            "m_Arena_Rewards_DaTianWangSi": self._as_str(g[37]),
            "m_DongShuFactionMember": self._as_str(g[38]),
            "dongShuMembers": split_members(38),
            "m_SpecialWantedList": special_wanted,
            "m_JinWuFactionMember": self._as_str(g[47]),
            "jinWuMembers": split_members(47),
            "m_XiBoFactionMember": self._as_str(g[48]),
            "xiBoMembers": split_members(48),
            "m_BeiGuFactionMember": self._as_str(g[52]),
            "beiGuMembers": split_members(52),
        }

    def list_characters(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for chara in self.root.val[3].val:
            g = chara.val
            out.append({
                "id": self._as_str(g[1]),
                "name": self._hero_name(chara),
                "nickName": self._as_str(g[25]),
                "guild": self._as_str(g[26]),
                "lv": self._as_int(g[9]),
                "exp": self._as_int(g[10]),
                "hp": self._as_float(g[6]),
                "mp": self._as_float(g[7]),
                "relationship": self._as_int(g[11]),
                "talent": self._as_int(g[13]),
                "totalTalentCost": self._as_int(g[28]),
            })
        return out

    def get_character(self, chara_id: Any) -> Dict[str, Any]:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        g = chara.val
        stats = []
        for row in self._char_rows(chara, 18):
            if row.tag not in ("str", "str8", "str16", "str32"):
                continue
            parts = self._parse_fields(str(row.val), 9)
            stats.append({
                "id": parts[0] if len(parts) > 0 else "",
                "stringValue": parts[1] if len(parts) > 1 else "",
                "born": parts[2] if len(parts) > 2 else "",
                "alterValue": parts[3] if len(parts) > 3 else "",
                "fight": parts[4] if len(parts) > 4 else "",
                "roll": parts[5] if len(parts) > 5 else "",
                "juqing": parts[6] if len(parts) > 6 else "",
                "levelup": parts[7] if len(parts) > 7 else "",
                "talent": parts[8] if len(parts) > 8 else "",
                "raw": str(row.val),
            })
        kungfu = []
        for row in self._char_rows(chara, 15):
            if row.tag not in ("str", "str8", "str16", "str32"):
                continue
            parts = self._parse_fields(str(row.val), 5)
            kungfu.append({
                "id": parts[0] if len(parts) > 0 else "",
                "lv": int(parts[1]) if len(parts) > 1 and parts[1].lstrip("-").isdigit() else 0,
                "exp": int(parts[2]) if len(parts) > 2 and parts[2].lstrip("-").isdigit() else 0,
                "prof": int(parts[3]) if len(parts) > 3 and parts[3].lstrip("-").isdigit() else 0,
                "isAbolished": parts[4] if len(parts) > 4 else "False",
                "raw": str(row.val),
            })
        traits = [self._as_str(x) for x in self._char_rows(chara, 19)]
        equip_slots = [self._as_str(x) for x in self._char_rows(chara, 20)]
        equip_traits = [self._as_str(x) for x in self._char_rows(chara, 22)]
        basic = {
            "id": self._as_str(g[1]),
            "heroName": self._hero_name(chara),
            "nickName": self._as_str(g[25]),
            "guild": self._as_str(g[26]),
            "hp": self._as_float(g[6]),
            "mp": self._as_float(g[7]),
            "lv": self._as_int(g[9]),
            "exp": self._as_int(g[10]),
            "relationship": self._as_int(g[11]),
            "talent": self._as_int(g[13]),
            "trainingId": self._as_str(g[8]),
            "totalTalentCost": self._as_int(g[28]),
        }
        return {
            "basic": basic,
            "stats": stats,
            "kungfu": kungfu,
            "traits": traits,
            "equipSlots": equip_slots,
            "equipTraits": equip_traits,
        }

    def list_inventory(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for row in (self.root.val[19].val if self._is_arr(self.root.val[19]) else []):
            if not self._is_arr(row) or len(row.val) < 2:
                continue
            out.append({"id": self._as_str(row.val[0]), "amount": self._as_int(row.val[1])})
        return out

    @staticmethod
    def _try_parse_flag_i64_u64_str(s: str):
        if not isinstance(s, str) or not s or "\n" in s or "\r" in s:
            return ("syntax", None)
        neg = s[0] == "-"
        digits = s[1:] if neg else s
        if not digits or not all("0" <= ch <= "9" for ch in digits):
            return ("syntax", None)
        sig = digits.lstrip("0") or "0"
        if neg:
            if sig == "0":
                return ("ok", 0)
            if len(sig) > 19 or (len(sig) == 19 and sig > "9223372036854775808"):
                return ("range", None)
            return ("ok", -int(sig))
        if len(sig) > 20 or (len(sig) == 20 and sig > "18446744073709551615"):
            return ("range", None)
        return ("ok", int(sig))

    def list_flags(self, q: str = "") -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        flag_str = self._as_str(self.root.val[7])
        for part in flag_str.split("|"):
            if not part:
                continue
            if "&" in part:
                key, val = part.split("&", 1)
                st_f, parsed_f = self._try_parse_flag_i64_u64_str(val.strip())
                int_val = parsed_f if st_f == "ok" and parsed_f is not None else 0
                if not q or q in key:
                    out.append({"key": key, "value": int_val, "source": "strFlagDatas"})
        for row in (self.root.val[6].val if self._is_arr(self.root.val[6]) else []):
            if self._is_arr(row) and len(row.val) >= 2:
                key = self._as_str(row.val[0])
                val = self._as_int(row.val[1])
                if not q or q in key:
                    out.append({"key": key, "value": val, "source": "flag"})
        return out

    def validate(self) -> Dict[str, Any]:
        errors: List[str] = []
        warnings: List[str] = []
        g = self.root.val
        if not self._is_arr(self.root) or len(g) != 54:
            errors.append("GameData 루트는 54개 필드여야 합니다.")
            return {"ok": False, "errors": errors, "warnings": warnings}
        if not (self._is_arr(g[3]) and len(g[3].val) >= 1):
            errors.append("GameData[3]은 비어 있지 않은 배열이어야 합니다.")
        if not (
            isinstance(g[9], MPNode)
            and g[9].tag in ("str", "str8", "str16", "str32")
            and str(g[9].val) != ""
        ):
            errors.append("GameData[9]은 비어 있지 않은 문자열이어야 합니다.")
        if not (
            isinstance(g[7], MPNode)
            and (g[7].tag == "nil" or g[7].tag in ("str", "str8", "str16", "str32"))
        ):
            errors.append("GameData[7]은 nil 또는 문자열이어야 합니다.")
        elif g[7].tag in ("str", "str8", "str16", "str32") and str(g[7].val) != "":
            for seg in str(g[7].val).split("|"):
                if not seg:
                    continue
                kv = seg.split("&")
                if len(kv) != 2 or not kv[0]:
                    errors.append("GameData[7] 문자열 플래그 형식이 올바르지 않습니다.")
                    break
                st_f, _ = self._try_parse_flag_i64_u64_str(kv[1])
                if st_f == "syntax":
                    errors.append("GameData[7] 문자열 플래그 형식이 올바르지 않습니다.")
                    break
                elif st_f == "range":
                    errors.append("GameData[7] 문자열 플래그 값이 64비트 정수 범위를 벗어났습니다.")
                    break
        for k in (6, 19, 20, 21, 30, 40, 41, 42, 43):
            if not (
                isinstance(g[k], MPNode)
                and (
                    g[k].tag == "nil"
                    or (
                        self._is_arr(g[k])
                        and isinstance(g[k].val, list)
                    )
                )
            ):
                errors.append(f"GameData[{k}]은 nil 또는 배열이어야 합니다.")
                continue
            if k in (20, 21, 40, 41, 42, 43) and self._is_arr(g[k]):
                if not all(
                    isinstance(e, MPNode)
                    and e.tag in ("str", "str8", "str16", "str32")
                    for e in g[k].val
                ):
                    errors.append(f"GameData[{k}]의 원소는 문자열이어야 합니다.")
            if k in (6, 19) and self._is_arr(g[k]):
                for row in g[k].val:
                    if not (
                        isinstance(row, MPNode)
                        and self._is_arr(row)
                        and len(row.val) >= 2
                        and isinstance(row.val[0], MPNode)
                        and row.val[0].tag in ("str", "str8", "str16", "str32")
                        and isinstance(row.val[1], MPNode)
                        and row.val[1].tag in _MP_INT_TAGS
                        and isinstance(row.val[1].val, int)
                        and not isinstance(row.val[1].val, bool)
                    ):
                        errors.append(f"GameData[{k}]의 행은 [문자열, 정수]여야 합니다.")
                        break
                    if k == 6 and str(row.val[0].val) == "":
                        errors.append("GameData[6] 정수 플래그 키가 비어 있습니다.")
                        break
                    if k == 19 and str(row.val[0].val) == "":
                        errors.append("GameData[19] 아이템 ID가 비어 있습니다.")
                        break
        if len(g) > 3 and self._is_arr(g[3]):
            for ci, chara in enumerate(g[3].val):
                if not self._is_arr(chara) or len(chara.val) != 29:
                    errors.append(f"SimpleCharaData[{ci}] 길이가 29가 아닙니다.")
                    continue
                c = chara.val
                if not (
                    isinstance(c[1], MPNode)
                    and c[1].tag in ("str", "str8", "str16", "str32")
                    and str(c[1].val) != ""
                ):
                    errors.append(f"SimpleCharaData[{ci}][1]은 비어 있지 않은 문자열이어야 합니다.")
                for k in (9, 10, 11, 13, 28):
                    if not _is_int_node(c[k]):
                        errors.append(f"SimpleCharaData[{ci}][{k}]은 정수여야 합니다.")
                for k in (8, 24, 25, 26):
                    if not (
                        isinstance(c[k], MPNode)
                        and (c[k].tag == "nil" or c[k].tag in ("str", "str8", "str16", "str32"))
                    ):
                        errors.append(f"SimpleCharaData[{ci}][{k}]은 nil 또는 문자열이어야 합니다.")
                for k in (15, 16, 18, 19, 20, 22):
                    if not (
                        isinstance(c[k], MPNode)
                        and (
                            c[k].tag == "nil"
                            or (
                                self._is_arr(c[k])
                                and isinstance(c[k].val, list)
                                and all(
                                    isinstance(e, MPNode)
                                    and e.tag in ("str", "str8", "str16", "str32")
                                    for e in c[k].val
                                )
                            )
                        )
                    ):
                        errors.append(f"SimpleCharaData[{ci}][{k}]은 nil 또는 문자열 배열이어야 합니다.")
                cid = self._as_str(c[1])
                if len(c) > 15 and self._is_arr(c[15]):
                    for r in c[15].val:
                        if r.tag in ("str", "str8", "str16", "str32"):
                            parts = str(r.val).split(",")
                            if len(parts) != 5:
                                errors.append(f"{cid} c[15] CSV 필드 수 오류: {len(parts)}")
                if len(c) > 18 and self._is_arr(c[18]):
                    for r in c[18].val:
                        if r.tag in ("str", "str8", "str16", "str32"):
                            parts = str(r.val).split(",")
                            if len(parts) > 9:
                                errors.append(f"{cid} c[18] CSV 필드 수 초과: {len(parts)}")
                if len(c) > 20 and self._is_arr(c[20]):
                    if len(c[20].val) != 3:
                        errors.append(f"{cid} c[20] 장비 슬롯은 3개여야 합니다.")
                    for r in c[20].val:
                        if r.tag not in ("str", "str8", "str16", "str32") or str(r.val) == "":
                            errors.append(f"{cid} c[20] 장비 슬롯 문자열이 비었습니다.")
                if len(c) > 22 and self._is_arr(c[22]):
                    for r in c[22].val:
                        if r.tag in ("str", "str8", "str16", "str32"):
                            parts = str(r.val).split("|", 1)
                            if len(parts) != 2 or parts[0] not in ("1","2","3","4","5","6","7","8","9"):
                                errors.append(f"{cid} c[22] 장비 특성 슬롯 오류")
        if len(g) > 21 and self._is_arr(g[21]) and len(g[21].val) > 5:
            errors.append("FollowList는 최대 5명입니다.")
        if len(g) > 21 and self._is_arr(g[21]):
            pid = self._as_str(g[9])
            if pid and any(self._as_str(x) == pid for x in g[21].val):
                errors.append("FollowList에 playerid가 포함되어 있습니다.")
        for idx, name in ((14, "m_Money"), (15, "m_Epiphany")):
            if len(g) > idx:
                if not _is_int_node(g[idx]):
                    errors.append(f"{name} 필드가 정수가 아닙니다.")
                elif int(g[idx].val) < 0:
                    errors.append(f"{name}가 음수입니다.")
        for idx, name in ((16, "m_PlayRound"), (24, "Game_Mode"), (33, "m_ShovelDurable")):
            if len(g) > idx and not _is_int_node(g[idx]):
                errors.append(f"{name} 필드가 정수가 아닙니다.")
        for idx, name in ((25, "m_ArenaWinCount"), (36, "m_DaTianWangSiLevel")):
            if len(g) > idx and isinstance(g[idx], MPNode) and g[idx].tag != "nil":
                if not _is_int_node(g[idx]):
                    errors.append(f"{name} 필드가 정수가 아닙니다.")
                elif int(g[idx].val) < 0:
                    errors.append(f"{name}가 음수입니다.")
        for idx in (8, 10, 51):
            if len(g) > idx and not (
                isinstance(g[idx], MPNode)
                and (g[idx].tag == "nil" or g[idx].tag in ("str", "str8", "str16", "str32"))
            ):
                errors.append(f"GameData[{idx}]은 nil 또는 문자열이어야 합니다.")
        for idx, name in ((26, "m_Arena_Rewards_JunShan"), (37, "m_Arena_Rewards_DaTianWangSi")):
            if len(g) > idx and isinstance(g[idx], MPNode) and g[idx].tag != "nil":
                if g[idx].tag not in ("str", "str8", "str16", "str32"):
                    errors.append(f"{name} 필드가 nil 또는 문자열이어야 합니다.")
                elif "\r" in str(g[idx].val) or "\n" in str(g[idx].val):
                    errors.append(f"{name}에 줄바꿈을 사용할 수 없습니다.")
        for idx, name in (
            (38, "m_DongShuFactionMember"),
            (47, "m_JinWuFactionMember"),
            (48, "m_XiBoFactionMember"),
            (52, "m_BeiGuFactionMember"),
        ):
            if len(g) > idx and isinstance(g[idx], MPNode) and g[idx].tag != "nil":
                if g[idx].tag not in ("str", "str8", "str16", "str32"):
                    errors.append(f"{name} 필드가 nil 또는 문자열이어야 합니다.")
                elif any(ch in str(g[idx].val) for ch in ("\r", "\n", ",", "&")):
                    errors.append(f"{name}에 쉼표(,), &, 줄바꿈을 사용할 수 없습니다.")
        def _check_int_nodes(node, depth=0):
            if depth > MAX_MSGPACK_DEPTH:
                errors.append("MessagePack 중첩 깊이 초과")
                return
            if not isinstance(node, MPNode):
                return
            if node.tag in _MP_INT_TAGS:
                if (
                    isinstance(node.val, bool)
                    or not isinstance(node.val, int)
                    or node.val < -9223372036854775808
                    or node.val > 0xffffffffffffffff
                ):
                    errors.append("MessagePack 정수 허용 범위를 벗어난 값이 있습니다.")
                    return
            val = getattr(node, "val", None)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, tuple) and len(item) == 2:
                        _check_int_nodes(item[0], depth + 1)
                        _check_int_nodes(item[1], depth + 1)
                    else:
                        _check_int_nodes(item, depth + 1)
        _check_int_nodes(self.root, 0)
        if len(g) > 17 and (not isinstance(g[17], MPNode) or not _is_finite_f32_node(g[17])):
            errors.append("g[17] 값이 유한한 float32 범위를 벗어났습니다.")
        if len(g) > 3:
            chara_container = g[3].val if isinstance(g[3], MPNode) else g[3]
            if isinstance(chara_container, list):
                for chara in chara_container:
                    if isinstance(chara, MPNode) and isinstance(chara.val, list) and len(chara.val) >= 29:
                        if not _is_finite_f32_node(chara.val[6]):
                            errors.append("chara.val[6] 값이 유한한 float32 범위를 벗어났습니다.")
                        if not _is_finite_f32_node(chara.val[7]):
                            errors.append("chara.val[7] 값이 유한한 float32 범위를 벗어났습니다.")
        if len(g) > 19 and self._is_arr(g[19]):
            for r in g[19].val:
                if self._is_arr(r) and len(r.val) >= 2 and self._as_int(r.val[1]) < 0:
                    errors.append("아이템 수량이 음수입니다.")
        for cid in self._dynamic_items:
            if self.catalog.get("items") and cid not in self.catalog["items"]:
                warnings.append(f"동적 아이템 ID를 카탈로그에서 찾지 못했습니다: {cid}")
        for cid in self._dynamic_kungfu:
            if self.catalog.get("kungfu") and cid not in self.catalog["kungfu"]:
                warnings.append(f"동적 무공 ID를 카탈로그에서 찾지 못했습니다: {cid}")
        return {"ok": not errors, "errors": errors, "warnings": warnings}

    @staticmethod
    def _normalize_single_line_str(val: Any, label: str) -> str:
        text = "" if val is None else str(val)
        if "\r" in text or "\n" in text:
            raise ValueError(f"{label}에 줄바꿈을 사용할 수 없습니다.")
        return text

    @staticmethod
    def _normalize_faction_members(val: Any, label: str) -> str:
        if val is None:
            return ""
        tokens = val.split("|") if isinstance(val, str) else list(val)
        out: List[str] = []
        seen: set[str] = set()
        for item in tokens:
            tok = str(item).strip()
            if not tok:
                continue
            if any(ch in tok for ch in ("\r", "\n", ",", "&")) or any(ch.isspace() for ch in tok):
                raise ValueError(f"{label} ID에 공백, 쉼표(,), &, 줄바꿈을 사용할 수 없습니다: {tok!r}")
            if tok not in seen:
                seen.add(tok)
                out.append(tok)
        return "|".join(out)

    @staticmethod
    def _normalize_special_wanted_list(val: Any) -> List[str]:
        if val is None:
            return []
        tokens = val.split("|") if isinstance(val, str) else list(val)
        out: List[str] = []
        seen: set[str] = set()
        for item in tokens:
            tok = str(item).strip()
            if not tok:
                continue
            if any(ch in tok for ch in ("|", ",", "&", "\r", "\n")):
                raise ValueError(f"특수 현상수배 ID에 구분자(|, &, ,)나 줄바꿈을 사용할 수 없습니다: {tok!r}")
            if tok not in seen:
                seen.add(tok)
                out.append(tok)
        return out

    def set_world(
        self,
        money=None,
        epiphany=None,
        play_round=None,
        field_speed=None,
        shovel_durable=None,
        game_mode=None,
        born_id=None,
        scene_before=None,
        arena_win_count=None,
        arena_rewards_junshan=None,
        datianwangsi_level=None,
        arena_rewards_datianwangsi=None,
        dongshu_members=None,
        jinwu_members=None,
        xibo_members=None,
        beigu_members=None,
        special_wanted_list=None,
    ) -> None:
        g = self.root.val
        if money is not None:
            set_mp_int(g[14], money)
        if epiphany is not None:
            set_mp_int(g[15], epiphany)
        if play_round is not None:
            set_mp_int(g[16], play_round)
        if field_speed is not None:
            set_mp_f32(g[17], field_speed)
        if shovel_durable is not None:
            set_mp_int(g[33], shovel_durable)
        if game_mode is not None:
            set_mp_int(g[24], game_mode)
        if born_id is not None:
            set_mp_str(g[8], str(born_id))
        if scene_before is not None:
            set_mp_str(g[10], str(scene_before))
        if arena_win_count is not None:
            if isinstance(arena_win_count, bool) or not isinstance(arena_win_count, int):
                raise ValueError("m_ArenaWinCount는 정수여야 합니다.")
            if arena_win_count < 0:
                raise ValueError("m_ArenaWinCount는 0 이상이어야 합니다.")
            set_mp_int(g[25], arena_win_count)
        if arena_rewards_junshan is not None:
            set_mp_str(g[26], self._normalize_single_line_str(arena_rewards_junshan, "m_Arena_Rewards_JunShan"))
        if datianwangsi_level is not None:
            if isinstance(datianwangsi_level, bool) or not isinstance(datianwangsi_level, int):
                raise ValueError("m_DaTianWangSiLevel은 정수여야 합니다.")
            if datianwangsi_level < 0:
                raise ValueError("m_DaTianWangSiLevel은 0 이상이어야 합니다.")
            set_mp_int(g[36], datianwangsi_level)
        if arena_rewards_datianwangsi is not None:
            set_mp_str(g[37], self._normalize_single_line_str(arena_rewards_datianwangsi, "m_Arena_Rewards_DaTianWangSi"))
        if dongshu_members is not None:
            set_mp_str(g[38], self._normalize_faction_members(dongshu_members, "m_DongShuFactionMember"))
        if jinwu_members is not None:
            set_mp_str(g[47], self._normalize_faction_members(jinwu_members, "m_JinWuFactionMember"))
        if xibo_members is not None:
            set_mp_str(g[48], self._normalize_faction_members(xibo_members, "m_XiBoFactionMember"))
        if beigu_members is not None:
            set_mp_str(g[52], self._normalize_faction_members(beigu_members, "m_BeiGuFactionMember"))
        if special_wanted_list is not None:
            items = self._normalize_special_wanted_list(special_wanted_list)
            node = g[43]
            node.tag = "arr"
            node.val = [MPNode("str", x) for x in items]
            node.raw = None

    def set_char_basic(self, chara_id, hero_name=None, hp=None, mp=None, lv=None, exp=None, relationship=None, talent=None, nick_name=None, guild=None, training_id=None) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        c = chara.val
        if hero_name is not None:
            if "," in str(hero_name):
                raise ValueError("영웅 이름에는 쉼표를 사용할 수 없습니다.")
            found = False
            for row in self._char_rows(chara, 18):
                if row.tag not in ("str", "str8", "str16", "str32"):
                    continue
                parts = str(row.val).split(",")
                if parts and parts[0] == "12003":
                    while len(parts) < 9:
                        parts.append("")
                    parts[1] = str(hero_name)
                    set_mp_str(row, ",".join(parts[:9]))
                    found = True
                    break
            if not found:
                self._ensure_arr(c[18]).append(MPNode("str", f"12003,{hero_name},0,0,0,0,0,0,0"))
        if hp is not None:
            set_mp_f32(c[6], hp)
        if mp is not None:
            set_mp_f32(c[7], mp)
        if lv is not None:
            set_mp_int(c[9], lv)
        if exp is not None:
            set_mp_int(c[10], exp)
        if relationship is not None:
            set_mp_int(c[11], relationship)
        if talent is not None:
            set_mp_int(c[13], talent)
        if nick_name is not None:
            set_mp_str(c[25], str(nick_name))
        if guild is not None:
            set_mp_str(c[26], str(guild))
        if training_id is not None:
            set_mp_str(c[8], str(training_id))

    def set_char_stat(self, chara_id, stat_id, alter_val) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        sid = str(stat_id)
        for row in self._char_rows(chara, 18):
            if row.tag not in ("str", "str8", "str16", "str32"):
                continue
            parts = str(row.val).split(",")
            if parts and parts[0] == sid:
                while len(parts) < 9:
                    parts.append("")
                parts[3] = str(alter_val)
                set_mp_str(row, ",".join(parts[:9]))
                return
        self._ensure_arr(chara.val[18]).append(MPNode("str", f"{sid},,0,{alter_val},0,0,0,0,0"))

    def upsert_kungfu(self, chara_id, kf_id, lv=10, prof=9999, in_battle=None) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        kid = str(kf_id)
        found = False
        for row in self._char_rows(chara, 15):
            if row.tag not in ("str", "str8", "str16", "str32"):
                continue
            parts = str(row.val).split(",")
            if parts and parts[0] == kid:
                while len(parts) < 5:
                    parts.append("")
                parts[1] = str(int(lv))
                parts[2] = str(int(lv))
                parts[3] = str(int(prof))
                parts[4] = "False"
                set_mp_str(row, ",".join(parts[:5]))
                found = True
                break
        if not found:
            self._ensure_arr(chara.val[15]).append(MPNode("str", f"{kid},{int(lv)},{int(lv)},{int(prof)},False"))
        if in_battle is True:
            battle = chara.val[16]
            if not any(self._as_str(x) == kid for x in self._ensure_arr(battle)):
                battle.val.append(MPNode("str", kid))
        elif in_battle is False and self._is_arr(chara.val[16]):
            chara.val[16].val = [x for x in chara.val[16].val if self._as_str(x) != kid]

    def remove_kungfu(self, chara_id, kf_id) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        kid = str(kf_id)
        if self._is_arr(chara.val[15]):
            chara.val[15].val = [x for x in chara.val[15].val if not (x.tag in ("str", "str8", "str16", "str32") and str(x.val).split(",")[0] == kid)]
        if self._is_arr(chara.val[16]):
            chara.val[16].val = [x for x in chara.val[16].val if self._as_str(x) != kid]
        if self._as_str(chara.val[8]) == kid:
            set_mp_str(chara.val[8], "0")

    def add_trait(self, chara_id, trait_id) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        tid = str(trait_id)
        if not any(self._as_str(x) == tid for x in self._ensure_arr(chara.val[19])):
            chara.val[19].val.append(MPNode("str", tid))

    def remove_trait(self, chara_id, trait_id) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        tid = str(trait_id)
        if self._is_arr(chara.val[19]):
            chara.val[19].val = [x for x in chara.val[19].val if self._as_str(x) != tid]
        if self._is_arr(chara.val[22]):
            for row in chara.val[22].val:
                if row.tag in ("str", "str8", "str16", "str32"):
                    parts = str(row.val).split("|", 1)
                    if len(parts) == 2 and parts[1] == tid:
                        set_mp_str(row, f"{parts[0]}|")

    def set_equip_trait(self, chara_id, slot_1_to_9, trait_id) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        slot = int(slot_1_to_9)
        if slot < 1 or slot > 9:
            raise ValueError("장비 특성 슬롯은 1~9입니다.")
        tid = "" if trait_id is None else str(trait_id)
        target = f"{slot}|{tid}"
        for row in self._ensure_arr(chara.val[22]):
            if row.tag in ("str", "str8", "str16", "str32") and str(row.val).split("|", 1)[0] == str(slot):
                set_mp_str(row, target)
                return
        chara.val[22].val.append(MPNode("str", target))

    def set_equip(self, chara_id, slot_0_to_2, item_id) -> None:
        chara = self._find_character_node(chara_id)
        if chara is None:
            raise KeyError(f"캐릭터를 찾을 수 없습니다: {chara_id}")
        slot = int(slot_0_to_2)
        if slot < 0 or slot > 2:
            raise ValueError("장비 슬롯은 0~2입니다.")
        iid = str(item_id) if item_id not in (None, "", "0") else "0"
        rows = self._ensure_arr(chara.val[20])
        while len(rows) < 3:
            rows.append(MPNode("str", "0"))
        set_mp_str(rows[slot], iid)

    def set_item(self, item_id, amount) -> None:
        if int(amount) < 1:
            raise ValueError("아이템 수량은 1 이상이어야 합니다.")
        iid = str(item_id)
        rows = self._ensure_arr(self.root.val[19])
        matches = [r for r in rows if self._is_arr(r) and len(r.val) >= 2 and self._as_str(r.val[0]) == iid]
        if matches:
            set_mp_int(matches[0].val[1], amount)
            keep_ids = {id(r) for r in matches[1:]}
            rows[:] = [r for r in rows if id(r) not in keep_ids]
            return
        rows.append(MPNode("arr", [MPNode("str", iid), mp_int(amount)]))

    def remove_item(self, item_id) -> None:
        if not self._is_arr(self.root.val[19]):
            return
        iid = str(item_id)
        rows = self.root.val[19].val
        if iid == "999":
            for r in rows:
                if self._is_arr(r) and len(r.val) >= 2 and self._as_str(r.val[0]) == "999":
                    set_mp_int(r.val[1], 0)
            return
        rows[:] = [r for r in rows if not (self._is_arr(r) and len(r.val) >= 2 and self._as_str(r.val[0]) == iid)]

    def set_party(self, chara_id, in_full_team=None, in_follow=None) -> None:
        cid = str(chara_id)
        pid = self._as_str(self.root.val[9])
        full = self.root.val[20]
        follow = self.root.val[21]
        if in_full_team is True:
            if not any(self._as_str(x) == cid for x in self._ensure_arr(full)):
                full.val.append(MPNode("str", cid))
        elif in_full_team is False:
            if self._is_arr(full):
                full.val = [x for x in full.val if self._as_str(x) != cid]
        if in_follow is True:
            if cid == pid:
                raise ValueError("주인공은 FollowList에 포함할 수 없습니다.")
            if not any(self._as_str(x) == cid for x in self._ensure_arr(follow)):
                if len(follow.val) >= 5:
                    raise ValueError("FollowList는 최대 5명입니다.")
                follow.val.append(MPNode("str", cid))
        elif in_follow is False:
            if self._is_arr(follow):
                follow.val = [x for x in follow.val if self._as_str(x) != cid]

    @staticmethod
    def _parse_flag_int64_u64(val: Any) -> int:
        if isinstance(val, bool):
            raise ValueError("플래그 값이 유효한 정수가 아닙니다.")
        if isinstance(val, int):
            iv = val
        elif isinstance(val, str):
            st_f, parsed_f = WokSaveSession._try_parse_flag_i64_u64_str(val.strip())
            if st_f == "syntax":
                raise ValueError("플래그 값이 유효한 정수가 아닙니다.")
            if st_f == "range" or parsed_f is None:
                raise ValueError("플래그 값이 64비트 정수 범위를 벗어났습니다.")
            iv = parsed_f
        elif isinstance(val, float):
            if not val.is_integer():
                raise ValueError("플래그 값이 유효한 정수가 아닙니다.")
            iv = int(val)
        else:
            raise ValueError("플래그 값이 유효한 정수가 아닙니다.")
        if iv < -(1 << 63) or iv > (1 << 64) - 1:
            raise ValueError("플래그 값이 64비트 정수 범위를 벗어났습니다.")
        return iv

    def set_str_flag(self, key, int_val) -> None:
        k = str(key)
        if not k:
            raise ValueError("플래그 키는 비어 있을 수 없습니다.")
        if "|" in k or "&" in k:
            raise ValueError("플래그 키에는 | 또는 &를 사용할 수 없습니다.")
        iv = self._parse_flag_int64_u64(int_val)
        node = self.root.val[7]
        parts = self._as_str(node).split("|") if self._as_str(node) else []
        replaced = False
        out = []
        for part in parts:
            if "&" in part:
                pk, _ = part.split("&", 1)
                if pk == k:
                    out.append(f"{k}&{iv}")
                    replaced = True
                else:
                    out.append(part)
            elif part:
                out.append(part)
        if not replaced:
            out.append(f"{k}&{iv}")
        set_mp_str(node, "|".join(out))

    def set_int_flag(self, key, int_val) -> None:
        k = str(key)
        if not k:
            raise ValueError("플래그 키는 비어 있을 수 없습니다.")
        iv = self._parse_flag_int64_u64(int_val)
        rows = self._ensure_arr(self.root.val[6])
        matches = [r for r in rows if self._is_arr(r) and len(r.val) >= 1 and self._as_str(r.val[0]) == k]
        if matches:
            set_mp_int(matches[0].val[1], iv)
            remove_ids = {id(r) for r in matches[1:]}
            rows[:] = [r for r in rows if id(r) not in remove_ids]
            return
        rows.append(MPNode("arr", [MPNode("str", k), mp_int(iv)]))

    def apply_preset(self, preset_id, chara_id=None) -> None:
        pid = str(preset_id)
        g = self.root.val

        def _hero():
            hero_pid = self._as_str(g[9])
            for c in g[3].val:
                if self._as_str(c.val[1]) == hero_pid:
                    return c
            return g[3].val[0] if g[3].val else None

        def _ecma_num_to_str(fx):
            s = repr(abs(fx))
            if 'e' in s or 'E' in s:
                mant, exp_s = re.split('[eE]', s, maxsplit=1)
                exp = int(exp_s)
            else:
                mant, exp = s, 0
            if '.' in mant:
                ip, fp = mant.split('.')
                digits = (ip + fp).lstrip('0')
                n = (len(ip) + exp) if ip != '0' else (exp - (len(fp) - len(fp.lstrip('0'))))
            else:
                digits = mant.lstrip('0')
                n = len(digits) + exp
            digits = digits.rstrip('0') or '0'
            k = len(digits)
            if k <= n <= 21:
                out = digits + ('0' * (n - k))
            elif 0 < n < k:
                out = digits[:n] + '.' + digits[n:]
            elif -6 < n <= 0:
                out = '0.' + ('0' * (-n)) + digits
            else:
                sig = digits[0] if k == 1 else (digits[0] + '.' + digits[1:])
                esign = '+' if (n - 1) >= 0 else '-'
                out = f"{sig}e{esign}{abs(n - 1)}"
            return ('-' + out) if fx < 0.0 else out

        def fmt_num(x):
            fx = float(x)
            if not math.isfinite(fx) or fx == 0.0:
                return "0"
            if fx.is_integer():
                return _ecma_num_to_str(fx)
            q = decimal.Decimal.from_float(abs(fx)).quantize(decimal.Decimal("0.0001"), rounding=decimal.ROUND_HALF_UP, context=decimal.Context(prec=64))
            if q == 0:
                return "0"
            s = format(q, "f").rstrip("0").rstrip(".")
            return ("-" + s) if fx < 0 else s

        def _to_int(value):
            try:
                f = float(value)
            except (TypeError, ValueError):
                return 0
            if f != f or f in (float("inf"), float("-inf")):
                return 0
            return int(f)

        def stat_fields(chara, sid):
            for row in self._char_rows(chara, 18):
                if not isinstance(row.val, str):
                    continue
                parts = row.val.split(",")
                if parts and parts[0] == sid:
                    def num(idx):
                        if idx < len(parts) and parts[idx].strip() != "":
                            try:
                                f = float(parts[idx])
                            except ValueError:
                                return 0.0
                            return f if math.isfinite(f) else 0.0
                        return 0.0
                    s_val = parts[1] if len(parts) > 1 else ""
                    return row, [sid, s_val, num(2), num(3), num(4), num(5), num(6), num(7), num(8)]
            return None, [sid, "", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

        def ensure_atom(chara, sid):
            for row in self._char_rows(chara, 18):
                if isinstance(row.val, str) and row.val.split(",")[0] == sid:
                    return
            self._ensure_arr(chara.val[18]).append(MPNode("str", f"{sid},,0,0,0,0,0,0,0"))

        def write_atom(chara, sid, born, alter, fight, roll, juqing, levelup, talent):
            row, fields = stat_fields(chara, sid)
            if row is None:
                ensure_atom(chara, sid)
                row, fields = stat_fields(chara, sid)
            s_val = str(fields[1])
            value = ",".join([
                sid,
                s_val,
                fmt_num(born),
                fmt_num(alter),
                fmt_num(fight),
                fmt_num(roll),
                fmt_num(juqing),
                fmt_num(levelup),
                fmt_num(talent),
            ])
            if row is not None:
                set_mp_str(row, value)

        def persistent_total(chara, sid):
            _, fields = stat_fields(chara, sid)
            return fields[5] + fields[7] + fields[8] + fields[3] + fields[6]

        def parse_kf(row):
            parts = str(row.val).split(",")
            kid = parts[0] if parts else ""
            lv = _to_int(parts[1]) if len(parts) > 1 else 0
            exp = _to_int(parts[2]) if len(parts) > 2 else 0
            prof = _to_int(parts[3]) if len(parts) > 3 else 0
            ab = len(parts) > 4 and parts[4].strip().lower() == "true"
            return kid, lv, exp, prof, ab

        def kf_raw(kid, lv, exp, prof, ab):
            return f"{kid},{lv},{exp},{prof},{'True' if ab else 'False'}"

        def max_lv_for(kid):
            if kid in self._dynamic_kungfu:
                return 20
            entry = self.catalog.get("kungfu", {}).get(kid, {}) if isinstance(self.catalog.get("kungfu"), dict) else {}
            if isinstance(entry, dict):
                return int(entry.get("maxLv") or entry.get("maxlv") or 20)
            return 20

        if pid == "rich_epiphany":
            set_mp_int(g[14], max(self._as_int(g[14]), 9999999))
            set_mp_int(g[15], max(self._as_int(g[15]), 999))
            set_mp_int(g[33], max(self._as_int(g[33]), 9999))
        elif pid == "hero_max_growth":
            c = _hero()
            if c is not None:
                set_mp_int(c.val[9], max(self._as_int(c.val[9]), 60))
                nt = min(0xffffffffffffffff, max(self._as_int(c.val[13]) + 100, 200))
                set_mp_int(c.val[13], nt)
                for sid in ("1003", "1005"):
                    ensure_atom(c, sid)
                    _, fields = stat_fields(c, sid)
                    alter = max(fields[3], 5000.0)
                    write_atom(c, sid, fields[2], alter, fields[4], fields[5], fields[6], fields[7], fields[8])
                set_mp_f32(c.val[6], max(self._as_float(c.val[6]), persistent_total(c, "1003")))
                set_mp_f32(c.val[7], max(self._as_float(c.val[7]), persistent_total(c, "1005")))
        elif pid == "hero_six_attributes":
            c = _hero()
            if c is not None:
                for i in range(2001, 2007):
                    sid = str(i)
                    ensure_atom(c, sid)
                    _, fields = stat_fields(c, sid)
                    persistent = fields[5] + fields[7] + fields[8] + fields[3] + fields[6]
                    alter = fields[3]
                    if persistent < 40:
                        alter += 40 - persistent
                    write_atom(c, sid, fields[2], alter, fields[4], fields[5], fields[6], fields[7], fields[8])
        elif pid == "hero_all_mastery":
            c = _hero()
            if c is not None:
                for i in range(3001, 3015):
                    sid = str(i)
                    ensure_atom(c, sid)
                    _, fields = stat_fields(c, sid)
                    persistent = fields[5] + fields[7] + fields[8] + fields[3] + fields[6]
                    alter = fields[3]
                    if persistent < 220:
                        alter += 220 - persistent
                    write_atom(c, sid, fields[2], alter, fields[4], fields[5], fields[6], fields[7], fields[8])
        elif pid == "master_all_kungfu":
            c = self._find_character_node(chara_id) if (chara_id is not None and str(chara_id) != "") else _hero()
            if c is None:
                raise ValueError("캐릭터를 찾을 수 없습니다.")
            for row in self._char_rows(c, 15):
                if not isinstance(row.val, str):
                    continue
                kid, lv, exp, prof, ab = parse_kf(row)
                if not ab:
                    lv = max(lv, max_lv_for(kid))
                    prof = max(prof, 9999)
                    set_mp_str(row, kf_raw(kid, lv, exp, prof, ab))
        elif pid == "party_recover_boost":
            hero = _hero()
            if hero is not None:
                hid = self._as_str(hero.val[1])
                ids = [hid]
                for n in (g[21].val if self._is_arr(g[21]) else []):
                    s_id = self._as_str(n)
                    if s_id not in ids:
                        ids.append(s_id)
                for cid in ids:
                    c = self._find_character_node(cid)
                    if c is None:
                        continue
                    set_mp_int(c.val[13], max(self._as_int(c.val[13]), 100))
                    if cid != hid:
                        set_mp_int(c.val[11], max(self._as_int(c.val[11]), 100))
                    for row in self._char_rows(c, 15):
                        if not isinstance(row.val, str):
                            continue
                        kid, lv, exp, prof, ab = parse_kf(row)
                        if not ab:
                            prof = max(prof, 9999)
                            set_mp_str(row, kf_raw(kid, lv, exp, prof, ab))
                    set_mp_f32(c.val[6], max(self._as_float(c.val[6]), persistent_total(c, "1003")))
                    set_mp_f32(c.val[7], max(self._as_float(c.val[7]), persistent_total(c, "1005")))
            set_mp_f32(g[17], max(self._as_float(g[17]), 2.25))
        else:
            raise ValueError(f"알 수 없는 프리셋입니다: {preset_id}")

    def to_bytes(self) -> bytes:
        result = self.validate()
        if not result["ok"]:
            raise ValueError("; ".join(result["errors"]))
        return encode_dat_bytes(self.root)


def create_demo_dat_bytes() -> bytes:
    catalog = load_catalog()
    def arr(items):
        return MPNode("arr", list(items))
    def s(v):
        return MPNode("str", str(v))
    def i(v):
        return mp_int(int(v))
    def f(v):
        return MPNode("f32", float(v))
    def chara(cid, name, nick):
        stats = [
            s("2001,,0,40,0,0,0,0,0"),
            s("2002,,0,40,0,0,0,0,0"),
            s("2003,,0,40,0,0,0,0,0"),
            s("2004,,0,40,0,0,0,0,0"),
            s("2005,,0,40,0,0,0,0,0"),
            s("2006,,0,40,0,0,0,0,0"),
            s("3001,,0,220,0,0,0,0,0"),
            s("3014,,0,220,0,0,0,0,0"),
            s("12003,%s,0,0,0,0,0,0,0" % name),
        ]
        return arr([
            s("b01"), s(cid), s(""), s(""), s(""), s(""), f(999999), f(999999), s("0"), i(99), i(99999999), i(100), s(""), i(999999), s(""), arr([
                s("1001,10,10,9999,False"),
                s("1002,10,10,9999,False"),
            ]), arr([s("1001")]), s(""), arr(stats), arr([s("90001")]), arr([s("0"), s("0"), s("0")]), s(""), arr([s(f"{n}|") for n in range(1, 10)]), s(""), s(""), s(nick), s(""), MPNode("nil", None), i(0),
        ])
    chars = [
        chara("9001", "주인공", "주인공"),
        chara("105", "동료1", "동료1"),
        chara("312", "동료2", "동료2"),
    ]
    inventory = [arr([s("999"), i(0)]), arr([s("10001"), i(10)])]
    root = arr([
        s("demo"), i(1), s("20240101000000"), arr(chars), s(""), s(""), arr([]), s(""), s("1"), s("9001"), s("0"), i(0), i(0), i(0), i(999999), i(999999), i(1), f(1.0), i(0), arr(inventory), arr([s("9001"), s("105"), s("312")]), arr([s("105"), s("312")]), i(0), i(0), i(1), i(0), s("000000000000000"), i(0), i(0), i(0), arr([]), i(0), i(0), i(100), s(""), i(0), i(0), s(""), s("1202|607"), i(0), arr([]), arr([]), arr([]), arr([]), s(""), s(""), s(""), s("9018|502"), s("202|401|402|403"), s(""), s(""), s("1.0.0"), s("205"), i(0),
    ])
    return encode_dat_bytes(root)


def _valid_save_name(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if name in (".", ".."):
        return False
    if not name.lower().endswith(".dat"):
        return False
    if any(ord(c) < 32 for c in name):
        return False
    if any(c in '<>:"/\\|?*' for c in name):
        return False
    if name.endswith(".") or name.endswith(" "):
        return False
    stem = name[:-4]
    if not stem:
        return False
    upper_stem = stem.split(".", 1)[0].upper()
    if upper_stem in ("CON", "PRN", "AUX", "NUL"):
        return False
    if len(upper_stem) == 4 and upper_stem[:3] in ("COM", "LPT") and upper_stem[3] in "123456789":
        return False
    return True


def _win32_setup_kernel32():
    import ctypes
    from ctypes import wintypes
    class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ('dwFileAttributes', wintypes.DWORD),
            ('ftCreationTime', wintypes.FILETIME),
            ('ftLastAccessTime', wintypes.FILETIME),
            ('ftLastWriteTime', wintypes.FILETIME),
            ('dwVolumeSerialNumber', wintypes.DWORD),
            ('nFileSizeHigh', wintypes.DWORD),
            ('nFileSizeLow', wintypes.DWORD),
            ('nNumberOfLinks', wintypes.DWORD),
            ('nFileIndexHigh', wintypes.DWORD),
            ('nFileIndexLow', wintypes.DWORD),
        ]
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    CreateFileW = kernel32.CreateFileW
    CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    CreateFileW.restype = wintypes.HANDLE
    GetFileInformationByHandle = kernel32.GetFileInformationByHandle
    GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(_BY_HANDLE_FILE_INFORMATION)]
    GetFileInformationByHandle.restype = wintypes.BOOL
    GetFinalPathNameByHandleW = kernel32.GetFinalPathNameByHandleW
    GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    GetFinalPathNameByHandleW.restype = wintypes.DWORD
    ReadFile = kernel32.ReadFile
    ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    ReadFile.restype = wintypes.BOOL
    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL
    return ctypes, wintypes, kernel32, _BY_HANDLE_FILE_INFORMATION


def _win32_verify_open_handle(ctypes_mod, kernel32, info_cls, h, expected_path: Path, allow_dir: bool):
    info = info_cls()
    if not kernel32.GetFileInformationByHandle(h, ctypes_mod.byref(info)):
        raise PermissionError(f'파일 정보를 가져올 수 없습니다: {expected_path}')
    is_dir = (info.dwFileAttributes & 0x10) != 0
    if (info.dwFileAttributes & 0x400) != 0:
        raise PermissionError(f'재분석 지점이 허용되지 않습니다: {expected_path}')
    if not allow_dir and is_dir:
        raise PermissionError(f'디렉터리는 읽을 수 없습니다: {expected_path}')
    if (not is_dir) and info.nNumberOfLinks > 1:
        raise PermissionError(f'하드 링크가 허용되지 않습니다: {expected_path}')
    cap = 32768
    buf = ctypes_mod.create_unicode_buffer(cap)
    n = kernel32.GetFinalPathNameByHandleW(h, buf, cap, 0)
    if n >= 32768:
        cap = n + 1
        buf = ctypes_mod.create_unicode_buffer(cap)
        n = kernel32.GetFinalPathNameByHandleW(h, buf, cap, 0)
    if n == 0:
        raise PermissionError(f'최종 경로를 가져올 수 없습니다: {expected_path}')
    final_p = buf.value
    if final_p.startswith(chr(92) * 2 + '?' + chr(92) + 'UNC' + chr(92)):
        raise PermissionError(f'UNC 경로가 허용되지 않습니다: {expected_path}')
    prefix = chr(92) * 2 + '?' + chr(92)
    if final_p.startswith(prefix):
        final_p = final_p[len(prefix):]
    if os.path.normcase(os.path.abspath(final_p)) != os.path.normcase(os.path.abspath(str(expected_path))):
        raise PermissionError(f'경로가 실제 대상과 일치하지 않습니다: {expected_path}')
    return info


def assert_no_symlinks(path: Path) -> None:
    s_raw = str(path)
    if not s_raw:
        raise PermissionError('빈 경로가 허용되지 않습니다')
    if ".." in re.split(r"[\\/]+", s_raw):
        raise PermissionError(f"상위 디렉터리 이동(..) 경로는 허용되지 않습니다: {path}")
    if os.name == 'nt':
        if s_raw.lstrip().startswith((chr(92), '//')):
            raise PermissionError('UNC 경로가 허용되지 않습니다')
        if os.path.abspath(s_raw).find(':', 2) >= 0:
            raise PermissionError('NTFS 대체 데이터 스트림(ADS)이 허용되지 않습니다')
    full = Path(os.path.abspath(str(path)))
    for q in [full, *full.parents]:
        if os.path.islink(q) or getattr(os.path, 'isjunction', lambda _: False)(q):
            raise PermissionError(f'심볼릭 링크 또는 정션이 허용되지 않습니다: {q}')
        try:
            lst = os.lstat(q)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(lst.st_mode) or (getattr(lst, 'st_file_attributes', 0) & 0x400) != 0:
            raise PermissionError(f'재분석 지점(심볼릭 링크/정션)이 허용되지 않습니다: {q}')
    try:
        lst = os.lstat(full)
    except FileNotFoundError:
        lst = None
    if lst is not None and stat.S_ISREG(lst.st_mode) and getattr(lst, 'st_nlink', 1) > 1:
        raise PermissionError(f'하드 링크가 허용되지 않습니다: {full}')
    if os.name != 'nt':
        return
    chk = None
    for q in [full, *full.parents]:
        try:
            os.lstat(q)
        except FileNotFoundError:
            continue
        chk = q
        break
    if chk is None:
        return
    (ctypes_mod, wintypes_mod, kernel32, info_cls) = _win32_setup_kernel32()
    h = kernel32.CreateFileW(str(chk), 0, 7, None, 3, 0x02200000, None)
    if h in (None, 0, ctypes_mod.c_void_p(-1).value):
        raise PermissionError(f'파일 핸들을 열 수 없습니다: {chk}')
    try:
        _win32_verify_open_handle(ctypes_mod, kernel32, info_cls, h, chk, allow_dir=True)
    finally:
        kernel32.CloseHandle(h)


def _posix_open_parent_dirfd(path: Path) -> Tuple[int, str]:
    import errno
    raw_s = str(path)
    if not raw_s or '..' in Path(raw_s).parts:
        raise PermissionError(f'안전하지 않은 경로가 허용되지 않습니다: {path}')
    full = Path(os.path.abspath(raw_s))
    parts = full.parts
    if len(parts) < 2:
        raise PermissionError(f'유효하지 않은 파일 경로입니다: {full}')
    dir_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_CLOEXEC', 0)
    step_flags = dir_flags | getattr(os, 'O_NOFOLLOW', 0)
    dfd = os.open(parts[0], dir_flags)
    for comp in parts[1:-1]:
        try:
            nfd = os.open(comp, step_flags, dir_fd=dfd)
        except OSError as exc:
            os.close(dfd)
            if exc.errno in (errno.ELOOP, errno.EMLINK, errno.ENOTDIR):
                raise PermissionError(f'심볼릭 링크 또는 안전하지 않은 부모 디렉터리가 허용되지 않습니다: {full}') from exc
            raise
        os.close(dfd)
        dfd = nfd
    st_dir = os.fstat(dfd)
    if not stat.S_ISDIR(st_dir.st_mode) or getattr(st_dir, 'st_nlink', 1) == 0:
        os.close(dfd)
        raise PermissionError(f'유효하지 않은 부모 디렉터리입니다: {full}')
    return (dfd, parts[-1])


def _posix_read_from_dirfd(parent_fd: int, leaf: str, label: Path, max_bytes: int, allow_empty: bool) -> bytes:
    import errno
    limit = max_bytes + 1
    try:
        fd = os.open(leaf, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0), dir_fd=parent_fd)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EMLINK, errno.EISDIR):
            raise PermissionError(f'안전하지 않은 파일입니다: {label}') from exc
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or getattr(st, 'st_nlink', 1) > 1:
            raise PermissionError(f'안전하지 않은 파일입니다: {label}')
        lst2 = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if lst2.st_ino != st.st_ino or lst2.st_dev != st.st_dev:
            raise PermissionError(f'경로가 실제 대상과 일치하지 않습니다: {label}')
        if (not allow_empty and st.st_size <= 0) or st.st_size > max_bytes:
            raise ValueError('save file size out of allowed bounds')
        chunks = []
        total = 0
        while total < limit:
            chunk = os.read(fd, min(65536, limit - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if (not allow_empty and total <= 0) or total > max_bytes:
            raise ValueError('save file size out of allowed bounds')
        return b''.join(chunks)
    finally:
        os.close(fd)


def _read_verified_file_bounded(path: Path, max_bytes: int = MAX_COMPRESSED_DAT_BYTES, allow_empty: bool = False) -> bytes:
    assert_no_symlinks(Path(path))
    full = Path(os.path.abspath(str(path)))
    limit = max_bytes + 1
    if os.name == 'nt':
        (ctypes_mod, wintypes_mod, kernel32, info_cls) = _win32_setup_kernel32()
        h = kernel32.CreateFileW(str(full), 0x80000000, 1, None, 3, 0x08200000, None)
        if h in (None, 0, ctypes_mod.c_void_p(-1).value):
            err = ctypes_mod.get_last_error()
            if err in (2, 3):
                raise FileNotFoundError(str(full))
            if err in (5, 1920):
                raise PermissionError(f'파일 핸들을 열 수 없습니다: {full}')
            raise OSError(err, f'CreateFileW failed: {full}')
        try:
            info = _win32_verify_open_handle(ctypes_mod, kernel32, info_cls, h, full, allow_dir=False)
            fsize = (int(info.nFileSizeHigh) << 32) | int(info.nFileSizeLow)
            if (not allow_empty and fsize <= 0) or fsize > max_bytes:
                raise ValueError('save file size out of allowed bounds')
            chunks = []
            total = 0
            while total < limit:
                to_read = min(65536, limit - total)
                buf = ctypes_mod.create_string_buffer(65536)
                nread = wintypes_mod.DWORD(0)
                if not kernel32.ReadFile(h, buf, to_read, ctypes_mod.byref(nread), None):
                    raise OSError(ctypes_mod.get_last_error(), f'ReadFile failed: {full}')
                if nread.value == 0:
                    break
                chunks.append(buf.raw[:int(nread.value)])
                total += int(nread.value)
            if (not allow_empty and total <= 0) or total > max_bytes:
                raise ValueError('save file size out of allowed bounds')
            return b''.join(chunks)
        finally:
            kernel32.CloseHandle(h)
    pfd, leaf = _posix_open_parent_dirfd(Path(path))
    try:
        return _posix_read_from_dirfd(pfd, leaf, full, max_bytes, allow_empty)
    finally:
        os.close(pfd)


def _read_save_bytes(path: Path) -> bytes:
    return _read_verified_file_bounded(Path(path), MAX_COMPRESSED_DAT_BYTES, allow_empty=False)

def _scan_proc_for_game(proc_root: Path = Path("/proc")) -> List[str]:
    proc_root = Path(proc_root)
    found: List[str] = []
    full_targets = {"theworldofkongfu", "theworldofkungfu"}
    comm_targets = {"theworldofkongf", "theworldofkungf"}
    if not proc_root.is_dir():
        return found
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = entry.name
        matched: Optional[str] = None
        try:
            name = (entry / "comm").read_text(encoding="utf-8", errors="ignore").strip().lower()
        except OSError:
            name = ""
        if name in comm_targets or name in full_targets:
            matched = name
        if matched is None:
            try:
                raw_cmd = (entry / "cmdline").read_bytes()
            except OSError:
                raw_cmd = b""
            argv0 = raw_cmd.split(b"\x00", 1)[0].decode("utf-8", errors="ignore")
            base = Path(argv0).name.lower() if argv0 else ""
            if base in full_targets:
                matched = base
        if matched is not None:
            found.append(f"pid {pid}: {matched}")
    return found


def _scan_posix_ps_for_game(ps_comm_output: Optional[str] = None, ps_args_output: Optional[str] = None) -> List[str]:
    targets = {"theworldofkongfu", "theworldofkungfu", "theworldofkongf", "theworldofkungf"}
    my_pid = os.getpid()
    found: List[str] = []
    matched_pids: set[int] = set()

    def _exe_base(raw_path: str) -> str:
        base = raw_path.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if base.endswith(".exe"):
            base = base[:-4]
        return base

    ps_ok = True
    comm_out = ps_comm_output
    if comm_out is None:
        try:
            res = subprocess.run(
                ["ps", "-axo", "pid=,comm="],
                capture_output=True, text=True, timeout=5,
            )
            if res.returncode != 0:
                res = subprocess.run(
                    ["ps", "-A", "-o", "pid=,comm="],
                    capture_output=True, text=True, timeout=5,
                )
            if res.returncode != 0:
                ps_ok = False
                comm_out = ""
            else:
                comm_out = res.stdout
        except Exception:
            ps_ok = False
            comm_out = ""

    for line in (comm_out or "").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        if pid == my_pid:
            continue
        base = _exe_base(parts[1])
        if base in targets:
            matched_pids.add(pid)
            found.append(f"pid {pid}: {base}")

    args_out = ps_args_output
    if args_out is None and ps_ok:
        try:
            res = subprocess.run(
                ["ps", "-axo", "pid=,args="],
                capture_output=True, text=True, timeout=5,
            )
            if res.returncode == 0:
                args_out = res.stdout
            else:
                args_out = ""
        except Exception:
            args_out = ""

    for line in (args_out or "").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        if pid == my_pid or pid in matched_pids:
            continue
        try:
            argv = shlex.split(parts[1])
        except ValueError:
            argv = parts[1].split()
        if not argv:
            continue
        argv0_base = _exe_base(argv[0])
        matched = argv0_base in targets
        is_wine = argv0_base in {"wine", "wine64", "wine-preloader", "wine64-preloader"}
        if is_wine and len(argv) > 1:
            matched = matched or _exe_base(argv[1]) in targets
        if not matched:
            cmd_rest = parts[1].strip()
            exec_part = (cmd_rest.split(None, 1)[1] if (is_wine and len(cmd_rest.split(None, 1)) > 1) else cmd_rest).split(" -", 1)[0].strip()
            if (
                (is_wine or exec_part.startswith(("/", ".")) or re.match(r"^[A-Za-z]:[/\\]", exec_part))
                and not re.search(r"\.(?:py|js|sh|ps1)\b", exec_part, re.IGNORECASE)
                and re.search(r"(?:^|[/\\])(theworldofk[ou]ngfu?)(?:\.exe)?$", exec_part, re.IGNORECASE)
            ):
                matched = True
        if matched:
            matched_pids.add(pid)
            found.append(f"pid {pid}: {argv0_base}")

    if not ps_ok and not found:
        try:
            for name in ("TheWorldOfKongFu", "TheWorldOfKungFu", "TheWorldOfKongF", "TheWorldOfKungF"):
                res = subprocess.run(
                    ["pgrep", "-x", name],
                    capture_output=True, text=True, timeout=5,
                )
                if res.returncode != 0:
                    continue
                for pid_s in res.stdout.split():
                    if pid_s.isdigit() and int(pid_s) != my_pid:
                        found.append(f"pid {pid_s}: {name.lower()}")
        except Exception:
            pass

    return found


def is_game_running() -> List[str]:
    found: List[str] = []
    if os.environ.get("WOKSE_SIMULATE_GAME_RUNNING") == "1":
        found.append("WOKSE_SIMULATE_GAME_RUNNING=1")
    proc_dir = Path("/proc")
    proc_usable = proc_dir.is_dir() and (proc_dir / str(os.getpid())).exists()
    if proc_usable:
        found.extend(_scan_proc_for_game(proc_dir))
    elif os.name == "nt":
        targets = {"theworldofkongfu", "theworldofkungfu"}
        try:
            res = subprocess.run(
                ["tasklist", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
            )
            for line in res.stdout.splitlines():
                lower = line.lower()
                for t in targets:
                    if t in lower:
                        found.append(line.strip())
                        break
        except Exception:
            pass
    else:
        found.extend(_scan_posix_ps_for_game())
    return found


import contextlib
import stat
import threading
import time

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None

_SAVE_LOCKS_GUARD = threading.Lock()
_SAVE_LOCKS: Dict[str, threading.Lock] = {}


def _acquire_win32_lock_handle(lock_path: Path, deadline: float):
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.GetFileInformationByHandle.argtypes = [
        wintypes.HANDLE,
        wintypes.LPVOID,
    ]
    kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    invalid_handle = ctypes.c_void_p(-1).value
    while True:
        assert_no_symlinks(lock_path)
        handle = kernel32.CreateFileW(
            os.path.abspath(str(lock_path)),
            0xC0000000,
            0,
            None,
            4,
            0x04200080,
            None,
        )
        if handle in (None, 0, invalid_handle):
            err = ctypes.get_last_error()
            if err == 5 and lock_path.exists():
                try:
                    lst = lock_path.lstat()
                except OSError:
                    lst = None
                attrs = getattr(lst, "st_file_attributes", 0) if lst is not None else 0
                if lock_path.is_dir() or os.path.islink(lock_path) or (attrs & 0x401) != 0:
                    raise PermissionError("unsafe or read-only lock file")
            if err in (5, 32, 33):
                if time.monotonic() >= deadline:
                    raise RuntimeError("save lock timeout")
                time.sleep(0.01)
                continue
            raise OSError(err, f"CreateFileW failed on lock file: {lock_path}")

        info = _BY_HANDLE_FILE_INFORMATION()
        if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            err = ctypes.get_last_error()
            kernel32.CloseHandle(handle)
            raise OSError(err, f"GetFileInformationByHandle failed on lock file: {lock_path}")
        if (info.dwFileAttributes & 0x400) != 0 or info.nNumberOfLinks > 1:
            kernel32.CloseHandle(handle)
            raise PermissionError("unsafe lock file")
        return handle, kernel32


def _same_save_path(a: Path, b: Path) -> bool:
    if os.path.abspath(str(a)) == os.path.abspath(str(b)):
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _normalize_expected_sha256(val: Optional[str]) -> Optional[str]:
    if val is None:
        return None
    if not isinstance(val, str) or len(val) != 64 or not all(ch in "0123456789abcdefABCDEF" for ch in val):
        raise ValueError("invalid expectedSha256")
    return val.lower()


def _verify_posix_parent_unchanged(path: Path, dir_fd: int) -> None:
    cfd, _ = _posix_open_parent_dirfd(path)
    try:
        st_cur = os.fstat(cfd)
        st_pin = os.fstat(dir_fd)
        if st_cur.st_dev != st_pin.st_dev or st_cur.st_ino != st_pin.st_ino:
            raise PermissionError(f"안전하지 않은 부모 디렉터리 변경이 감지되었습니다: {path}")
    finally:
        os.close(cfd)


def _posix_same_save_target(dest_dir_fd: int, dest_leaf: str, target: Path, dest: Path) -> bool:
    if os.path.abspath(str(dest)) == os.path.abspath(str(target)):
        return True
    tfd: Optional[int] = None
    try:
        tfd, tleaf = _posix_open_parent_dirfd(target)
        try:
            st_target = os.stat(tleaf, dir_fd=tfd, follow_symlinks=False)
            st_dest = os.stat(dest_leaf, dir_fd=dest_dir_fd, follow_symlinks=False)
        except (OSError, PermissionError):
            return False
        return (st_target.st_dev, st_target.st_ino) == (st_dest.st_dev, st_dest.st_ino)
    except (OSError, PermissionError):
        return False
    finally:
        if tfd is not None:
            os.close(tfd)


def _open_temp_save_file(dest_parent: Path, dir_fd: Optional[int]) -> Tuple[int, str]:
    if dir_fd is None:
        fd, full_name = tempfile.mkstemp(prefix=".woktmp-", dir=str(dest_parent))
        return fd, Path(full_name).name

    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    for _ in range(64):
        leaf = f".woktmp-{os.urandom(8).hex()}"
        try:
            fd = os.open(leaf, flags, 0o600, dir_fd=dir_fd)
            return fd, leaf
        except FileExistsError:
            continue
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.EMLINK, errno.EISDIR):
                raise PermissionError("unsafe temporary save file") from exc
            raise
    raise OSError("failed to allocate unique temporary save file")


@contextlib.contextmanager
def _save_target_lock(dest: Path, timeout_sec: float = 15.0):
    key = os.path.normcase(os.path.abspath(str(dest)))
    with _SAVE_LOCKS_GUARD:
        lock = _SAVE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _SAVE_LOCKS[key] = lock

    if not lock.acquire(timeout=timeout_sec):
        raise RuntimeError("save lock timeout")

    deadline = time.monotonic() + timeout_sec
    lock_path = dest.with_name(f"{dest.name}.lock")

    if os.name == "nt":
        whandle = None
        _kernel32 = None
        try:
            assert_no_symlinks(dest)
            (whandle, _kernel32) = _acquire_win32_lock_handle(lock_path, deadline)
            yield None
        finally:
            try:
                if whandle is not None and _kernel32 is not None:
                    _kernel32.CloseHandle(whandle)
            finally:
                lock.release()
        return

    lfd: Optional[int] = None
    pfd: Optional[int] = None
    os_locked = False
    try:
        assert_no_symlinks(dest)
        while True:
            assert_no_symlinks(lock_path)
            pfd, lock_leaf = _posix_open_parent_dirfd(lock_path)
            try:
                try:
                    lfd = os.open(
                        lock_leaf,
                        os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
                        0o600,
                        dir_fd=pfd,
                    )
                except OSError as exc:
                    if exc.errno in (errno.ELOOP, errno.EMLINK, errno.EISDIR):
                        raise PermissionError("unsafe lock file") from exc
                    raise
                st = os.fstat(lfd)
                if not stat.S_ISREG(st.st_mode) or getattr(st, "st_nlink", 1) > 1:
                    os.close(lfd)
                    lfd = None
                    raise PermissionError("unsafe lock file")
                try:
                    if fcntl is None:
                        raise RuntimeError("no OS file locking primitive available")
                    fcntl.flock(lfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except (BlockingIOError, OSError):
                    try:
                        os.close(lfd)
                    except OSError:
                        pass
                    lfd = None
                    try:
                        os.close(pfd)
                    except OSError:
                        pass
                    pfd = None
                    if time.monotonic() >= deadline:
                        raise RuntimeError("save lock timeout")
                    time.sleep(0.01)
                    continue

                if (
                    os.stat(lock_leaf, dir_fd=pfd, follow_symlinks=False).st_ino
                    != st.st_ino
                ):
                    try:
                        fcntl.flock(lfd, fcntl.LOCK_UN)
                    except OSError:
                        pass
                    os_locked = False
                    raise PermissionError("unsafe lock file")

                os_locked = True
                break
            finally:
                if pfd is not None and not os_locked:
                    try:
                        os.close(pfd)
                    except OSError:
                        pass
                    pfd = None

        yield pfd
    finally:
        try:
            if os_locked and lfd is not None and fcntl is not None:
                try:
                    fcntl.flock(lfd, fcntl.LOCK_UN)
                except OSError:
                    pass
        finally:
            if lfd is not None:
                try:
                    os.close(lfd)
                except OSError:
                    pass
            if pfd is not None:
                try:
                    os.close(pfd)
                except OSError:
                    pass
            lock.release()


def save_dat_safely(
    target_path: Path,
    new_bytes: bytes,
    output_path: Optional[Path] = None,
    force: bool = False,
    expected_sha256: Optional[str] = None,
    require_expected_sha256: bool = False,
    source_sha256: Optional[str] = None,
) -> Dict[str, Any]:
    target = Path(target_path)
    if not _valid_save_name(target.name):
        raise ValueError(f"invalid save name: {target.name!r}")
    expected_sha256 = _normalize_expected_sha256(expected_sha256)
    source_sha256 = _normalize_expected_sha256(source_sha256)
    assert_no_symlinks(target)
    running = is_game_running()
    if running and not force:
        raise RuntimeError(
            "game appears to be running; refuse to save. "
            f"processes: {running}. Use force=True to override."
        )

    session = WokSaveSession(new_bytes)
    check = session.validate()
    if not check["ok"]:
        raise ValueError(f"refusing to save invalid save data: {check['errors']}")

    dest = Path(output_path) if output_path is not None else target
    if not _valid_save_name(dest.name):
        raise ValueError(f"invalid output name: {dest.name!r}")

    with _save_target_lock(dest) as locked_dir_fd:
        assert_no_symlinks(dest)
        if locked_dir_fd is not None:
            _verify_posix_parent_unchanged(dest, locked_dir_fd)
            dest_leaf = dest.name
            same_dest = _posix_same_save_target(locked_dir_fd, dest_leaf, target, dest)
            try:
                st_dest = os.stat(dest_leaf, dir_fd=locked_dir_fd, follow_symlinks=False)
                dest_exists = True
            except FileNotFoundError:
                st_dest = None
                dest_exists = False
            if st_dest is not None and (not stat.S_ISREG(st_dest.st_mode) or getattr(st_dest, "st_nlink", 1) > 1):
                raise PermissionError(f"안전하지 않은 파일입니다: {dest}")
            eff_expected = expected_sha256 if expected_sha256 is not None else (source_sha256 if same_dest else None)
            if require_expected_sha256 and dest_exists and eff_expected is None:
                raise ValueError(f"expectedSha256 is required when overwriting existing save: {dest.name}")
            if not same_dest and dest_exists and not force and eff_expected is None:
                raise FileExistsError(f"output exists: {dest} (use --force)")
            orig_bytes = _posix_read_from_dirfd(locked_dir_fd, dest_leaf, dest, MAX_COMPRESSED_DAT_BYTES, allow_empty=True) if dest_exists else None
            if eff_expected is not None:
                if not dest_exists:
                    raise RuntimeError(f"expected sha256 for missing destination: {dest}")
                existing_sha = hashlib.sha256(orig_bytes if orig_bytes is not None else b"").hexdigest()
                if existing_sha != eff_expected:
                    raise RuntimeError(
                        f"destination sha256 mismatch: expected {eff_expected}, got {existing_sha}"
                    )
            backup_leaf: Optional[str] = None
            backup_path: Optional[Path] = None
            tmp_leaf: Optional[str] = None
            replaced = False
            backup_created = False
            tmp_created = False
            try:
                if dest_exists:
                    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                    hex8 = os.urandom(4).hex()
                    backup_leaf = f"{dest_leaf}.backup-{ts}-{hex8}.bak"
                    backup_path = dest.with_name(backup_leaf)
                    try:
                        bfd = os.open(
                            backup_leaf,
                            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                            0o600,
                            dir_fd=locked_dir_fd,
                        )
                        backup_created = True
                    except PermissionError:
                        raise
                    except OSError as exc:
                        raise OSError(f"failed to create backup: {exc}") from exc
                    with os.fdopen(bfd, "wb") as bfh:
                        bfh.write(orig_bytes if orig_bytes is not None else b"")
                        bfh.flush()
                        os.fsync(bfh.fileno())
                    backup_sha = hashlib.sha256(orig_bytes if orig_bytes is not None else b"").hexdigest()
                    if hashlib.sha256(_posix_read_from_dirfd(locked_dir_fd, backup_leaf, backup_path, MAX_COMPRESSED_DAT_BYTES, allow_empty=True)).hexdigest() != backup_sha:
                        raise OSError("backup SHA-256 verification failed")
                _verify_posix_parent_unchanged(dest, locked_dir_fd)
                tmp_fd, tmp_leaf = _open_temp_save_file(dest.parent, locked_dir_fd)
                tmp_created = True
                with os.fdopen(tmp_fd, "wb") as fh:
                    fh.write(new_bytes)
                    fh.flush()
                    os.fsync(fh.fileno())
                expected_sha = hashlib.sha256(new_bytes).hexdigest()
                if hashlib.sha256(_posix_read_from_dirfd(locked_dir_fd, tmp_leaf, dest.with_name(tmp_leaf), MAX_COMPRESSED_DAT_BYTES, allow_empty=True)).hexdigest() != expected_sha:
                    raise OSError("SHA-256 verification failed for temporary file")
                _verify_posix_parent_unchanged(dest, locked_dir_fd)
                os.replace(tmp_leaf, dest_leaf, src_dir_fd=locked_dir_fd, dst_dir_fd=locked_dir_fd)
                replaced = True
                try:
                    os.fsync(locked_dir_fd)
                except OSError:
                    pass
                actual_sha = hashlib.sha256(_posix_read_from_dirfd(locked_dir_fd, dest_leaf, dest, MAX_COMPRESSED_DAT_BYTES, allow_empty=False)).hexdigest()
                if actual_sha != expected_sha:
                    raise OSError("SHA-256 readback mismatch after write")
            except Exception:
                if not replaced:
                    if tmp_created and tmp_leaf is not None:
                        try:
                            os.unlink(tmp_leaf, dir_fd=locked_dir_fd)
                        except OSError:
                            pass
                    if backup_created and backup_leaf is not None:
                        try:
                            os.unlink(backup_leaf, dir_fd=locked_dir_fd)
                        except OSError:
                            pass
                raise
        else:
            same_dest = _same_save_path(dest, target)
            eff_expected = expected_sha256 if expected_sha256 is not None else (source_sha256 if same_dest else None)
            if require_expected_sha256 and dest.exists() and eff_expected is None:
                raise ValueError(f"expectedSha256 is required when overwriting existing save: {dest.name}")
            if not same_dest and dest.exists() and not force and eff_expected is None:
                raise FileExistsError(f"output exists: {dest} (use --force)")

            orig_bytes: Optional[bytes] = None
            if dest.exists():
                orig_bytes = _read_verified_file_bounded(dest, MAX_COMPRESSED_DAT_BYTES, allow_empty=True)

            if eff_expected is not None:
                if not dest.exists():
                    raise RuntimeError(f"expected sha256 for missing destination: {dest}")
                existing_sha = hashlib.sha256(orig_bytes if orig_bytes is not None else b"").hexdigest()
                if existing_sha != eff_expected:
                    raise RuntimeError(
                        f"destination sha256 mismatch: expected {eff_expected}, got {existing_sha}"
                    )

            backup_path = None
            tmp_path: Optional[Path] = None
            replaced = False
            backup_created = False
            tmp_created = False
            try:
                if dest.exists():
                    if orig_bytes is None:
                        orig_bytes = _read_verified_file_bounded(dest, MAX_COMPRESSED_DAT_BYTES, allow_empty=True)
                    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                    hex8 = os.urandom(4).hex()
                    backup_path = dest.with_name(f"{dest.name}.backup-{ts}-{hex8}.bak")
                    try:
                        bfd = os.open(str(backup_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                        backup_created = True
                    except OSError as exc:
                        raise OSError(f"failed to create backup: {exc}") from exc
                    try:
                        with os.fdopen(bfd, "wb") as bfh:
                            bfh.write(orig_bytes if orig_bytes is not None else b"")
                            bfh.flush()
                            os.fsync(bfh.fileno())
                    except Exception:
                        try:
                            backup_path.unlink()
                        except OSError:
                            pass
                        raise
                    if hashlib.sha256(_read_verified_file_bounded(backup_path, MAX_COMPRESSED_DAT_BYTES, allow_empty=True)).hexdigest() != hashlib.sha256(orig_bytes if orig_bytes is not None else b"").hexdigest():
                        try:
                            backup_path.unlink()
                        except OSError:
                            pass
                        raise OSError("backup SHA-256 verification failed")

                tmp_fd, tmp_leaf = _open_temp_save_file(dest.parent, None)
                tmp_path = dest.parent / tmp_leaf
                tmp_created = True
                with os.fdopen(tmp_fd, "wb") as fh:
                    fh.write(new_bytes)
                    fh.flush()
                    os.fsync(fh.fileno())
                expected_sha = hashlib.sha256(new_bytes).hexdigest()
                if hashlib.sha256(_read_verified_file_bounded(tmp_path, MAX_COMPRESSED_DAT_BYTES, allow_empty=True)).hexdigest() != expected_sha:
                    raise OSError("SHA-256 verification failed for temporary file")
                os.replace(tmp_path, dest)
                replaced = True
                try:
                    dfd = os.open(str(dest.parent), os.O_RDONLY)
                    try:
                        os.fsync(dfd)
                    finally:
                        os.close(dfd)
                except OSError:
                    pass
                actual_sha = hashlib.sha256(_read_save_bytes(dest)).hexdigest()
                if actual_sha != expected_sha:
                    raise OSError("SHA-256 readback mismatch after write")
            except Exception:
                if not replaced:
                    try:
                        if tmp_created and tmp_path is not None and tmp_path.exists():
                            tmp_path.unlink()
                    except OSError:
                        pass
                    if backup_created and backup_path is not None:
                        try:
                            if backup_path.exists():
                                backup_path.unlink()
                        except OSError:
                            pass
                raise

        return {
            "ok": True,
            "target": str(dest),
            "bytes_written": len(new_bytes),
            "sha256": hashlib.sha256(new_bytes).hexdigest(),
            "backup": str(backup_path) if backup_path else None,
            "validated": True,
            "warnings": check.get("warnings", []),
        }


# --- CLI & HTTP Server ---
import argparse
import hashlib
import json
import os
import shutil
import secrets
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def _iv(x):
    try:
        return mp_int(x)
    except Exception:
        if isinstance(x, int):
            return x
        if isinstance(x, str):
            return int(x)
        if hasattr(x, "val"):
            v = x.val
            if isinstance(v, int):
                return v
            if isinstance(v, str):
                return int(v)
            if isinstance(v, list) and v:
                return _iv(v[0])
        raise

def _set_iv(x, v):
    if isinstance(v, bool):
        raise ValueError(f"integer out of MessagePack range: {v}")
    iv = int(v)
    if iv < -9223372036854775808 or iv > 0xffffffffffffffff:
        raise ValueError(f"integer out of MessagePack range: {iv}")
    try:
        set_mp_int(x, iv)
        return x
    except ValueError as e:
        if "out of MessagePack range" in str(e):
            raise
        if hasattr(x, "val"):
            x.val = iv
            return x
        return iv

def _row_id(row):
    if hasattr(row, "val") and isinstance(row.val, list) and row.val:
        return _iv(row.val[0])
    if isinstance(row, list) and row:
        return _iv(row[0])
    return _iv(row)

def _row_amt(row):
    if hasattr(row, "val") and isinstance(row.val, list) and len(row.val) > 1:
        return _iv(row.val[1])
    if isinstance(row, list) and len(row) > 1:
        return _iv(row[1])
    return 0

def _set_row_amt(row, amount):
    if hasattr(row, "val") and isinstance(row.val, list):
        if len(row.val) > 1:
            _set_iv(row.val[1], amount)
        else:
            row.val.append(mp_int(int(amount)))
        return
    if isinstance(row, list):
        if len(row) > 1:
            row[1] = _set_iv(row[1], amount)
        else:
            row.append(int(amount))
        return
    raise ValueError("unsupported inventory row")

def _make_item_row(item_id, amount):
    return MPNode([mp_int(int(item_id)), mp_int(int(amount))])

class _WokInventoryMixin:
    pass

def _natural_save_key(name: str):
    base = name.lower()
    if base.startswith("bigbang") and base.endswith("data.dat"):
        mid = base[7:-8]
        if mid.isdigit():
            return (0, int(mid), base)
    return (1, base)

def _list_saves(root: Path):
    out = []
    if not root.exists() or not root.is_dir():
        return out
    try:
        assert_no_symlinks(root)
    except Exception:
        return out
    for p in root.iterdir():
        if p.name.lower() in NON_SLOT_FILES or not p.is_file():
            continue
        if not _valid_save_name(p.name):
            continue
        try:
            st = p.lstat()
        except OSError:
            continue
        if (getattr(st, 'st_file_attributes', 0) & 0x400) != 0:
            continue
        if st.st_size <= 0 or st.st_size > MAX_COMPRESSED_DAT_BYTES:
            continue
        if stat.S_ISLNK(st.st_mode):
            continue
        if st.st_nlink > 1:
            continue
        out.append(p.name)
    out.sort(key=_natural_save_key)
    return out

def _parse_flags(value: str, default=None):
    if value is None:
        return default
    return bool(int(value))

def _apply_edit(session, args):
    if args.preset:
        for preset in args.preset:
            session.apply_preset(preset, args.char)
    world = {}
    if args.money is not None:
        world["money"] = args.money
    if args.epiphany is not None:
        world["epiphany"] = args.epiphany
    if args.round is not None:
        world["play_round"] = args.round
    if args.speed is not None:
        world["field_speed"] = args.speed
    if args.shovel is not None:
        world["shovel_durable"] = args.shovel
    if args.origin is not None:
        world["born_id"] = args.origin
    if getattr(args, "arena_wins", None) is not None:
        world["arena_win_count"] = args.arena_wins
    if getattr(args, "junshan_rewards", None) is not None:
        world["arena_rewards_junshan"] = args.junshan_rewards
    if getattr(args, "datianwangsi_level", None) is not None:
        world["datianwangsi_level"] = args.datianwangsi_level
    if getattr(args, "datianwangsi_rewards", None) is not None:
        world["arena_rewards_datianwangsi"] = args.datianwangsi_rewards
    if getattr(args, "dongshu_members", None) is not None:
        world["dongshu_members"] = args.dongshu_members
    if getattr(args, "jinwu_members", None) is not None:
        world["jinwu_members"] = args.jinwu_members
    if getattr(args, "xibo_members", None) is not None:
        world["xibo_members"] = args.xibo_members
    if getattr(args, "beigu_members", None) is not None:
        world["beigu_members"] = args.beigu_members
    if getattr(args, "special_wanted", None) is not None:
        world["special_wanted_list"] = args.special_wanted
    if world:
        session.set_world(**world)
    target_char = args.char if args.char is not None else (session.summary().get("playerid") or "9001")
    basic = {}
    if args.name is not None:
        basic["hero_name"] = args.name
    if args.level is not None:
        basic["lv"] = args.level
    if args.talent is not None:
        basic["talent"] = args.talent
    if args.relationship is not None:
        basic["relationship"] = args.relationship
    if basic:
        session.set_char_basic(target_char, **basic)
    for spec in args.set_stat or []:
        if "=" not in spec:
            raise SystemExit(f"invalid --set-stat: {spec}")
        k, v = spec.split("=", 1)
        session.set_char_stat(target_char, k, int(v))
    for spec in args.set_kungfu or []:
        parts = spec.split(":")
        if len(parts) < 2:
            raise SystemExit(f"invalid --set-kungfu: {spec}")
        kf_id = parts[0]
        lv = int(parts[1])
        prof = int(parts[2]) if len(parts) > 2 and parts[2] != "" else 9999
        session.upsert_kungfu(target_char, kf_id, lv=lv, prof=prof)
    for kf_id in args.remove_kungfu or []:
        session.remove_kungfu(target_char, kf_id)
    for trait_id in args.add_trait or []:
        session.add_trait(target_char, trait_id)
    for trait_id in args.remove_trait or []:
        session.remove_trait(target_char, trait_id)
    for spec in args.set_equip or []:
        if ":" not in spec:
            raise SystemExit(f"invalid --set-equip: {spec}")
        slot, item = spec.split(":", 1)
        session.set_equip(target_char, int(slot), int(item))
    for spec in args.set_item or []:
        if ":" not in spec:
            raise SystemExit(f"invalid --set-item: {spec}")
        item, amount = spec.split(":", 1)
        session.set_item(item, int(amount))
    for item_id in args.remove_item or []:
        session.remove_item(item_id)
    for chara_id in args.recruit or []:
        session.set_party(chara_id, in_full_team=True)
    for chara_id in args.follow or []:
        session.set_party(chara_id, in_follow=True)
    for chara_id in args.unfollow or []:
        session.set_party(chara_id, in_follow=False)
    for spec in args.set_flag or []:
        if "=" not in spec:
            raise SystemExit(f"invalid --set-flag: {spec}")
        k, v = spec.split("=", 1)
        session.set_str_flag(k, v)
    for spec in args.set_int_flag or []:
        if "=" not in spec:
            raise SystemExit(f"invalid --set-int-flag: {spec}")
        k, v = spec.split("=", 1)
        session.set_int_flag(k, v)

def _print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True))

def _open_cli_session(dat_path):
    return WokSaveSession(_read_save_bytes(Path(dat_path)))

def _cmd_inspect(args):
    session = _open_cli_session(args.dat)
    if args.json:
        payload = {"summary": session.summary()}
        if args.char is not None:
            payload["character"] = session.get_character(args.char)
        if args.inventory:
            payload["inventory"] = session.list_inventory()
        if args.flags:
            payload["flags"] = session.list_flags()
        _print_json(payload)
        return 0
    summary = session.summary()
    print("요약")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    if args.char is not None:
        ch = session.get_character(args.char)
        print("\n캐릭터")
        print(json.dumps(ch, ensure_ascii=False, indent=2, sort_keys=True))
    if args.inventory:
        inv = session.list_inventory()
        print("\n인벤토리")
        if isinstance(inv, list):
            for row in inv:
                print(f"  {row}")
        else:
            print(json.dumps(inv, ensure_ascii=False, indent=2, sort_keys=True))
    if args.flags:
        flags = session.list_flags()
        print("\n플래그")
        if isinstance(flags, dict):
            for k, v in flags.items():
                print(f"  {k}: {v}")
        else:
            for row in flags:
                print(f"  {row}")
    return 0

def _cmd_validate(args):
    session = _open_cli_session(args.dat)
    result = session.validate()
    if args.json:
        _print_json(result)
    else:
        print("검증 성공" if result.get("ok") else "검증 실패")
        for err in result.get("errors", []):
            print(f"오류: {err}")
        for warn in result.get("warnings", []):
            print(f"경고: {warn}")
    return 0 if result.get("ok") else 2

def _cmd_presets(args):
    if args.json:
        _print_json(PRESETS)
    else:
        for preset_id, preset in PRESETS.items():
            name = preset.get("name") if isinstance(preset, dict) else str(preset)
            print(f"{preset_id}\t{name or ''}")
    return 0

def _cmd_edit(args):
    src_path = Path(args.dat)
    raw_bytes = _read_save_bytes(src_path)
    src_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    session = WokSaveSession(raw_bytes)
    _apply_edit(session, args)
    data = session.to_bytes()
    out_path = Path(args.output) if args.output else None
    target = out_path if out_path is not None else src_path
    same_target = _same_save_path(target, src_path)
    if not same_target and target.exists() and not args.force:
        raise SystemExit(f"output exists: {target} (use --force)")
    info = save_dat_safely(src_path, data, output_path=out_path, force=args.force, expected_sha256=src_sha256 if same_target else None, source_sha256=src_sha256)
    if args.json:
        _print_json({"name": target.name, "path": str(target), "sha256": info["sha256"], "backup": info.get("backup")})
    else:
        print(f"저장됨: {target}")
        print(f"sha256: {info['sha256']}")
        if info.get("backup"):
            print(f"백업: {info['backup']}")
    return 0

SCRIPT_ORDER = ("catalog-data.js", "msgpack-codec.js", "editor-core.js", "editor-ui.js")
BUNDLE_START = "<!-- BUNDLE_SCRIPTS_START -->"
BUNDLE_END = "<!-- BUNDLE_SCRIPTS_END -->"

def _read_script_order():
    return list(SCRIPT_ORDER)

def _build_editor_html():
    dist = SCRIPT_DIR / "dist" / "WorldOfKungfuSaveEditor-v1.1.html"
    if dist.exists():
        return dist.read_bytes()
    src_dir = SCRIPT_DIR / "src"
    page = src_dir / "editor-page.html"
    html = page.read_text(encoding="utf-8") if page.exists() else "<!doctype html><html><body></body></html>"
    scripts = []
    for name in _read_script_order():
        p = src_dir / name
        if p.exists():
            code = p.read_text(encoding="utf-8")
            code = re.sub(r"(?i)</script", lambda m: "<\\/script", code)
            scripts.append(f"<script>{code}</script>")
    block = "\n".join(scripts)
    start = html.find(BUNDLE_START)
    end = html.find(BUNDLE_END, start + len(BUNDLE_START)) if start >= 0 else -1
    if start >= 0 and end >= 0:
        html = html[:start] + block + html[end + len(BUNDLE_END):]
    elif block:
        marker = "</body>"
        idx = html.lower().rfind(marker)
        if idx >= 0:
            html = html[:idx] + block + "\n" + html[idx:]
        else:
            html += "\n" + block
    return html.encode("utf-8")

def create_http_server(save_dir=None, host="127.0.0.1", port=8765, html_path=None, allow_remote=False):
    if not allow_remote and host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("non-loopback host requires allow_remote=True")
    root = Path(save_dir) if save_dir else (SCRIPT_DIR / "saves")
    csrf_token = secrets.token_hex(16)
    html_bytes = Path(html_path).read_bytes() if html_path else _build_editor_html()
    actual_port = int(port)
    io_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "WokEditor/1.0"

        def log_message(self, fmt, *args):
            return

        def _send(self, code, body=b"", content_type="application/json; charset=utf-8"):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Vary", "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Origin, Host")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def _host_ok(self):
            if allow_remote:
                return True
            host_hdr = self.headers.get("Host", "")
            allowed = {"127.0.0.1", "localhost", "[::1]"}
            if host_hdr in allowed:
                return True
            for a in allowed:
                if host_hdr in (f"{a}:{actual_port}", f"{a}:{self.server.server_port}"):
                    return True
            return False

        def _origin_ok(self):
            if allow_remote:
                return True
            origin = self.headers.get("Origin")
            if origin is None:
                return True
            p = self.server.server_port
            allowed = {
                f"http://127.0.0.1:{p}",
                f"http://localhost:{p}",
                f"http://[::1]:{p}",
                f"http://127.0.0.1:{actual_port}",
                f"http://localhost:{actual_port}",
                f"http://[::1]:{actual_port}",
            }
            return origin in allowed

        def _guard_common(self, is_api=False, is_post=False, is_get_root=False):
            if not allow_remote and not self._host_ok():
                self._json(403, {"ok": False, "error": "forbidden host"})
                return False
            sec_site = self.headers.get("Sec-Fetch-Site")
            if sec_site is not None:
                if (is_api or is_post) and sec_site not in ("same-origin", "none"):
                    self._json(403, {"ok": False, "error": "forbidden fetch site"})
                    return False
                if is_get_root and sec_site == "cross-site" and self.headers.get("Sec-Fetch-Mode") != "navigate":
                    self._json(403, {"ok": False, "error": "forbidden fetch site"})
                    return False
            if is_post:
                ctype = self.headers.get("Content-Type", "")
                if not ctype.lower().startswith("application/json"):
                    self._json(415, {"ok": False, "error": "json required"})
                    return False
                if not self._origin_ok():
                    self._json(403, {"ok": False, "error": "forbidden origin"})
                    return False
                supplied = self.headers.get("X-Wok-Token", "")
                if not supplied or not secrets.compare_digest(supplied, csrf_token):
                    self._json(403, {"ok": False, "error": "forbidden token"})
                    return False
            return True

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            is_api = path.startswith("/api/")
            if not self._guard_common(is_api=is_api, is_get_root=(path in ("/", "/index.html"))):
                return
            if path in ("/", "/index.html"):
                self._send(200, html_bytes, "text/html; charset=utf-8")
                return
            if path == "/api/saves":
                self._json(200, {"ok": True, "saves": _list_saves(root), "csrfToken": csrf_token})
                return
            if path == "/api/load":
                qs = parse_qs(parsed.query)
                name = (qs.get("name") or [""])[0]
                if not name or not _valid_save_name(name):
                    self._json(400, {"ok": False, "error": "invalid save name"})
                    return
                target = root / name
                with io_lock:
                    try:
                        raw = _read_save_bytes(target)
                    except FileNotFoundError:
                        self._json(404, {"ok": False, "error": "not found"})
                        return
                    except Exception as e:
                        self._json(400, {"ok": False, "error": str(e)})
                        return
                self._json(200, {"ok": True, "name": name, "base64": __import__("base64").b64encode(raw).decode("ascii"), "sha256": _sha256(raw)})
                return
            self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            if not self._guard_common(is_api=True, is_post=True):
                return
            parsed = urlparse(self.path)
            if parsed.path != "/api/save":
                self._json(404, {"ok": False, "error": "not found"})
                return
            raw_cl = self.headers.get('Content-Length')
            if raw_cl is None:
                self.close_connection = True
                self._json(400, {'ok': False, 'error': 'missing Content-Length'})
                return
            s_cl = raw_cl.strip()
            if not s_cl.lstrip('-').isdigit():
                self.close_connection = True
                self._json(400, {'ok': False, 'error': 'invalid Content-Length'})
                return
            try:
                length = int(s_cl)
            except ValueError:
                self.close_connection = True
                self._json(400, {'ok': False, 'error': 'invalid Content-Length'})
                return
            if length <= 0:
                self.close_connection = True
                self._json(400, {'ok': False, 'error': 'invalid Content-Length'})
                return
            if length > MAX_HTTP_BODY_BYTES:
                self.close_connection = True
                self._json(413, {'ok': False, 'error': 'payload too large'})
                return
            try:
                raw_body = self.rfile.read(length)
                obj = json.loads(raw_body.decode("utf-8"))
                if not isinstance(obj, dict):
                    raise ValueError("invalid request body")
                name = str(obj.get("name", ""))
                b64 = str(obj.get("base64", ""))
                force = bool(obj.get("force", False))
                expected_sha256 = obj.get("expectedSha256")
                if expected_sha256 is not None and not isinstance(expected_sha256, str):
                    raise ValueError("invalid expectedSha256")
                if not _valid_save_name(name):
                    raise ValueError("invalid save name")
                try:
                    raw = __import__("base64").b64decode(b64.encode("ascii"), validate=True)
                except Exception as e:
                    raise ValueError(f"invalid base64: {e}")
                target = root / name
                with io_lock:
                    assert_no_symlinks(target)
                    info = save_dat_safely(
                        target,
                        raw,
                        force=force,
                        expected_sha256=expected_sha256,
                        require_expected_sha256=True,
                    )
            except RuntimeError as e:
                self._json(409, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                self._json(400, {"ok": False, "error": str(e)})
                return
            self._json(200, {"ok": True, "name": name, "backup": info.get("backup"), "sha256": info.get("sha256", _sha256(raw))})

    class Server(ThreadingHTTPServer):
        daemon_threads = True

    srv = Server((host, port), Handler)
    srv.csrf_token = csrf_token
    return srv

def _cmd_serve(args):
    root = Path(args.save_dir) if args.save_dir else None
    srv = create_http_server(root, host=args.host, port=args.port, html_path=args.html, allow_remote=args.allow_remote)
    print(f"http://{args.host}:{srv.server_port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0

def build_parser():
    p = argparse.ArgumentParser(prog="wok_editor")
    sub = p.add_subparsers(dest="cmd", required=True)
    pi = sub.add_parser("inspect")
    pi.add_argument("dat")
    pi.add_argument("--json", action="store_true")
    pi.add_argument("--char")
    pi.add_argument("--inventory", action="store_true")
    pi.add_argument("--flags", action="store_true")
    pi.set_defaults(func=_cmd_inspect)
    pv = sub.add_parser("validate")
    pv.add_argument("dat")
    pv.add_argument("--json", action="store_true")
    pv.set_defaults(func=_cmd_validate)
    pp = sub.add_parser("presets")
    pp.add_argument("--json", action="store_true")
    pp.set_defaults(func=_cmd_presets)
    pe = sub.add_parser("edit")
    pe.add_argument("dat")
    pe.add_argument("-o", "--output")
    pe.add_argument("--force", action="store_true")
    pe.add_argument("--json", action="store_true")
    pe.add_argument("--preset", action="append")
    pe.add_argument("--money", type=int)
    pe.add_argument("--epiphany", type=int)
    pe.add_argument("--round", type=int)
    pe.add_argument("--speed", type=float)
    pe.add_argument("--shovel", type=int)
    pe.add_argument("--origin")
    pe.add_argument("--arena-wins", type=int)
    pe.add_argument("--datianwangsi-level", type=int)
    pe.add_argument("--junshan-rewards")
    pe.add_argument("--datianwangsi-rewards")
    pe.add_argument("--dongshu-members")
    pe.add_argument("--jinwu-members")
    pe.add_argument("--xibo-members")
    pe.add_argument("--beigu-members")
    pe.add_argument("--special-wanted")
    pe.add_argument("--char")
    pe.add_argument("--name")
    pe.add_argument("--level", type=int)
    pe.add_argument("--talent", type=int)
    pe.add_argument("--relationship", type=int)
    pe.add_argument("--set-stat", action="append")
    pe.add_argument("--set-kungfu", action="append")
    pe.add_argument("--remove-kungfu", action="append")
    pe.add_argument("--add-trait", action="append")
    pe.add_argument("--remove-trait", action="append")
    pe.add_argument("--set-equip", action="append")
    pe.add_argument("--set-item", action="append")
    pe.add_argument("--remove-item", action="append")
    pe.add_argument("--recruit", action="append")
    pe.add_argument("--follow", action="append")
    pe.add_argument("--unfollow", action="append")
    pe.add_argument("--set-flag", action="append")
    pe.add_argument("--set-int-flag", action="append")
    pe.set_defaults(func=_cmd_edit)
    ps = sub.add_parser("serve")
    ps.add_argument("--save-dir")
    ps.add_argument("--host", default="127.0.0.1")
    ps.add_argument("--port", type=int, default=8765)
    ps.add_argument("--html")
    ps.add_argument("--allow-remote", action="store_true")
    ps.set_defaults(func=_cmd_serve)
    return p

def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, KeyError, PermissionError, RuntimeError, OSError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
