#!/usr/bin/env python3
"""Extract the World of Kungfu: Dragon and Eagle (AppID 1407450) catalog.

Reads unpacked ``original/*.csv`` tables plus ``patched/*_TransDict.csv``
translation overlays and emits a single UMD module
(``root.WokCatalog`` / ``module.exports``) consumed by the save editor.

All ``id`` / ``relateId`` values stay strings: the game's MessagePack saves
store identifiers as strings, so the JS side must never coerce them.
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

APP_ID = "1407450"

TRANS_PREFIXES = (
    "gang_a01",
    "gang_a02",
    "gang_b01",
    "gang_b02",
    "gang_b03",
    "gang_b06",
    "gang_b07",
)

ITEM_SLOT_BY_STYLE = {"201": 0, "202": 1, "203": 2}

KUNGFU_STYLE_LABELS = {
    "101": "검법",
    "201": "도법",
    "301": "곤장",
    "401": "권장",
    "501": "지력",
    "601": "특수무기",
    "701": "음률",
    "801": "의술·기문",
    "901": "내공심법",
    "1001": "특수절학",
    "9001": "기본",
    "9101": "비전",
    "9301": "절기",
    "9401": "기연",
    "9501": "진법",
    "9601": "오의",
}

ITEM_STYLE_LABELS = {
    "101": "비급·무공서",
    "201": "무기",
    "202": "방어구",
    "203": "장신구",
    "301": "단약·의약",
    "401": "주류·음식",
    "501": "암기",
    "701": "서적·자료",
    "702": "단조·광석",
    "703": "특수재료",
    "802": "귀중품·임무",
    "901": "잡화",
    "1201": "도면·기타",
    "1301": "비전재료",
    "999": "특수",
}

CODE_ATLAS = [
    {
        "id": "XmlSaver",
        "title": "XmlSaver (COMPRESSED 컨테이너)",
        "detail": "COMPRESSED: 접두사 + Base64(GZip(MessagePack)) 직렬화 컨테이너. 후행 개행 없이 UTF-8/ASCII로 기록됨.",
    },
    {
        "id": "GameData",
        "title": "GameData[0..53]",
        "detail": "슬롯 세이브(bigbang1data.dat~bigbang24data.dat) 최상위 54원소 MessagePack 배열 ([3]simpleCharaDatas, [8]bornid, [9]playerid, [14]m_Money, [15]m_Epiphany, [19]simplePackItems, [20]FullTeam, [21]FollowList, [40..42]b02/b03/b07append).",
    },
    {
        "id": "SimpleCharaData",
        "title": "SimpleCharaData[0..28]",
        "detail": "캐릭터별 29원소 레코드 ([1]m_Id, [6]m_Hp, [7]m_Mp, [8]m_Training_Id, [9]m_Level, [10]m_Exp, [11]m_Relationship, [13]m_Talent, [15]sz_KongFuData, [16]m_KongFuListInBattle, [18]sz_AtomData, [19]m_TraitList, [20]m_EquipSlot, [22]m_EquipTraitList, [27]nil, [28]totalTalentCost).",
    },
    {
        "id": "sz_AtomData",
        "title": "sz_AtomData (9필드 CSV)",
        "detail": "id,stringValue,bornValue,alterValue,fightValue,rollValue,juqingValue,levelupValue,talentValue (성명=12003 stringValue, 쉼표 금지).",
    },
    {
        "id": "AtomData.totalValue",
        "title": "AtomData.get_totalValue()",
        "detail": "rollValue + levelupValue + talentValue + alterValue + juqingValue + equipValue + equipTraitValue + wugongValue + traitValue.",
    },
    {
        "id": "sz_KongFuData",
        "title": "sz_KongFuData (5필드 CSV)",
        "detail": "id,lv,exp,proficiency,isAbolished (Boolean.ToString 규격 True/False).",
    },
    {
        "id": "PackTables",
        "title": "PackB02/B03/B07Table",
        "detail": "GameData[40..42]의 b02append/b03append/b07append 세미콜론(;) 구분 단조 장비·자창/진화 무공·동적 아이템 행.",
    },
]


def read_csv(path):
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def cell(row, key):
    return (row.get(key) or "").strip()


def as_int(value, default=0):
    try:
        return int(float((value or "").strip()))
    except (TypeError, ValueError):
        return default


def as_number(value, default=0):
    try:
        number = float((value or "").strip())
    except (TypeError, ValueError):
        return default
    return int(number) if number.is_integer() else number


def load_trans(data_dir):
    """Load translation dictionaries whose ID column already holds the full key."""
    table = {}
    patch_dir = data_dir / "patched"
    for prefix in TRANS_PREFIXES:
        for row in read_csv(patch_dir / f"{prefix}_TransDict.csv"):
            rid = cell(row, "ID")
            if rid:
                table[rid] = (cell(row, "zh-CH"), cell(row, "en-US"))
    return table


def translate(trans, prefix, rid, fields):
    keys = [f"{prefix}_{rid}_{field}" for field in fields]
    if prefix == "gang_b06_chain":
        keys.extend(f"gang_b06_{rid}_{field}" for field in fields)
    for key in keys:
        if key in trans:
            ko, en = trans[key]
            if ko or en:
                return ko, en
    return "", ""


def stat_cat(row_id):
    try:
        value = int(row_id)
    except (TypeError, ValueError):
        return "combat"
    if 1001 <= value <= 1016:
        return "core"
    if 2001 <= value <= 2007:
        return "aptitude"
    if 3001 <= value <= 3014:
        return "mastery"
    if 12001 <= value <= 12010:
        return "profile"
    return "combat"


def join_bonus(pairs):
    return "|".join(
        f"{key}:{value}" for key, value in pairs if key and as_number(value, 0) != 0
    )


def extract_stats(data_dir, trans):
    out = []
    for row in read_csv(data_dir / "original" / "gang_a01.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_a01", rid, ("NameUI", "Name"))
        name, ui = cell(row, "Name"), cell(row, "NameUI")
        cn = ui or name
        out.append(
            {
                "id": rid,
                "key": name,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "cat": stat_cat(rid),
                "isSave": cell(row, "isSaveData") == "1",
                "type": as_int(cell(row, "Type"), 1),
                "defVal": as_number(cell(row, "Default")),
                "maxVal": as_number(cell(row, "UpperLimit")),
                "minVal": as_number(cell(row, "LowerLimit")),
            }
        )
    return out


def extract_origins(data_dir, trans):
    out = []
    for row in read_csv(data_dir / "original" / "gang_a02.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_a02", rid, ("Scenario",))
        hero_ko, _ = translate(trans, "gang_a02", rid, ("Name",))
        duty_ko, _ = translate(trans, "gang_a02", rid, ("Duty",))
        cn = cell(row, "Scenario")
        hero_cn = cell(row, "Name")
        duty_cn = cell(row, "Duty")
        out.append(
            {
                "id": rid,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "heroKo": hero_ko or hero_cn,
                "heroCn": hero_cn,
                "dutyKo": duty_ko or duty_cn,
                "dutyCn": duty_cn,
            }
        )
    return out


def load_dashboard(corpus_dir):
    path = corpus_dir / "companion-dashboard.json"
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    info = {}
    for entry in payload.get("companions") or []:
        cid = str(entry.get("id") or "")
        if cid.startswith("comp-"):
            info[cid[5:]] = entry
    return info


def extract_characters(data_dir, corpus_dir, trans):
    dashboard = load_dashboard(corpus_dir)
    out = []
    for row in read_csv(data_dir / "original" / "gang_b01.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b01", rid, ("Name",))
        guild_trans_ko, _ = translate(trans, "gang_b01", rid, ("Guild",))
        info = dashboard.get(rid) or {}
        cn = cell(row, "Name")
        guild_cn = cell(row, "Guild")
        out.append(
            {
                "id": rid,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "guildKo": guild_trans_ko or str(info.get("sect_ko") or "") or guild_cn,
                "guildCn": guild_cn,
                "prefab": cell(row, "Prefab"),
                "icon": cell(row, "BattleIcon"),
                "recruitable": bool(info.get("recruitable", info)),
                "tier": str(info.get("tier") or ""),
            }
        )
    return out


def extract_kungfu(data_dir, trans):
    out = []
    for row in read_csv(data_dir / "original" / "gang_b03.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b03", rid, ("Name",))
        cn = cell(row, "Name")
        out.append(
            {
                "id": rid,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "star": as_int(cell(row, "Star"), 0),
                "style": cell(row, "Style"),
                "maxLv": as_int(cell(row, "LV"), 20),
                "dmg": cell(row, "Damage"),
                "mp": cell(row, "Expend"),
            }
        )
    return out


def extract_traits(data_dir, trans):
    out = []
    for row in read_csv(data_dir / "original" / "gang_b06.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b06", rid, ("Name",))
        cn = cell(row, "Name")
        pairs = [
            (cell(row, f"add{i}"), cell(row, f"attribute{i}")) for i in range(1, 5)
        ]
        out.append(
            {
                "id": rid,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "good": cell(row, "good") == "1",
                "bonus": join_bonus(pairs),
            }
        )
    return out


def extract_trait_chains(data_dir, trans):
    out = []
    for row in read_csv(data_dir / "original" / "gang_b06_chain.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b06_chain", rid, ("Name",))
        cn = cell(row, "Name")
        slots = [
            cell(row, str(i))
            for i in range(1, 10)
            if cell(row, str(i)) not in ("", "0")
        ]
        out.append(
            {"id": rid, "ko": ko or cn, "cn": cn, "en": en, "slots": slots}
        )
    return out


def load_b02(data_dir, trans):
    table = {}
    for row in read_csv(data_dir / "original" / "gang_b02.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b02", rid, ("Name",))
        cn = cell(row, "Name")
        pairs = [
            (cell(row, f"add{i}"), cell(row, f"Attribute{i}")) for i in range(1, 6)
        ]
        table[rid] = {
            "ko": ko or cn,
            "cn": cn,
            "en": en,
            "style": cell(row, "Style"),
            "bonus": join_bonus(pairs),
        }
    return table


def extract_items(data_dir, trans):
    b02 = load_b02(data_dir, trans)
    out = []
    for row in read_csv(data_dir / "original" / "gang_b07.csv"):
        rid = cell(row, "ID")
        if not rid:
            continue
        ko, en = translate(trans, "gang_b07", rid, ("Name",))
        cn = cell(row, "Name")
        style = cell(row, "Style")
        relate = cell(row, "Relateid")
        linked = b02.get(relate) or {}
        out.append(
            {
                "id": rid,
                "ko": ko or cn,
                "cn": cn,
                "en": en,
                "style": style,
                "star": as_int(cell(row, "Star"), 0),
                "price": as_int(cell(row, "Value"), 0),
                "relateId": str(relate),
                "equipSlot": ITEM_SLOT_BY_STYLE.get(style, -1),
                "bonus": linked.get("bonus", ""),
            }
        )
    return out


def extract_scenes(corpus_dir):
    path = corpus_dir / "regional-map-atlas.json"
    if not path.is_file():
        return {"regions": [], "submaps": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"regions": [], "submaps": []}
    regions = [
        {"id": str(r.get("id") or ""), "ko": str(r.get("name_ko") or r.get("name") or "")}
        for r in payload.get("regions") or []
    ]
    submaps = [
        {
            "id": str(s.get("id") or ""),
            "region": str(s.get("region_ko") or s.get("region") or ""),
            "ko": str(s.get("title_ko") or s.get("name_ko") or ""),
        }
        for s in payload.get("submaps") or []
    ]
    return {"regions": regions, "submaps": submaps}


def write_catalog(path, catalog):
    body = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    text = (
        "(function (root, factory) {\n"
        "  if (typeof module === 'object' && module.exports) { module.exports = factory(); }\n"
        "  else { root.WokCatalog = factory(); }\n"
        "}(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n"
        f"  return {body};\n"
        "}));\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_catalog(data_dir, corpus_dir):
    trans = load_trans(data_dir)
    catalog = {
        "meta": {
            "gameId": "world-of-kungfu",
            "appId": APP_ID,
            "titleKo": "대강호: 창룡과 백조",
            "titleCn": "大江湖之苍龙与白鸟",
            "titleEn": "The World of Kungfu: Dragon and Eagle",
            "version": "1.0.6",
            "koreanPatch": "0.2.1",
        },
        "kungfuStyleLabels": KUNGFU_STYLE_LABELS,
        "itemStyleLabels": ITEM_STYLE_LABELS,
        "codeAtlas": CODE_ATLAS,
        "stats": extract_stats(data_dir, trans),
        "origins": extract_origins(data_dir, trans),
        "characters": extract_characters(data_dir, corpus_dir, trans),
        "kungfu": extract_kungfu(data_dir, trans),
        "traits": extract_traits(data_dir, trans),
        "traitChains": extract_trait_chains(data_dir, trans),
        "items": extract_items(data_dir, trans),
        "scenes": extract_scenes(corpus_dir),
    }
    catalog["meta"]["counts"] = {
        k: len(v) for k, v in catalog.items() if isinstance(v, list)
    }
    return catalog


def main(argv=None):
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Extract the World of Kungfu: Dragon and Eagle catalog (AppID 1407450)."
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("WOKSE_DATA_DIR", ""),
        help="unpacked game data root (contains original/ and patched/)",
    )
    parser.add_argument(
        "--corpus-dir",
        default=os.environ.get("WOKSE_CORPUS_DIR", ""),
        help="community corpus dir (companion-dashboard.json, regional-map-atlas.json)",
    )
    parser.add_argument(
        "--output",
        default="",
        help="output JS path (default: <repo>/src/catalog-data.js)",
    )
    args = parser.parse_args(argv)

    if not args.data_dir:
        parser.error("--data-dir or WOKSE_DATA_DIR is required")

    data_dir = Path(args.data_dir).expanduser().resolve()
    if not (data_dir / "original").is_dir():
        parser.error(f"missing {data_dir / 'original'}")
    corpus_dir = (
        Path(args.corpus_dir).expanduser().resolve() if args.corpus_dir else data_dir
    )
    output = (
        Path(args.output).expanduser().resolve()
        if args.output
        else repo_root / "src" / "catalog-data.js"
    )

    catalog = build_catalog(data_dir, corpus_dir)
    write_catalog(output, catalog)
    counts = catalog["meta"]["counts"]
    print(
        f"wrote {output} -> "
        + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
