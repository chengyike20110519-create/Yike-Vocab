"""Import vocabulary books from common local files.

The parser is intentionally permissive: it accepts explicit Excel/CSV columns,
one-unit-per-sheet workbooks, plain text with Unit headings, and simple
word + meaning lines.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import openpyxl

CJK_RE = re.compile(
    r"[\u2e80-\u2fff\u3400-\u9fff\uF900-\uFAFF\u3000-\u303f\uff00-\uffef]"
)
PHONETIC_RE = re.compile(
    r"(?:^/.*/$|^\[.*\]$|^[\[/].*[\])/]$|^[\u0250-\u02af\u00e6\u0259\u026a\u028a"
    r"\u025b\u0254\u0289\u026f\u028c\u0251\u0252\u0276\u03b8\u00f0\u0283\u0292\u0283])"
)
POS_WORDS = {
    "n", "v", "vt", "vi", "adj", "adv", "prep", "conj", "pron", "art",
    "num", "int", "interj", "aux", "abbr", "phr", "modal", "s", "pl",
    "noun", "verb", "adjective", "adverb", "preposition", "conjunction",
    "pronoun", "interjection", "auxiliary",
}

UNIT_RE = re.compile(
    r"^\s*(?:"
    r"(?P<en1>(?:unit|lesson|chapter|book|part|list|stage|week|day|lecture|volume)"
    r"\s*[0-9A-Za-z一二三四五六七八九十百]+(?:[\s:：,.．_-].*)?)"
    r"|(?P<zh>第\s*[0-9一二三四五六七八九十百]+\s*(?:单元|课|章|部分|组|节))"
    r"|(?P<num>[0-9]{1,3}\s*(?:单元|课|章|部分|组|节))"
    r")\s*(?:[:：,.．-]\s*|\s+)?(.*)$",
    re.IGNORECASE,
)

WORD_TOKEN_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9'’\-]*(?:\.[a-z]{0,2})?$"
)
LEADING_NUM_RE = re.compile(r"^\s*(?:\d+|[a-z])[.、)）:：]?\s*", re.IGNORECASE)
ROW_INDEX_RE = re.compile(r"^\s*\d+[.、)）]?\s*$")


def _clean(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    text = text.replace("\u3000", " ").replace("\xa0", " ").strip()
    return text


def _norm_header(value: object) -> str:
    return re.sub(r"[\s_\-:：/\\()（）\[\]]", "", _clean(value).lower())


def _contains_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text))


def _looks_word(text: str) -> bool:
    t = _clean(text)
    if not t or _contains_cjk(t) or len(t) > 160:
        return False
    if UNIT_RE.match(t):
        return False
    # Keep words such as "well-being", "A-bomb", "can't", "Mr.", "O2".
    return bool(re.match(r"^[A-Za-z][A-Za-z0-9'’\-]*(?:\.[a-z])?$", t))


def _is_pos_token(text: str) -> bool:
    t = _clean(text).strip("()（）[]")
    if not t:
        return False
    core = t.rstrip(".").lower()
    return core in POS_WORDS


def _is_phonetic_token(text: str) -> bool:
    t = _clean(text)
    if not t:
        return False
    if t.startswith("/") and t.endswith("/"):
        return True
    if t.startswith("[") and t.endswith("]"):
        return True
    if len(t) < 40 and PHONETIC_RE.match(t):
        return True
    return False


def _cn_numeral(text: str) -> int | None:
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
    units = {"十": 10, "百": 100}
    total = 0
    current = 0
    for ch in text:
        if ch in digits:
            current = digits[ch]
        elif ch in units:
            total += (current or 1) * units[ch]
            current = 0
        else:
            return None
    return total + current


def _unit_from_text(text: str) -> tuple[str | None, int | None]:
    t = _clean(text)
    if not t:
        return None, None
    m = UNIT_RE.match(t)
    if not m:
        return None, None
    raw = (m.group("en1") or m.group("zh") or m.group("num") or "").strip()
    suffix = (m.group(4) or "").strip()
    number_match = re.search(r"([0-9]+|[一二三四五六七八九十百]+)$", raw)
    no: int | None = None
    if number_match:
        part = number_match.group(1)
        no = int(part) if part.isdigit() else _cn_numeral(part)
    if suffix and no is not None and not re.match(r"^[0-9一二三四五六七八九十百]+$", suffix):
        label = f"Unit {no} - {suffix}"
    else:
        label = t
    return label, no


def _classify_header(value: object) -> str:
    raw = _clean(value)
    v = _norm_header(raw)
    if not v:
        return "skip"
    unit_words = {"unit", "units", "lesson", "chapter", "book", "part", "list"}
    if v in unit_words or any(w in v for w in ("单元", "课次", "unit", "lesson")):
        return "unit"
    if any(w in v for w in ("同义词", "近义词", "synonym", "相忆词")):
        return "memory"
    if any(w in v for w in ("助记", "词根", "联想", "记忆法", "拆词")):
        return "memory"
    if any(w in v for w in ("英文释义", "英语释义", "英英释义", "englishdefinition",
                             "englishmeaning", "englishmeaning", "englishdefinition")):
        return "en"
    if any(w in v for w in ("中文释义", "中文意思", "中文含义", "词义", "释义",
                             "意思", "翻译", "汉语", "中文", "chinese", "meaning",
                             "translation", "definition")):
        # A plain English "meaning/definition" column is an English definition
        # unless its sample values contain Chinese.
        if v in ("meaning", "definition") and not _contains_cjk(raw):
            return "en"
        return "meaning"
    if any(w in v for w in ("词性", "词类", "partofspeech", "pos")):
        return "pos"
    if any(w in v for w in ("音标", "读音", "发音", "phonetic", "ipa")):
        return "phonetic"
    if any(w in v for w in ("单词", "词汇", "词条", "英文", "英语", "word",
                             "vocabulary", "term", "headword")):
        return "word"
    if any(w in v for w in ("序号", "编号", "number", "index", "id", "no")):
        return "skip"
    return "skip"


def _split_pos_from_meaning(meaning: str) -> tuple[str, str]:
    m = re.match(
        r"^\s*(?:(?:v|vt|vi|n|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|phr)"
        r"(?:\.|\.\s*|\)\s*|\]\s*|\s+))(?P<rest>.*)$",
        meaning,
        re.IGNORECASE,
    )
    if not m:
        return "", meaning
    pos_raw = re.match(r"^\s*([A-Za-z.]+)", meaning)
    pos = pos_raw.group(1).strip() if pos_raw else ""
    return pos, m.group("rest").strip()


def _scan_head_tokens(tokens: list[str]) -> dict:
    parts: list[str] = []
    phonetic: list[str] = []
    pos = ""
    for token in tokens:
        if not token:
            continue
        if _is_phonetic_token(token):
            phonetic.append(token)
            continue
        if _is_pos_token(token):
            pos = token.strip("()（）[]")
            continue
        if not WORD_TOKEN_RE.match(token) and parts:
            # Stop on unexpected separators such as "：" or an English sentence.
            break
        parts.append(token)
    return {
        "word": " ".join(parts),
        "phonetic": " ".join(phonetic),
        "pos": pos,
    }


def _entry_from_text(text: str) -> dict | None:
    """Parse one word line such as ``abandon [ə'bændən] vt. 放弃``."""
    s = _clean(text)
    if not s:
        return None
    s = re.sub(r"^[\s\u00a0]*[•●◆■★☆※－—-]+[\s\u00a0]*", "", s)
    m = re.match(r"^\d+\s*[.、)）]\s*(.*)$", s)
    if m:
        s = m.group(1).strip()
    if not s or not re.match(r"^[A-Za-z]", s):
        return None

    if "\t" in s:
        row = _entry_from_fields(s.split("\t"))
        return row

    cjk_positions = [m.start() for m in re.finditer(r"[\u3400-\u9fff]", s)]
    if cjk_positions:
        cut = cjk_positions[0]
        head = s[:cut]
        tail = s[cut:].strip()
    else:
        head = s
        tail = ""

    head = head.strip()
    tokens = head.split()
    if not tokens or not re.match(r"^[A-Za-z]", tokens[0]):
        return None
    scanned = _scan_head_tokens(tokens)
    word = scanned["word"]
    if not word:
        return None
    pos, meaning = _split_pos_from_meaning(tail) if tail else ("", "")
    pos = pos or scanned["pos"]
    en = ""
    if not tail:
        # The remainder may be an English definition.
        leftover = []
        after_word = False
        for token in tokens:
            if token == scanned["word"] or (after_word and not _is_phonetic_token(token)
                                             and not _is_pos_token(token)):
                if token not in leftover and (after_word or True):
                    leftover.append(token)
            if token == scanned["word"]:
                after_word = True
        en = " ".join(leftover).strip()
    phonetic = scanned["phonetic"]
    return {
        "word": word,
        "phonetic": phonetic,
        "pos": pos,
        "meaning": meaning,
        "meaning_en": en,
        "memory": "",
    }


def _entry_from_fields(fields: list[object]) -> dict | None:
    vals = [_clean(x) for x in fields if _clean(x)]
    if not vals:
        return None
    # A single cell that already contains word + meaning.
    if len(vals) == 1:
        parsed = _entry_from_text(vals[0])
        if parsed and parsed["meaning"]:
            return parsed
        word = vals[0] if _looks_word(vals[0]) else ""
        if not word:
            return None
        return {
            "word": word,
            "phonetic": "",
            "pos": "",
            "meaning": "",
            "meaning_en": "",
            "memory": "",
        }

    word_idx = next((i for i, v in enumerate(vals) if _looks_word(v)), None)
    if word_idx is None:
        return None
    word = vals[word_idx]
    if len(word) > 160:
        return None

    phonetic: list[str] = []
    pos = ""
    en_parts: list[str] = []
    meaning = ""
    for i in range(word_idx + 1, len(vals)):
        v = vals[i]
        if _is_phonetic_token(v):
            phonetic.append(v)
        elif _is_pos_token(v):
            pos = v.strip("()（）[]")
        elif _contains_cjk(v):
            # Keep Chinese pieces together; this is usually the Chinese meaning.
            meaning = v
            if not pos:
                pos, meaning = _split_pos_from_meaning(meaning)
            break
        else:
            en_parts.append(v)
    if not meaning and en_parts:
        pos_clean, en_clean = "", " ".join(en_parts)
        if not pos and en_parts and _is_pos_token(en_parts[0]):
            pos = en_parts[0].strip("()（）[]")
            en_clean = " ".join(en_parts[1:])
        return {
            "word": word,
            "phonetic": " ".join(phonetic),
            "pos": pos or pos_clean,
            "meaning": "",
            "meaning_en": en_clean,
            "memory": "",
        }
    return {
        "word": word,
        "phonetic": " ".join(phonetic),
        "pos": pos,
        "meaning": meaning,
        "meaning_en": " ".join(en_parts),
        "memory": "",
    }


def _find_header(rows: list[list[object]]) -> tuple[int, dict[int, str]] | None:
    best_row: int | None = None
    best_cols: dict[int, str] = {}
    best_score = 0
    for i, row in enumerate(rows[:40]):
        cols: dict[int, str] = {}
        score = 0
        for j, cell in enumerate(row[:30]):
            kind = _classify_header(cell)
            if kind == "word":
                score += 4
                cols[j] = "word"
            elif kind == "meaning":
                score += 3
                cols[j] = "meaning"
            elif kind == "en":
                score += 2
                cols[j] = "en"
            elif kind in ("unit", "phonetic", "pos", "memory"):
                score += 1
                cols[j] = kind
        if score >= 7 and "word" in cols.values() and (
            "meaning" in cols.values() or "en" in cols.values()
        ):
            if score > best_score:
                best_score = score
                best_row = i
                best_cols = cols
    if best_row is None:
        return None
    return best_row, best_cols


def _unit_hint_from_heading_row(row: list[object]) -> tuple[str | None, int | None]:
    text = " ".join(_clean(x) for x in row)
    return _unit_from_text(text)


def _parse_sheet(sheet_name: str, sheet_index: int, rows: list[list[object]]) -> list[dict]:
    rows = [[_clean(x) for x in row] for row in rows]
    rows = [row for row in rows if any(row)]
    if not rows:
        return []

    header = _find_header(rows)
    output: list[dict] = []

    if header:
        header_row, cols = header
        col_word = next((i for i, k in cols.items() if k == "word"), None)
        if col_word is None:
            return []
        unit_name, unit_no = _unit_from_text(sheet_name)
        generic_sheet = not unit_name or re.match(
            r"^(sheet|工作簿|wordbook|vocab(?:ulary)?\s*\d*)$", sheet_name, re.I
        )
        # A title row such as "Unit 3" immediately before the header can set the unit.
        for before in range(header_row):
            hint, hint_no = _unit_hint_from_heading_row(rows[before])
            if hint:
                unit_name, unit_no = hint, hint_no
                break
        if not unit_name or generic_sheet:
            unit_name = f"Unit {sheet_index + 1}"
            unit_no = unit_no or sheet_index + 1

        col_unit = next((i for i, k in cols.items() if k == "unit"), None)
        col_phonetic = next((i for i, k in cols.items() if k == "phonetic"), None)
        col_pos = next((i for i, k in cols.items() if k == "pos"), None)
        col_meaning = next((i for i, k in cols.items() if k == "meaning"), None)
        col_en = next((i for i, k in cols.items() if k == "en"), None)
        col_memory = next((i for i, k in cols.items() if k == "memory"), None)

        current_name, current_no = unit_name, unit_no
        for row in rows[header_row + 1:]:
            if not any(row):
                continue
            if col_unit is not None and row[col_unit]:
                unit_cell = _clean(row[col_unit])
                hint, hint_no = _unit_from_text(unit_cell)
                unit_only_row = not any(
                    _looks_word(x) or _contains_cjk(x) for x in row if x != unit_cell
                )
                if hint:
                    current_name, current_no = hint, hint_no
                    if unit_only_row:
                        continue
                elif unit_cell.isdigit():
                    current_no = int(unit_cell)
                    current_name = f"Unit {current_no}"
                    if unit_only_row:
                        continue
            word_raw = _clean(row[col_word]) if col_word < len(row) else ""
            if not word_raw:
                continue
            if not _looks_word(word_raw) and not re.match(r"^[A-Za-z][A-Za-z'’\- ]+$", word_raw):
                # Could still be a multi-word phrase in one cell.
                if not re.match(r"^[A-Za-z][A-Za-z'’\- ]+$", word_raw):
                    continue
            parsed: dict | None = None
            meaning_cell = _clean(row[col_meaning]) if col_meaning is not None and col_meaning < len(row) else ""
            en_cell = _clean(row[col_en]) if col_en is not None and col_en < len(row) else ""
            phonetic_cell = _clean(row[col_phonetic]) if col_phonetic is not None and col_phonetic < len(row) else ""
            pos_cell = _clean(row[col_pos]) if col_pos is not None and col_pos < len(row) else ""
            memory_cell = _clean(row[col_memory]) if col_memory is not None and col_memory < len(row) else ""

            if " " in word_raw and not phonetic_cell and not meaning_cell:
                parsed = _entry_from_text(word_raw)
            if not parsed:
                parsed = {
                    "word": word_raw,
                    "phonetic": phonetic_cell,
                    "pos": pos_cell,
                    "meaning": "",
                    "meaning_en": "",
                    "memory": memory_cell,
                }
                if meaning_cell:
                    if not _contains_cjk(meaning_cell):
                        parsed["meaning_en"] = en_cell or meaning_cell
                    else:
                        pos_in_meaning, meaning_clean = _split_pos_from_meaning(meaning_cell)
                        parsed["pos"] = parsed["pos"] or pos_in_meaning
                        parsed["meaning"] = meaning_clean
                        parsed["meaning_en"] = en_cell
                elif en_cell:
                    parsed["meaning_en"] = en_cell
                else:
                    cell_parsed = _entry_from_text(" ".join(
                        _clean(x) for x in row if _clean(x)
                    ))
                    if cell_parsed and cell_parsed.get("meaning"):
                        parsed.update(cell_parsed)
            if not parsed.get("word"):
                continue
            parsed["word"] = parsed["word"].strip()
            parsed["unit_name"] = current_name
            parsed["unit_no"] = current_no
            output.append(parsed)
        return output

    # No header. Track Unit headings and group by a repeated numeric unit column.
    current_name, current_no = _unit_from_text(sheet_name)
    if not current_name:
        current_name = f"Unit {sheet_index + 1}"
        current_no = sheet_index + 1
    numeric_first: list[int] = []
    for row in rows:
        first = _clean(row[0]) if row else ""
        if first.isdigit() and not _looks_word(row[1] if len(row) > 1 else ""):
            numeric_first.append(int(first))
    has_repeated_units = False
    if numeric_first and len(numeric_first) > 2:
        unique = sorted(set(numeric_first))
        increasing = all(
            numeric_first[i] == numeric_first[i - 1] + 1
            for i in range(1, len(numeric_first))
        )
        has_repeated_units = not increasing and len(unique) < len(numeric_first)

    for row in rows:
        if not any(row):
            continue
        joined = " ".join(_clean(x) for x in row).strip()
        hint, hint_no = _unit_from_text(joined)
        # A heading row usually contains only unit text and no separate word.
        if hint and not any(_looks_word(x) for x in row):
            current_name, current_no = hint, hint_no
            continue
        # A unit column may repeat "Unit 1" on every row together with the word.
        if hint and row and _unit_from_text(_clean(row[0]))[0]:
            current_name, current_no = hint, hint_no
            row = row[1:] if len(row) > 1 else row
            joined = " ".join(_clean(x) for x in row).strip()

        fields = row
        if has_repeated_units and fields and _clean(fields[0]).isdigit():
            no_text = int(_clean(fields[0]))
            current_no = no_text
            current_name = f"Unit {no_text}"
            fields = fields[1:]
        parsed = _entry_from_fields(fields)
        if not parsed:
            continue
        if not parsed["word"] or parsed["word"].startswith(("http", "www.")):
            continue
        parsed["unit_name"] = current_name
        parsed["unit_no"] = current_no
        output.append(parsed)
    return output


def _parse_xlsx(data: bytes) -> list[dict]:
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    records: list[dict] = []
    for idx, sheet_name in enumerate(wb.sheetnames):
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        records.extend(_parse_sheet(sheet_name, idx, rows))
    wb.close()
    return records


def _parse_csv(data: bytes, filename: str) -> list[dict]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("gb18030", errors="replace")
    dialect = csv.Sniffer().sniff(text[:4096], delimiters=",\t;")
    reader = csv.reader(io.StringIO(text), dialect)
    rows = [list(row) for row in reader]
    return _parse_sheet(Path(filename).stem or "Unit 1", 0, rows)


def _parse_json(data: bytes) -> list[dict]:
    parsed = json.loads(data.decode("utf-8-sig"))
    if isinstance(parsed, dict):
        for key in ("words", "vocab", "data", "items"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break
    records: list[dict] = []
    for idx, item in enumerate(parsed if isinstance(parsed, list) else []):
        if not isinstance(item, dict):
            continue
        unit_name = _clean(item.get("unit") or item.get("unit_name"))
        word = _clean(item.get("word") or item.get("单词"))
        if not word:
            continue
        meaning = _clean(item.get("meaning") or item.get("meaning_cn")
                          or item.get("chinese") or item.get("中文") or item.get("释义"))
        meaning_en = _clean(item.get("meaning_en") or item.get("english") or item.get("英释"))
        records.append({
            "word": word,
            "phonetic": _clean(item.get("phonetic") or item.get("音标")),
            "pos": _clean(item.get("pos") or item.get("词性")),
            "meaning": meaning,
            "meaning_en": meaning_en,
            "memory": _clean(item.get("memory") or item.get("助记")),
            "unit_name": unit_name or f"Unit {idx + 1}",
            "unit_no": _unit_from_text(unit_name)[1] if unit_name else None,
        })
    return records


def _docx_paragraphs(data: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    root = ET.fromstring(xml)
    lines: list[str] = []
    for para in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        texts = [
            t.text or ""
            for t in para.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
        ]
        lines.append("".join(texts).strip())
    return lines


def _pdf_pages(data: bytes) -> list[str]:
    import io
    import logging

    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("PDF 解析组件未安装，请重新运行一次启动器后重试。") from exc

    logging.getLogger("pypdf").setLevel(logging.ERROR)
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    return pages


def _pdf_unit_name(line: str) -> tuple[str | None, int | None]:
    t = _clean(line)
    if re.match(r"^Direct\s+Hits\s+CHAPTER", t, re.I):
        m = re.search(r"CHAPTER\s*([0-9IVX]+)\s*[:：,]?\s*(.*)$", t, re.I)
        if not m:
            return t, None
        raw_no = m.group(1)
        roman = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5,
                 "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10}
        no = int(raw_no) if raw_no.isdigit() else roman.get(raw_no.upper())
        label = f"Chapter {no}" if no else t
        suffix = m.group(2).strip(" :：,，.-")
        if suffix:
            label = f"{label} - {suffix}"
        return label, no
    m = re.match(
        r"^(?:Word\s+)?List\s+([0-9]{1,3})(?:\s*[:：,，-]\s*|\s+)(.*)$",
        t,
        re.I,
    )
    if m:
        no = int(m.group(1))
        return f"Word List {no}", no
    return None, None


def _pdf_word_from_tokens(token: str) -> str | None:
    t = token.strip(" ,，;；:：，,()（）[]")
    if not t or not re.match(r"^[A-Za-z\uFB00-\uFB06][A-Za-z'’\-,\uFB00-\uFB06]*$", t):
        return None
    # Do not mistake standalone POS tags for headwords.
    core = re.sub(r"[.,]", "", t).lower()
    if core in POS_WORDS or core.endswith(".") and core.rstrip(".") in POS_WORDS:
        return None
    return t


def _cjk_part(value: str) -> tuple[str, str, str]:
    m = re.search(r"[\u2e80-\u2fff\u3400-\u9fff\uF900-\uFAFF]", value)
    if not m:
        return value, "", ""
    start = m.start()
    if start > 0 and value[start - 1] in "(（[【":
        start -= 1
    return value[:start].strip(), value[start:].strip(), ""


def _normalize_pdf_cjk(value: str) -> str:
    """Clean duplicated compatibility CJK characters found in PDF exports."""
    normalized = unicodedata.normalize("NFKC", value)
    out: list[str] = []
    for ch in normalized:
        if out and ch == out[-1] and CJK_RE.fullmatch(ch):
            continue
        out.append(ch)
    return "".join(out)


def _clean_pdf_word(word: str) -> str:
    word = re.sub(r"[\uFB00-\uFB06]", lambda m: {
        "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
        "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st",
        "\ufb06": "st",
    }.get(m.group(0), m.group(0)), word)
    word = word.replace("-\n", "").replace("–", "-").replace("—", "-")
    word = re.sub(r"\s+", " ", word).strip()
    # PDF line wrapping can split "self-" and "effacing".
    word = re.sub(r"(?<=-)\s+", "", word)
    return word.strip(" ,，;；")


def _pdf_pos_and_meaning(tail: str) -> tuple[str, str]:
    """Separate a PDF tail such as ``v./n. 提倡`` into POS and meaning."""
    if not tail:
        return "", ""
    m = re.match(r"^\s*([A-Za-z][A-Za-z/.]{0,15}?)\.\s*(.*)$", tail)
    if m:
        pos = m.group(1)
        rest = m.group(2)
        if pos.lower().split("/")[0].split(".")[0] in POS_WORDS:
            return pos, rest
    pre, meaning, _ = _cjk_part(tail)
    pos_match = re.match(r"^([A-Za-z/.]{1,15}?)\.?\s*$", pre)
    return (pos_match.group(1) if pos_match else ""), meaning


def _parse_barron_chunk(lines: list[str]) -> list[dict]:
    if not lines:
        return []
    head = lines[0]
    m = re.match(
        r"^(?P<word>[A-Za-z\uFB00-\uFB06][A-Za-z0-9'’\-\uFB00-\uFB06]*)"
        r"\s*\[(?P<phon>[^\]]+)\](?P<tail>.*)$",
        head,
        re.I,
    )
    if not m:
        return []
    word = _clean_pdf_word(m.group("word"))
    if not word:
        return []
    phon = m.group("phon").strip("[] ")
    pos, meaning = _pdf_pos_and_meaning(m.group("tail"))
    if not meaning:
        for extra in lines[1:6]:
            if not extra:
                continue
            if _is_pos_token(extra) and not _contains_cjk(extra):
                if not pos:
                    pos = extra.strip("()（）[]")
                continue
            extra_pos, meaning = _pdf_pos_and_meaning(extra)
            if meaning:
                if not pos:
                    pos = extra_pos
                break
    meaning = _normalize_pdf_cjk(meaning).strip(" 　;；。")
    return [{
        "word": word,
        "phonetic": phon,
        "pos": pos,
        "meaning": meaning,
        "meaning_en": "",
        "memory": "",
    }]


def _direct_headwords(chunk_lines: list[str]) -> tuple[list[str], str, str, str]:
    """Extract headwords, POS and Chinese from one Direct Hits chunk."""
    chinese_idx = None
    chinese_line = ""
    for i, line in enumerate(chunk_lines):
        if _contains_cjk(line):
            # The first Chinese line is the main translation; later Chinese
            # belongs to derived-word/antonym notes after the English definition.
            chinese_idx = i
            chinese_line = line
            break
    if chinese_idx is None:
        return [], "", "", ""

    combined = ""
    stop_pos_seen = False
    for line in chunk_lines[: chinese_idx + 1]:
        line = re.sub(r"^\s*\d{1,4}\s*(?:[.、)）]\s*)?", "", line)
        # Drop phonetic fragments but remember that a POS marker may follow.
        line = re.sub(r"\[[^\]]*\]", " ", line)
        if re.search(r"[,，;；]\s*$|-$", line) or (combined and not stop_pos_seen):
            combined += " " + line
        else:
            combined += " " + line
        if re.search(r"(?:\b(?:adj|adv|n|v|vt|vi|prep|pron|conj|a|abbr|phr)\.?\s*)$", line, re.I):
            stop_pos_seen = True

    # POS before Chinese on the Chinese line.
    pre_meaning, meaning, _ = _cjk_part(chinese_line)
    pos = ""
    pos_m = re.search(r"(adj|adv|n|v|vt|vi|prep|pron|conj|a|abbr|phr)\.?", pre_meaning, re.I)
    if pos_m:
        pos = pos_m.group(1) + "."
    if not pos:
        # Look at any earlier standalone POS line.
        for line in chunk_lines[:chinese_idx]:
            pos_m = re.match(r"^\s*(adj|adv|n|v|vt|vi|prep|pron|conj|a|abbr|phr)\.?\s*$", line, re.I)
            if pos_m:
                pos = pos_m.group(1) + "."
                break

    words: list[str] = []
    current = ""
    for token in re.split(r"[\s]+", combined):
        if not token:
            continue
        if token.startswith("[") or token.endswith("]"):
            continue
        # Remove hyphen continuation introduced by PDF line wrapping.
        token = token.replace("\u00ad", "")
        token = token.strip(" ,，;；")
        if not token:
            continue
        if re.match(r"^[A-Za-z/.]{1,10}\.?$", token) and _is_pos_token(token):
            break
        if _pdf_word_from_tokens(token):
            current += token + ","
        else:
            # Keep plain alphabetical pieces for split hyphens.
            stripped = token.strip(",，;；")
            if stripped and re.match(r"^[A-Za-z\uFB00-\uFB06]+$", stripped):
                current += stripped + ","
    if current:
        words = [w for w in re.split(r"\s*,\s*", current.strip(",")) if w]
    return words, _normalize_pdf_cjk(meaning), pos, ""


def _parse_direct_chunk(lines: list[str]) -> list[dict]:
    words, meaning, pos, _ = _direct_headwords(lines)
    records = []
    for word in words:
        records.append({
            "word": _clean_pdf_word(word),
            "phonetic": "",
            "pos": pos,
            "meaning": meaning,
            "meaning_en": "",
            "memory": "",
        })
    return records


def _parse_pdf(data: bytes) -> list[dict]:
    pages = _pdf_pages(data)
    all_lines = []
    for page in pages:
        all_lines.extend(page.splitlines())
        all_lines.append("\x00PAGE\x00")
    if sum(len(x) for x in all_lines) < 120:
        raise ValueError(
            "这份 PDF 没有可直接读取的文字，可能是扫描图片版。"
            "请把它另存为文字版 PDF，或先转成 Excel/CSV/TXT。"
        )

    barron_records: list[dict] = []
    direct_records: list[dict] = []
    chunk: list[str] = []
    unit_name = ""
    unit_no: int | None = None
    saw_barron_style = False
    saw_direct_style = False

    def flush(records: list[dict]) -> None:
        nonlocal chunk
        if not chunk:
            return
        parsed = _parse_barron_chunk(chunk) if records is barron_records else _parse_direct_chunk(chunk)
        for rec in parsed:
            rec["unit_name"] = unit_name or "Unit 1"
            rec["unit_no"] = unit_no
        records.extend(parsed)
        chunk = []

    def anchor_kind(line: str) -> str | None:
        t = _clean(line)
        if re.match(r"^\d{1,4}\s*$", t):
            # A lone number may be a page number; only trust it when a later
            # line starts a word line.
            return "number-only"
        if re.match(r"^\d{1,4}\s*(?:[.、)）]\s*)?[A-Za-z\uFB00-\uFB06]", t):
            return "direct"
        if re.match(
            r"^[A-Za-z\uFB00-\uFB06][A-Za-z0-9'’\-\uFB00-\uFB06]*\s*\[[^\]]+\]",
            t,
            re.I,
        ):
            return "barron"
        return None

    number_only_pending = False
    for line in all_lines:
        if line == "\x00PAGE\x00":
            continue
        t = _clean(line)
        if not t:
            continue
        if t in ("Direct Hits", "Word List for SAT") or t.startswith("Barron’s 3500"):
            continue
        unit, no = _pdf_unit_name(t)
        if unit:
            # Flush the previous chunk if needed, then switch unit.
            if chunk:
                flush(barron_records if saw_barron_style and not saw_direct_style else direct_records)
            unit_name = unit
            unit_no = no
            saw_barron_style = saw_barron_style or "Word List" in unit
            saw_direct_style = saw_direct_style or unit.startswith("Chapter")
            continue

        kind = anchor_kind(t)
        if kind == "barron":
            saw_barron_style = True
            flush(barron_records)
            chunk = [t]
            continue
        if kind == "direct":
            saw_direct_style = True
            flush(direct_records)
            number_only_pending = False
            chunk = [t]
            continue
        if kind == "number-only":
            number_only_pending = True
            continue
        if chunk:
            chunk.append(t)
        elif number_only_pending and re.match(r"^[A-Za-z\uFB00-\uFB06]", t):
            # Some numbered entries place the number on its own visual line.
            saw_direct_style = True
            flush(direct_records)
            chunk = [t]
            number_only_pending = False

    if chunk:
        flush(barron_records if saw_barron_style and not saw_direct_style else direct_records)

    records = barron_records if len(barron_records) >= len(direct_records) else direct_records
    if not records:
        records = normalize_records(_parse_text_string("\n".join(all_lines)))
    return records


def _parse_text(data: bytes) -> list[dict]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("gb18030", errors="replace")
    return _parse_text_string(text)


def _parse_text_string(text: str) -> list[dict]:
    records: list[dict] = []
    current_name = "Unit 1"
    current_no: int | None = 1
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", "//", "<!--")):
            continue
        hint, hint_no = _unit_from_text(line)
        if hint:
            current_name, current_no = hint, hint_no
            continue
        parsed = _entry_from_text(line)
        if not parsed:
            # Some files use one English word per line followed by its meaning.
            if _looks_word(line):
                parsed = {
                    "word": line,
                    "phonetic": "",
                    "pos": "",
                    "meaning": "",
                    "meaning_en": "",
                    "memory": "",
                }
        if not parsed:
            continue
        parsed["unit_name"] = current_name
        parsed["unit_no"] = current_no
        records.append(parsed)
    return records


def parse_import(filename: str | None, data: bytes) -> list[dict]:
    name = (filename or "").lower()
    ext = Path(name).suffix.lower()
    if ext == ".xlsx":
        return _parse_xlsx(data)
    if ext in (".csv", ".tsv", ".txt"):
        if ext == ".csv" and not name:
            return _parse_csv(data, name)
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("gb18030", errors="replace")
        if ext == ".csv":
            return _parse_csv(data, name)
        return _parse_text(data)
    if ext == ".json":
        return _parse_json(data)
    if ext == ".docx":
        lines = _docx_paragraphs(data)
        return _parse_text_string("\n".join(lines))
    if ext == ".pdf":
        return _parse_pdf(data)
    # Unknown or extension-less files: try plain text first.
    if ext not in (".doc", ".xls"):
        return _parse_text(data)
    raise ValueError(f"暂不支持 .{ext} 文件，请先转换为 Excel、CSV、TXT 或 JSON。")


def normalize_records(records: list[dict]) -> list[dict]:
    unit_order: list[str] = []
    seen_units: dict[str, int] = {}
    cleaned: list[dict] = []
    seen_words: set[tuple[str, str]] = set()
    for rec in records:
        word = re.sub(r"^[A-Za-z]?[.、)）:：]?\s+", "", _clean(rec.get("word", "")))
        word = re.sub(r"\s+", " ", word).strip(" .,;，。；：")
        if not word or len(word) > 160 or not re.search(r"[A-Za-z]", word):
            continue
        unit_name = _clean(rec.get("unit_name")) or "Unit 1"
        if unit_name not in seen_units:
            seen_units[unit_name] = len(unit_order)
            unit_order.append(unit_name)
        unit_no = rec.get("unit_no")
        if unit_no is not None:
            try:
                unit_no = int(unit_no)
            except (TypeError, ValueError):
                unit_no = seen_units[unit_name] + 1
        else:
            unit_no = seen_units[unit_name] + 1
        key = (unit_name, word.lower())
        if key in seen_words:
            continue
        seen_words.add(key)
        phonetic = _clean(rec.get("phonetic", ""))
        pos = _clean(rec.get("pos", ""))
        meaning = _clean(rec.get("meaning", ""))
        meaning_en = _clean(rec.get("meaning_en", ""))
        memory = _clean(rec.get("memory", ""))
        if not meaning and meaning_en:
            meaning_en = re.sub(r"\s+", " ", meaning_en)
        cleaned.append({
            "word": word,
            "unit_name": unit_name,
            "unit_no": unit_no,
            "phonetic": phonetic,
            "pos": pos,
            "meaning": meaning,
            "meaning_en": meaning_en,
            "memory": memory,
        })
    return cleaned


def load_from_payload(filename: str | None, file_base64: str | None,
                      text: str | None) -> list[dict]:
    import base64

    if text:
        records = _parse_text_string(text)
    elif file_base64:
        payload = file_base64
        if "," in payload and payload.startswith("data:"):
            payload = payload.split(",", 1)[1]
        raw = base64.b64decode(payload)
        records = parse_import(filename, raw)
    else:
        raise ValueError("没有收到文件或文字内容")
    normalized = normalize_records(records)
    if not normalized:
        raise ValueError(
            "没有识别到可导入的词条。请确保文件里至少有一列英文单词和一列中文释义，"
            "或用「单词 中文释义」这样的格式粘贴文本。"
        )
    return normalized
