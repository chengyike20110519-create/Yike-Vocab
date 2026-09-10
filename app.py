"""Local vocabulary learning website.

Run with: python3 app.py
"""

from __future__ import annotations

import contextvars
import json
import mimetypes
import random
import re
import sqlite3
import sys
import threading
import urllib.parse
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from export_pdf import build_pdf
from importer import load_from_payload, normalize_records

ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / "static"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "vocab.db"
MAX_BODY = 256 * 1024 * 1024
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
SESSION_DB_PATH = contextvars.ContextVar("session_db_path", default=str(DB_PATH))


def utcnow_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def utcnow_ms() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(SESSION_DB_PATH.get(), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: str | Path | None = None) -> None:
    db_path = Path(db_path) if db_path is not None else DB_PATH
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path, timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                source_name TEXT,
                imported_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS units (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id INTEGER NOT NULL,
                no INTEGER NOT NULL DEFAULT 0,
                name TEXT NOT NULL,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS words (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                unit_id INTEGER NOT NULL,
                word TEXT NOT NULL,
                phonetic TEXT DEFAULT '',
                pos TEXT DEFAULT '',
                meaning TEXT DEFAULT '',
                meaning_en TEXT DEFAULT '',
                memory TEXT DEFAULT '',
                UNIQUE(unit_id, word),
                FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS reviews (
                word_id INTEGER PRIMARY KEY,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS word_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_words_unit ON words(unit_id);
            CREATE INDEX IF NOT EXISTS idx_units_book ON units(book_id);
            CREATE INDEX IF NOT EXISTS idx_word_events_word ON word_events(word_id, status);
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO word_events (word_id, status, created_at)
            SELECT word_id, status, updated_at
            FROM reviews
            WHERE word_id NOT IN (SELECT word_id FROM word_events)
            """
        )


def resolve_session_db(session_id: str) -> str:
    if not session_id:
        return str(DB_PATH)
    if not SESSION_ID_RE.match(session_id):
        raise ValueError("无效的会话标识")
    session_dir = DATA_DIR / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    db_path = session_dir / f"{session_id}.db"
    init_db(db_path)
    return str(db_path)


def _unit_stats(conn: sqlite3.Connection, book_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            u.id,
            u.no,
            u.name,
            COUNT(w.id) AS word_count,
            COALESCE(SUM(CASE WHEN r.status = 'know' THEN 1 ELSE 0 END), 0) AS know_count,
            COALESCE(SUM(CASE WHEN r.status = 'fuzzy' THEN 1 ELSE 0 END), 0) AS fuzzy_count,
            COALESCE(SUM(CASE WHEN r.status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count
        FROM units u
        LEFT JOIN words w ON w.unit_id = u.id
        LEFT JOIN reviews r ON r.word_id = w.id
        WHERE u.book_id = ?
        GROUP BY u.id
        ORDER BY u.no, u.id
        """,
        (book_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "no": row["no"],
            "name": row["name"],
            "word_count": row["word_count"],
            "stats": {
                "know": row["know_count"],
                "fuzzy": row["fuzzy_count"],
                "unknown": row["unknown_count"],
            },
        }
        for row in rows
    ]


def list_books() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT b.id, b.name, b.source_name, b.imported_at,
                   COUNT(DISTINCT u.id) AS unit_count,
                   COUNT(w.id) AS word_count
            FROM books b
            LEFT JOIN units u ON u.book_id = b.id
            LEFT JOIN words w ON w.unit_id = u.id
            GROUP BY b.id
            ORDER BY b.id DESC
            """
        ).fetchall()
        result = []
        for row in rows:
            book = {
                "id": row["id"],
                "name": row["name"],
                "source_name": row["source_name"],
                "imported_at": row["imported_at"],
                "unit_count": row["unit_count"],
                "word_count": row["word_count"],
                "units": _unit_stats(conn, row["id"]),
            }
            result.append(book)
        return result


def fetch_cards(
    book_id: int,
    unit_ids: list[int] | None = None,
    shuffle: bool = False,
    status: str | None = None,
) -> list[dict]:
    if status and status not in ("know", "fuzzy", "unknown"):
        raise ValueError("状态只能是 know / fuzzy / unknown")
    with connect() as conn:
        sql = """
            SELECT w.id, w.word, w.phonetic, w.pos, w.meaning, w.meaning_en,
                   w.memory, u.id AS unit_id, u.name AS unit_name,
                   r.status AS current_status,
                   (SELECT COUNT(*) FROM word_events e
                    WHERE e.word_id = w.id AND e.status = 'know') AS know_count,
                   (SELECT COUNT(*) FROM word_events e
                    WHERE e.word_id = w.id AND e.status = 'fuzzy') AS fuzzy_count,
                   (SELECT COUNT(*) FROM word_events e
                    WHERE e.word_id = w.id AND e.status = 'unknown') AS unknown_count
            FROM words w
            JOIN units u ON u.id = w.unit_id
            WHERE u.book_id = ?
        """
        join_clause = "JOIN reviews r ON r.word_id = w.id" if status else "LEFT JOIN reviews r ON r.word_id = w.id"
        sql = sql.replace("WHERE u.book_id = ?", f"{join_clause}\n            WHERE u.book_id = ?")
        params: list[object] = [book_id]
        if unit_ids:
            placeholders = ",".join("?" for _ in unit_ids)
            sql += f" AND u.id IN ({placeholders})"
            params.extend(unit_ids)
        if status:
            sql += " AND r.status = ?"
            params.append(status)
        sql += " ORDER BY " + ("RANDOM()" if shuffle else "u.no, w.id")
        rows = conn.execute(sql, params).fetchall()
    return [
        {
            "id": row["id"],
            "word": row["word"],
            "phonetic": row["phonetic"] or "",
            "pos": row["pos"] or "",
            "meaning": row["meaning"] or "",
            "meaning_en": row["meaning_en"] or "",
            "memory": row["memory"] or "",
            "unit_id": row["unit_id"],
            "unit_name": row["unit_name"],
            "status": row["current_status"] or "",
            "know_count": row["know_count"] or 0,
            "fuzzy_count": row["fuzzy_count"] or 0,
            "unknown_count": row["unknown_count"] or 0,
        }
        for row in rows
    ]


def delete_book(book_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM books WHERE id = ?", (book_id,))


def rename_book(book_id: int, name: str) -> None:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("词书名不能为空")
    with connect() as conn:
        book = conn.execute("SELECT id FROM books WHERE id = ?", (book_id,)).fetchone()
        if not book:
            raise ValueError("找不到这本词书")
        duplicate = conn.execute(
            "SELECT id FROM books WHERE lower(name) = lower(?) AND id != ?",
            (clean_name, book_id),
        ).fetchone()
        if duplicate:
            raise ValueError("已经有同名词书，请换一个名字")
        conn.execute("UPDATE books SET name = ? WHERE id = ?", (clean_name, book_id))


def mark_word(word_id: int, status: str) -> None:
    if status not in ("know", "fuzzy", "unknown"):
        raise ValueError("状态只能是 know / fuzzy / unknown")
    with connect() as conn:
        now = utcnow_ms()
        conn.execute(
            """
            INSERT INTO reviews (word_id, status, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(word_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at
            """,
            (word_id, status, now),
        )
        conn.execute(
            "INSERT INTO word_events (word_id, status, created_at) VALUES (?, ?, ?)",
            (word_id, status, now),
        )


def update_word_meaning(word_id: int, meaning: str) -> None:
    clean_meaning = meaning.strip()
    if not clean_meaning:
        raise ValueError("中文释义不能为空")
    with connect() as conn:
        word = conn.execute("SELECT id FROM words WHERE id = ?", (word_id,)).fetchone()
        if not word:
            raise ValueError("找不到这个单词")
        conn.execute("UPDATE words SET meaning = ? WHERE id = ?", (clean_meaning, word_id))


def word_history(word_id: int) -> dict:
    with connect() as conn:
        word = conn.execute(
            """
            SELECT w.id, w.word, w.phonetic, w.meaning, w.meaning_en, u.name AS unit_name
            FROM words w
            JOIN units u ON u.id = w.unit_id
            WHERE w.id = ?
            """,
            (word_id,),
        ).fetchone()
        if not word:
            raise ValueError("找不到这个单词")
        events = conn.execute(
            """
            SELECT status, created_at
            FROM word_events
            WHERE word_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            (word_id,),
        ).fetchall()
        counts = conn.execute(
            """
            SELECT status, COUNT(*) AS n
            FROM word_events
            WHERE word_id = ?
            GROUP BY status
            """,
            (word_id,),
        ).fetchall()
        count_map = {row["status"]: row["n"] for row in counts}
    return {
        "word_id": word["id"],
        "word": word["word"],
        "phonetic": word["phonetic"] or "",
        "meaning": word["meaning"] or "",
        "meaning_en": word["meaning_en"] or "",
        "unit_name": word["unit_name"],
        "counts": {
            "know": count_map.get("know", 0),
            "fuzzy": count_map.get("fuzzy", 0),
            "unknown": count_map.get("unknown", 0),
        },
        "events": [
            {"status": e["status"], "created_at": e["created_at"]}
            for e in events
        ],
    }


def study_log(days: int = 84, recent_limit: int = 20) -> dict:
    days = max(7, min(int(days), 365))
    recent_limit = max(1, min(int(recent_limit), 100))
    today = date.today()
    window_start = today - timedelta(days=days - 1)

    with connect() as conn:
        totals = conn.execute(
            """
            SELECT
                COUNT(*) AS total_events,
                COUNT(DISTINCT e.word_id) AS learned_words,
                COUNT(DISTINCT substr(e.created_at, 1, 10)) AS active_days,
                COUNT(DISTINCT b.id) AS touched_books
            FROM word_events e
            JOIN words w ON w.id = e.word_id
            JOIN units u ON u.id = w.unit_id
            JOIN books b ON b.id = u.book_id
            """
        ).fetchone()
        active_rows = conn.execute(
            """
            SELECT DISTINCT substr(created_at, 1, 10) AS day
            FROM word_events
            ORDER BY day
            """
        ).fetchall()
        daily_rows = conn.execute(
            """
            SELECT
                substr(e.created_at, 1, 10) AS day,
                COUNT(*) AS total,
                COUNT(DISTINCT e.word_id) AS word_count,
                SUM(CASE WHEN e.status = 'know' THEN 1 ELSE 0 END) AS know_count,
                SUM(CASE WHEN e.status = 'fuzzy' THEN 1 ELSE 0 END) AS fuzzy_count,
                SUM(CASE WHEN e.status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
            FROM word_events e
            WHERE substr(e.created_at, 1, 10) >= ?
            GROUP BY day
            ORDER BY day DESC
            """,
            (window_start.isoformat(),),
        ).fetchall()
        recent_rows = conn.execute(
            """
            SELECT
                e.created_at,
                e.status,
                w.word,
                w.meaning,
                u.name AS unit_name,
                b.name AS book_name
            FROM word_events e
            JOIN words w ON w.id = e.word_id
            JOIN units u ON u.id = w.unit_id
            JOIN books b ON b.id = u.book_id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT ?
            """,
            (recent_limit,),
        ).fetchall()

    active_dates = {row["day"] for row in active_rows if row["day"]}
    dated_streaks = sorted(
        date.fromisoformat(day)
        for day in active_dates
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)
    )
    longest_streak = 0
    running_streak = 0
    previous_day: date | None = None
    for day in dated_streaks:
        running_streak = running_streak + 1 if previous_day and day == previous_day + timedelta(days=1) else 1
        longest_streak = max(longest_streak, running_streak)
        previous_day = day

    def streak_from(anchor: date) -> int:
        streak = 0
        cursor = anchor
        while cursor.isoformat() in active_dates:
            streak += 1
            cursor -= timedelta(days=1)
        return streak

    yesterday = today - timedelta(days=1)
    if today.isoformat() in active_dates:
        current_streak = streak_from(today)
    elif yesterday.isoformat() in active_dates:
        current_streak = streak_from(yesterday)
    else:
        current_streak = 0

    recent_days = [
        {
            "date": row["day"],
            "total": row["total"],
            "word_count": row["word_count"],
            "know": row["know_count"],
            "fuzzy": row["fuzzy_count"],
            "unknown": row["unknown_count"],
        }
        for row in daily_rows
    ]
    today_log = next((item for item in recent_days if item["date"] == today.isoformat()), None)

    return {
        "generated_at": utcnow_ms(),
        "window_days": days,
        "summary": {
            "current_streak": current_streak,
            "longest_streak": longest_streak,
            "active_days": totals["active_days"] or 0,
            "total_events": totals["total_events"] or 0,
            "learned_words": totals["learned_words"] or 0,
            "touched_books": totals["touched_books"] or 0,
            "today_events": today_log["total"] if today_log else 0,
            "today_words": today_log["word_count"] if today_log else 0,
            "today_checked_in": bool(today_log),
        },
        "days": recent_days,
        "recent_events": [
            {
                "created_at": row["created_at"],
                "status": row["status"],
                "word": row["word"],
                "meaning": row["meaning"] or "",
                "unit_name": row["unit_name"],
                "book_name": row["book_name"],
            }
            for row in recent_rows
        ],
    }


def reset_progress(word_ids: list[int]) -> None:
    if not word_ids:
        return
    with connect() as conn:
        placeholders = ",".join("?" for _ in word_ids)
        conn.execute(f"DELETE FROM reviews WHERE word_id IN ({placeholders})", word_ids)
        conn.execute(f"DELETE FROM word_events WHERE word_id IN ({placeholders})", word_ids)


def import_records(
    records: list[dict],
    *,
    book_name: str,
    source_name: str,
    replace_same: bool = True,
    append_book_id: int | None = None,
) -> dict:
    cleaned = normalize_records(records)
    if not cleaned:
        raise ValueError("没有识别到有效词条")
    name = book_name.strip() or "我的词书"
    with connect() as conn:
        if append_book_id is not None:
            existing_book = conn.execute(
                "SELECT id, name FROM books WHERE id = ?", (append_book_id,)
            ).fetchone()
            if not existing_book:
                raise ValueError("找不到要添加单词的词书")
            book_id = existing_book["id"]
            name = existing_book["name"]
        else:
            if replace_same:
                existing = conn.execute(
                    "SELECT id FROM books WHERE lower(name) = lower(?)",
                    (name,),
                ).fetchone()
                if existing:
                    conn.execute("DELETE FROM books WHERE id = ?", (existing["id"],))

            cur = conn.execute(
                "INSERT INTO books (name, source_name, imported_at) VALUES (?, ?, ?)",
                (name, source_name, utcnow_iso()),
            )
            book_id = cur.lastrowid

        existing_units = conn.execute(
            "SELECT id, no, name FROM units WHERE book_id = ?", (book_id,)
        ).fetchall()
        unit_cache: dict[str, tuple[int, int]] = {
            row["name"]: (row["id"], row["no"]) for row in existing_units
        }
        next_unit_no = max((row["no"] for row in existing_units), default=0) + 1
        word_count = 0
        duplicate_count = 0
        for rec in cleaned:
            unit_name = rec["unit_name"]
            if unit_name not in unit_cache:
                no = rec.get("unit_no")
                try:
                    no = int(no) if no is not None else next_unit_no
                except (TypeError, ValueError):
                    no = next_unit_no
                used_numbers = {unit_no for _unit_id, unit_no in unit_cache.values()}
                while no in used_numbers:
                    no = next_unit_no
                    next_unit_no += 1
                uc = conn.execute(
                    "INSERT INTO units (book_id, no, name) VALUES (?, ?, ?)",
                    (book_id, no, unit_name),
                )
                unit_cache[unit_name] = (uc.lastrowid, no)
                next_unit_no = max(next_unit_no, no + 1)
            unit_id, _no = unit_cache[unit_name]
            try:
                conn.execute(
                    """
                    INSERT INTO words
                        (unit_id, word, phonetic, pos, meaning, meaning_en, memory)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        unit_id,
                        rec["word"],
                        rec.get("phonetic") or "",
                        rec.get("pos") or "",
                        rec.get("meaning") or "",
                        rec.get("meaning_en") or "",
                        rec.get("memory") or "",
                    ),
                )
                word_count += 1
            except sqlite3.IntegrityError:
                duplicate_count += 1
    return {
        "book_id": book_id,
        "name": name,
        "unit_count": len(unit_cache),
        "word_count": word_count,
        "duplicate_count": duplicate_count,
    }


class VocabularyHandler(BaseHTTPRequestHandler):
    server_version = "VocabLocal/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            self._send_json(413, {"error": "文件过大，请拆分成更小的文件导入。"})
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"error": f"请求内容不是有效的 JSON：{exc}"})
            raise ValueError("bad json") from exc

    def _send_bytes(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Session-ID")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload: object) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, data, "application/json; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        if not path.is_file() or not str(path.resolve()).startswith(str(STATIC_ROOT.resolve())):
            self._send_json(404, {"error": "文件不存在"})
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self._send_bytes(200, path.read_bytes(), content_type)

    def _activate_session(self) -> bool:
        session_id = self.headers.get("X-Session-ID", "")
        try:
            SESSION_DB_PATH.set(resolve_session_db(session_id))
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return False
        return True

    def _route(self) -> tuple[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, parsed.query

    def do_GET(self) -> None:
        if not self._activate_session():
            return
        path, query = self._route()
        if path in ("/", "/index.html"):
            self._send_file(STATIC_ROOT / "index.html")
            return
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            self._send_file((STATIC_ROOT / rel).resolve())
            return
        if path in ("/app.js", "/styles.css"):
            self._send_file((STATIC_ROOT / path.lstrip("/")).resolve())
            return
        if path == "/api/health":
            self._send_json(200, {"ok": True, "time": utcnow_iso()})
            return
        if path == "/api/books":
            self._send_json(200, {"books": list_books()})
            return
        if path == "/api/cards":
            params = urllib.parse.parse_qs(query)
            try:
                book_id = int((params.get("book") or ["0"])[0])
            except ValueError:
                self._send_json(400, {"error": "book 参数不正确"})
                return
            units = [int(x) for x in (params.get("units") or [""])[0].split(",") if x.isdigit()]
            shuffle = (params.get("shuffle") or ["0"])[0] in ("1", "true", "yes")
            status = (params.get("status") or [""])[0] or None
            cards = fetch_cards(book_id, units or None, shuffle, status)
            unit_names = sorted({card["unit_name"] for card in cards})
            self._send_json(200, {
                "book_id": book_id,
                "cards": cards,
                "unit_names": unit_names,
                "count": len(cards),
            })
            return
        if path == "/api/word-history":
            params = urllib.parse.parse_qs(query)
            try:
                word_id = int((params.get("word_id") or ["0"])[0])
            except ValueError:
                self._send_json(400, {"error": "word_id 参数不正确"})
                return
            try:
                history = word_history(word_id)
            except ValueError as exc:
                self._send_json(404, {"error": str(exc)})
                return
            self._send_json(200, history)
            return
        if path == "/api/study-log":
            params = urllib.parse.parse_qs(query)
            try:
                days = int((params.get("days") or ["84"])[0])
                recent_limit = int((params.get("events") or ["20"])[0])
            except ValueError:
                self._send_json(400, {"error": "统计参数不正确"})
                return
            self._send_json(200, study_log(days, recent_limit))
            return
        self._send_json(404, {"error": "接口不存在"})

    def do_OPTIONS(self) -> None:
        self._send_bytes(204, b"", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        if not self._activate_session():
            return
        path, _query = self._route()
        try:
            payload = self._read_json()
        except ValueError:
            return
        try:
            if path == "/api/import":
                records = load_from_payload(
                    payload.get("filename"),
                    payload.get("file_base64"),
                    payload.get("text"),
                )
                result = import_records(
                    records,
                    book_name=payload.get("name") or "",
                    source_name=payload.get("filename") or "粘贴文本",
                    replace_same=bool(payload.get("replace_same", True)),
                    append_book_id=(
                        int(payload["append_book_id"])
                        if payload.get("append_book_id") is not None
                        else None
                    ),
                )
                self._send_json(200, result)
                return
            if path == "/api/mark":
                word_id = int(payload["word_id"])
                status = str(payload.get("status", ""))
                mark_word(word_id, status)
                self._send_json(200, {"ok": True})
                return
            if path == "/api/update-meaning":
                word_id = int(payload["word_id"])
                update_word_meaning(word_id, str(payload.get("meaning", "")))
                self._send_json(200, {"ok": True})
                return
            if path == "/api/reset-progress":
                word_ids = [int(x) for x in payload.get("word_ids", [])]
                reset_progress(word_ids)
                self._send_json(200, {"ok": True})
                return
            if path == "/api/delete-book":
                book_id = int(payload["book_id"])
                delete_book(book_id)
                self._send_json(200, {"ok": True})
                return
            if path == "/api/rename-book":
                book_id = int(payload["book_id"])
                rename_book(book_id, str(payload.get("name", "")))
                self._send_json(200, {"ok": True})
                return
            if path == "/api/export-pdf":
                book_id = int(payload["book_id"])
                unit_ids = [int(x) for x in payload.get("unit_ids", []) if str(x).isdigit()]
                mode = payload.get("mode", "all")
                try:
                    count = max(1, int(payload.get("count", 20)))
                except (TypeError, ValueError):
                    count = 20
                cards = fetch_cards(book_id, unit_ids or None, shuffle=False)
                if not cards:
                    self._send_json(400, {"error": "所选范围没有可导出的单词"})
                    return
                label = ""
                if mode == "total":
                    count = min(count, len(cards))
                    selected = random.sample(cards, count)
                    label = f"共抽查 {count} 个"
                elif mode == "per_unit":
                    selected = []
                    by_unit: dict[str, list[dict]] = {}
                    for card in cards:
                        by_unit.setdefault(card["unit_name"], []).append(card)
                    for name, group in by_unit.items():
                        n = min(count, len(group))
                        selected.extend(random.sample(group, n))
                    label = f"每单元抽查 {count} 个"
                else:
                    selected = cards
                    label = f"全部 {len(cards)} 个"
                pdf = build_pdf(
                    book_name=payload.get("book_name") or "单词抽查",
                    unit_names=sorted({card["unit_name"] for card in selected}),
                    records=selected,
                    count_label=label,
                    blank_mode=bool(payload.get("blank_mode", True)),
                )
                self._send_bytes(
                    200,
                    pdf,
                    "application/pdf",
                )
                return
            self._send_json(404, {"error": "接口不存在"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": str(exc) or "服务内部错误"})


def find_free_port(preferred: int = 8000) -> int:
    import socket
    for port in range(preferred, preferred + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    # Fall back to an OS-assigned local port when the usual development range
    # is already occupied by another local service.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", 0))
        except OSError:
            return 0
        return int(sock.getsockname()[1])


def main() -> None:
    open_browser = "--no-browser" not in sys.argv
    init_db()
    port = find_free_port(8000)
    if not port:
        raise SystemExit("没有可用的本地端口")
    server = ThreadingHTTPServer(("127.0.0.1", port), VocabularyHandler)
    url = f"http://127.0.0.1:{port}"
    print(f"\n亦可速记已启动：{url}\n")
    if open_browser:
        def _open():
            try:
                webbrowser.open(url)
            except Exception:
                pass
        threading.Timer(0.6, _open).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
