# -*- coding: utf-8 -*-
"""
雅思打字练习 · 后端服务器
- 零依赖：仅使用 Python 标准库（http.server + sqlite3）
- 启动：python3 server.py（默认端口 8000，可用 python3 server.py 9000 改端口）
- 数据保存在同目录 data.db（SQLite）
"""
import csv
import datetime
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from contextlib import contextmanager
from http.cookies import SimpleCookie
from urllib.parse import urlparse, parse_qs

try:
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
except ImportError:
    # 兼容 Python 3.6（例如部分 Alibaba Cloud Linux 系统）
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DB = os.path.join(BASE, "data.db")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
SESSION_COOKIE = "typing_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
PBKDF2_ITERATIONS = 200000

# 登录/注册失败限流：同一 IP+账号在窗口内连续失败超过阈值即短暂锁定，缓解在线爆破。
LOGIN_FAIL_LIMIT = 6
LOGIN_FAIL_WINDOW = 10 * 60
LOGIN_LOCK_SECONDS = 10 * 60
_LOGIN_FAILS = {}

# 安全响应头：nosniff 防 MIME 嗅探，DENY 防被嵌套进 iframe。
SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "same-origin"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
)
# 页面无外部资源，脚本样式均为内联，故保留 'unsafe-inline'；
# 关键在于禁止外域脚本/数据外发，堵住 XSS 的载荷投递通道。
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline';"
       " style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
       " connect-src 'self'; form-action 'self'; frame-ancestors 'none';"
       " base-uri 'self'")

# 合法姓名的字符白名单：中文、字母、数字、空格与常见分隔符。
DISPLAY_NAME_RE = re.compile(r"^[一-龥A-Za-z0-9 .·_\-]{1,20}$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@contextmanager
def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS records(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            t INTEGER NOT NULL,
            student TEXT NOT NULL,
            label TEXT, material TEXT,
            wpm INTEGER, acc INTEGER, chars INTEGER, errs INTEGER, secs INTEGER,
            user_id INTEGER
        )""")
        columns = [r[1] for r in c.execute("PRAGMA table_info(records)").fetchall()]
        if "user_id" not in columns:
            c.execute("ALTER TABLE records ADD COLUMN user_id INTEGER")
        c.execute("CREATE INDEX IF NOT EXISTS idx_student ON records(student, t)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id, t)")
        # 一次性清理历史脏数据：正确字符数与 WPM 均为空/0 的空成绩
        c.execute("DELETE FROM records WHERE (wpm IS NULL OR wpm<=0) AND (chars IS NULL OR chars<=0)")
        c.execute("""CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            created_at INTEGER NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
        )""")
        # 允许同名学生：去掉 display_name 的 UNIQUE 约束（仅 username 唯一）。
        # SQLite 无法直接删除列约束，检测到旧约束则重建表迁移。
        _u = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
        _usql = (_u["sql"] if _u else "") or ""
        if re.search(r"display_name[^,)]*UNIQUE", _usql):
            c.execute("ALTER TABLE users RENAME TO users_old")
            c.execute("""CREATE TABLE users(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'student',
                created_at INTEGER NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0
            )""")
            c.execute("INSERT INTO users(id,username,display_name,password_hash,role,created_at,disabled) "
                      "SELECT id,username,display_name,password_hash,role,created_at,disabled FROM users_old")
            c.execute("DROP TABLE users_old")
        ucols = [r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
        if "disabled" not in ucols:
            c.execute("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")
        c.execute("""CREATE TABLE IF NOT EXISTS sessions(
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")
        c.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
        # 生词本：随账号同步，避免换设备/清缓存后收藏丢失。
        c.execute("""CREATE TABLE IF NOT EXISTS favorites(
            user_id INTEGER NOT NULL,
            word TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(user_id, word)
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id)")
        migrate_display_name_unique(c)


def migrate_display_name_unique(c):
    """允许同名学生：去掉 users.display_name 的 UNIQUE 约束。

    SQLite 不支持 DROP CONSTRAINT，只能通过建新表 + 复制数据 + 改名完成。
    允许同名后，姓名不再唯一标识一个人，因此成绩展示需同时展示账号。
    """
    row = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
    sql = row[0] if row else ""
    if not sql or "display_name TEXT NOT NULL UNIQUE" not in sql:
        return
    c.execute("""CREATE TABLE users_new(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        created_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
    )""")
    c.execute("""INSERT INTO users_new(id,username,display_name,password_hash,role,created_at,disabled)
                 SELECT id,username,display_name,password_hash,role,created_at,disabled FROM users""")
    c.execute("DROP TABLE users")
    c.execute("ALTER TABLE users_new RENAME TO users")


# ---------------- 用户、密码与会话 ----------------

def public_user(row):
    return {
        "id": row["id"], "username": row["username"],
        "display_name": row["display_name"], "role": row["role"],
        "disabled": bool(row["disabled"])
    }


def validate_account(username, password, display_name):
    if not isinstance(username, str) or not re.match(r"^[A-Za-z0-9_.-]{3,20}$", username):
        raise ApiError("账号需为 3～20 位字母、数字、点、下划线或短横线")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ApiError("密码长度需为 8～128 位")
    # 姓名会渲染到教师后台，必须限制字符集，杜绝引号/尖括号等可用于注入的字符。
    if not isinstance(display_name, str) or not DISPLAY_NAME_RE.match(display_name.strip()):
        raise ApiError("姓名需为 1～20 位中文、字母、数字、空格或 . · _ -，不能含引号等符号")


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITERATIONS, salt, digest)


def verify_password(password, stored):
    try:
        algorithm, iterations, salt, expected = stored.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations)
        ).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, AttributeError):
        return False


# ---------------- 失败限流 ----------------

def _rate_key(ip, username):
    return "%s|%s" % (ip or "?", (username or "").strip().lower())


def check_rate(ip, username):
    key = _rate_key(ip, username)
    now = time.time()
    entry = _LOGIN_FAILS.get(key)
    if entry and now < entry["until"]:
        mins = max(1, int((entry["until"] - now + 59) // 60))
        raise ApiError("尝试次数过多，请约 %d 分钟后再试" % mins, 429)
    return key


def note_rate_fail(key):
    now = time.time()
    # 顺带清理过期条目，避免字典无限增长。
    for k in [k for k, v in _LOGIN_FAILS.items() if v["until"] and v["until"] <= now]:
        _LOGIN_FAILS.pop(k, None)
    entry = _LOGIN_FAILS.get(key) or {"count": 0, "until": 0}
    entry["count"] += 1
    if entry["count"] >= LOGIN_FAIL_LIMIT:
        entry["until"] = now + LOGIN_LOCK_SECONDS
    _LOGIN_FAILS[key] = entry


def clear_rate(key):
    _LOGIN_FAILS.pop(key, None)


def token_digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    with db() as c:
        c.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
        c.execute(
            "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
            (token_digest(token), user_id, int(time.time()) + SESSION_SECONDS))
    return token


def session_cookie(token):
    return "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
        SESSION_COOKIE, token, SESSION_SECONDS)


def clear_session_cookie():
    return "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % SESSION_COOKIE


def user_for_token(token):
    if not token:
        return None
    with db() as c:
        row = c.execute("""SELECT u.* FROM sessions s
                           JOIN users u ON u.id=s.user_id
                           WHERE s.token_hash=? AND s.expires_at>?""",
                        (token_digest(token), int(time.time()))).fetchone()
    return row


def register_student(body, ip=None):
    username = body.get("username", "").strip() if isinstance(body.get("username"), str) else ""
    display_name = body.get("display_name", "").strip() if isinstance(body.get("display_name"), str) else ""
    password = body.get("password")
    validate_account(username, password, display_name)
    key = check_rate(ip, username)
    try:
        with db() as c:
            # 允许同名学生注册；但只要该姓名已有账号，就不再自动继承历史成绩，
            # 否则第二个「李华」会把第一个「李华」的记录据为己有。
            row = c.execute("SELECT id FROM users WHERE display_name=? COLLATE NOCASE",
                            (display_name,)).fetchone()
            inherit = not row
            cur = c.execute(
                "INSERT INTO users(username,display_name,password_hash,role,created_at)"
                " VALUES(?,?,?,'student',?)",
                (username, display_name, hash_password(password), int(time.time())))
            user_id = cur.lastrowid
            # 仅当该姓名此前没有账号时，才继承尚未关联到任何账号的历史成绩。
            linked = 0
            if inherit:
                linked = c.execute(
                    "UPDATE records SET user_id=? WHERE student=? AND user_id IS NULL",
                    (user_id, display_name)).rowcount
    except sqlite3.IntegrityError:
        raise ApiError("账号已被使用", 409)
    clear_rate(key)
    with db() as c:
        user = c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return user, create_session(user_id), linked


def login_user(body, ip=None):
    username = body.get("username", "").strip() if isinstance(body.get("username"), str) else ""
    password = body.get("password")
    if not isinstance(password, str):
        raise ApiError("账号或密码错误", 401)
    key = check_rate(ip, username)
    with db() as c:
        user = c.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE",
                         (username,)).fetchone()
    if not user or not verify_password(password, user["password_hash"]):
        note_rate_fail(key)
        raise ApiError("账号或密码错误", 401)
    if user["disabled"]:
        raise ApiError("该账号已被禁用，请联系老师", 403)
    clear_rate(key)
    return user, create_session(user["id"])


def create_teacher(username, password, display_name="教师"):
    """供服务器管理员初始化或重置教师账号，不开放网络注册教师。"""
    validate_account(username, password, display_name)
    with db() as c:
        row = c.execute("SELECT id FROM users WHERE username=? COLLATE NOCASE",
                        (username,)).fetchone()
        if row:
            c.execute("UPDATE users SET password_hash=?,role='teacher',display_name=?"
                      " WHERE id=?", (hash_password(password), display_name, row["id"]))
            user_id = row["id"]
        else:
            cur = c.execute(
                "INSERT INTO users(username,display_name,password_hash,role,created_at)"
                " VALUES(?,?,?,'teacher',?)",
                (username, display_name, hash_password(password), int(time.time())))
            user_id = cur.lastrowid
        c.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    return user_id


# ---------------- 管理员 API ----------------

def admin_only(user):
    if not user or user["role"] != "teacher":
        raise ApiError("仅教师可执行此操作", 403)


def admin_students(user):
    admin_only(user)
    with db() as c:
        rows = c.execute("""
            SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at,
                   (SELECT COUNT(*) FROM records r WHERE r.user_id=u.id) AS cnt,
                   (SELECT MAX(r.t) FROM records r WHERE r.user_id=u.id) AS last_t
            FROM users u WHERE u.role='student' ORDER BY u.created_at DESC
        """).fetchall()
    return {"students": [{
        "id": r["id"], "username": r["username"], "display_name": r["display_name"],
        "disabled": bool(r["disabled"]), "created_at": r["created_at"],
        "record_count": r["cnt"] or 0, "last_t": r["last_t"]
    } for r in rows]}


def admin_create_student(user, body):
    admin_only(user)
    username = body.get("username", "").strip() if isinstance(body.get("username"), str) else ""
    display_name = body.get("display_name", "").strip() if isinstance(body.get("display_name"), str) else ""
    password = body.get("password")
    validate_account(username, password, display_name)
    try:
        with db() as c:
            row = c.execute("SELECT id FROM users WHERE display_name=? COLLATE NOCASE",
                            (display_name,)).fetchone()
            inherit = not row
            cur = c.execute(
                "INSERT INTO users(username,display_name,password_hash,role,created_at,disabled)"
                " VALUES(?,?,?,'student',?,0)",
                (username, display_name, hash_password(password), int(time.time())))
            user_id = cur.lastrowid
            linked = 0
            if inherit:
                linked = c.execute(
                    "UPDATE records SET user_id=? WHERE student=? AND user_id IS NULL",
                    (user_id, display_name)).rowcount
    except sqlite3.IntegrityError:
        raise ApiError("账号已被使用", 409)
    return {"ok": True, "id": user_id, "linked_records": linked}


def admin_reset_password(user, student_id, body):
    admin_only(user)
    password = body.get("password")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ApiError("密码长度需为 8～128 位")
    with db() as c:
        target = c.execute("SELECT id,role FROM users WHERE id=?", (student_id,)).fetchone()
        if not target:
            raise ApiError("学生不存在", 404)
        if target["role"] != "student":
            raise ApiError("仅可重置学生账号密码", 400)
        c.execute("UPDATE users SET password_hash=? WHERE id=?",
                  (hash_password(password), student_id))
        c.execute("DELETE FROM sessions WHERE user_id=?", (student_id,))
    return {"ok": True}


def admin_set_disabled(user, student_id, body):
    admin_only(user)
    disabled = 1 if body.get("disabled") is True else 0
    with db() as c:
        target = c.execute("SELECT id,role FROM users WHERE id=?", (student_id,)).fetchone()
        if not target:
            raise ApiError("学生不存在", 404)
        if target["role"] != "student":
            raise ApiError("仅可修改学生账号", 400)
        c.execute("UPDATE users SET disabled=? WHERE id=?", (disabled, student_id))
        if disabled:
            c.execute("DELETE FROM sessions WHERE user_id=?", (student_id,))
    return {"ok": True}


def admin_export_records(user):
    admin_only(user)
    with db() as c:
        rows = c.execute("""
            SELECT student,label,material,wpm,acc,chars,errs,secs,t
            FROM records ORDER BY t DESC
        """).fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["学生", "模式", "素材", "WPM", "准确率", "正确字符", "错误", "用时秒", "时间"])
    for r in rows:
        dt = ""
        try:
            ts = int(r["t"])
            dt = datetime.datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts).strftime("%Y-%m-%d %H:%M:%S")
        except (TypeError, ValueError, OSError):
            dt = str(r["t"])
        writer.writerow([r["student"], r["label"], r["material"], r["wpm"], r["acc"],
                         r["chars"], r["errs"], r["secs"], dt])
    return buf.getvalue()


# ---------------- 成绩 API ----------------

def api_records(params, user):
    try:
        limit = min(max(int((params.get("limit") or ["200"])[0]), 1), 1000)
    except (TypeError, ValueError):
        limit = 200
    scope = (params.get("scope") or ["mine"])[0]
    if scope not in ("mine", "class"):
        raise ApiError("成绩查询范围无效")
    with db() as c:
        if scope == "class":
            admin_only(user)
            rows = c.execute(
                "SELECT r.*, u.username FROM records r JOIN users u ON u.id=r.user_id"
                " WHERE u.role='student' ORDER BY r.t DESC, r.id DESC LIMIT ?",
                (limit,)).fetchall()
            return {"records": [dict(r) for r in rows]}
        account = (user["id"],)
        c.execute("BEGIN")
        stats = c.execute(
            "SELECT COUNT(*) AS total, MAX(wpm) AS best, AVG(wpm) AS avg_wpm, AVG(acc) AS avg_acc"
            " FROM records WHERE user_id=?", account).fetchone()
        rows = c.execute(
            "SELECT * FROM records WHERE user_id=? ORDER BY t DESC, id DESC LIMIT ?",
            account + (limit,)).fetchall()
    return {"records": [dict(r) for r in rows], "stats": dict(stats)}


def api_summary(user):
    if user["role"] != "teacher":
        raise ApiError("仅教师可查看全班记录", 403)
    with db() as c:
        rows = c.execute("""
            SELECT u.username, u.display_name,
                   COUNT(r.id) AS cnt,
                   MAX(r.wpm) AS best,
                   CAST(AVG(r.wpm) AS INT) AS avg_wpm,
                   CAST(AVG(r.acc) AS INT) AS avg_acc,
                   MAX(r.t) AS last_t,
                   (SELECT CAST(ROUND(r2.chars / 5.0) AS INTEGER)
                    FROM records r2
                    WHERE r2.user_id=r.user_id
                    ORDER BY r2.t DESC, r2.id DESC LIMIT 1) AS last_words
            FROM records r JOIN users u ON u.id=r.user_id
            WHERE u.role='student'
            GROUP BY r.user_id ORDER BY avg_wpm DESC, u.id
        """).fetchall()
    return {"students": [dict(r) for r in rows]}


def handle_post_records(body, user):
    for k in ("label", "material"):
        if not isinstance(body.get(k), str):
            body[k] = ""
    nums = {}
    for k in ("t", "wpm", "acc", "chars", "errs", "secs"):
        try:
            nums[k] = int(body.get(k, 0))
        except (TypeError, ValueError):
            nums[k] = 0
    # 服务端校验：拒绝空成绩（正确字符数或 WPM 为 0），防止脏数据入库
    if nums["chars"] <= 0 or nums["wpm"] <= 0:
        raise ApiError("成绩无效：正确字符数与 WPM 必须大于 0，未保存", 400)
    with db() as c:
        c.execute(
            "INSERT INTO records(t,student,label,material,wpm,acc,chars,errs,secs,user_id)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (nums["t"], user["display_name"], body["label"][:80], body["material"][:120],
             nums["wpm"], nums["acc"], nums["chars"], nums["errs"], nums["secs"], user["id"]))
    return {"ok": True}


def handle_delete(params, user):
    if params:
        raise ApiError("此接口只允许清空当前账号的成绩")
    with db() as c:
        deleted = c.execute("DELETE FROM records WHERE user_id=?", (user["id"],)).rowcount
    return {"ok": True, "deleted": deleted}


# ---------------- 生词本 API ----------------

def api_favs_list(user):
    with db() as c:
        rows = c.execute(
            "SELECT word FROM favorites WHERE user_id=? ORDER BY created_at DESC, word",
            (user["id"],)).fetchall()
    return {"favs": [r["word"] for r in rows]}


def api_favs_update(user, body):
    if body.get("clear") is True:
        with db() as c:
            c.execute("DELETE FROM favorites WHERE user_id=?", (user["id"],))
        return {"ok": True}
    word = (body.get("word") or "").strip() if isinstance(body.get("word"), str) else ""
    if not word or len(word) > 64:
        raise ApiError("单词格式无效", 400)
    with db() as c:
        exists = c.execute("SELECT 1 FROM favorites WHERE user_id=? AND word=?",
                           (user["id"], word)).fetchone()
        if body.get("remove") is True:
            c.execute("DELETE FROM favorites WHERE user_id=? AND word=?", (user["id"], word))
        elif body.get("add") is True or not exists:
            c.execute("INSERT OR IGNORE INTO favorites(user_id,word,created_at) VALUES(?,?,?)",
                      (user["id"], word, int(time.time())))
        else:
            c.execute("DELETE FROM favorites WHERE user_id=? AND word=?", (user["id"], word))
    return {"ok": True}


def accepts_gzip(header):
    qualities = {}
    for entry in header.lower().split(","):
        coding, *options = entry.strip().split(";")
        quality = 1.0
        for option in options:
            key, _, value = option.strip().partition("=")
            if key.strip() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        qualities[coding.strip()] = quality if 0 <= quality <= 1 else 0.0
    return qualities.get("gzip", qualities.get("*", 0.0)) > 0


class Handler(BaseHTTPRequestHandler):
    homepage_gzip = None

    def log_message(self, fmt, *args):
        # 仅记录 API 请求，静态文件访问日志会带来无意义的 I/O 开销。
        if getattr(self, "path", "").startswith("/api/"):
            print("[%s] %s" % (self.address_string(), fmt % args))

    def send_json(self, obj, code=200, cookie=None):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def send_csv(self, text, filename):
        data = ("\ufeff" + text).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        compressible = os.path.abspath(path) == os.path.join(PUBLIC, "index.html")
        use_gzip = compressible and accepts_gzip(self.headers.get("Accept-Encoding", ""))
        try:
            with open(path, "rb") as f:
                st = os.fstat(f.fileno())
                version = (path, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
                etag = 'W/"%x-%x-%x-%x-%s"' % (st.st_ino, st.st_mtime_ns,
                    st.st_ctime_ns, st.st_size, "gzip" if use_gzip else "identity")
                tags = self.headers.get("If-None-Match", "").split(",")
                unchanged = any(tag in ("*", etag, etag[2:]) for tag in map(str.strip, tags))
                data = None
                length = st.st_size
                if not unchanged:
                    if use_gzip:
                        cached = Handler.homepage_gzip
                        if cached is None or cached[0] != version:
                            cached = (version, gzip.compress(f.read(), compresslevel=6))
                            Handler.homepage_gzip = cached
                        data = cached[1]
                        length = len(data)
                    elif self.command != "HEAD":
                        data = f.read()
                        length = len(data)
        except OSError:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(304 if unchanged else 200)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        if compressible:
            self.send_header("Vary", "Accept-Encoding")
        if not unchanged:
            self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", str(length))
            if use_gzip:
                self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        if not unchanged and self.command != "HEAD":
            self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 16384:
            raise ApiError("请求内容过大", 413)
        body = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(body, dict):
            raise ApiError("请求格式错误")
        return body

    def current_user(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return user_for_token(morsel.value if morsel else None)

    def require_user(self):
        user = self.current_user()
        if not user:
            raise ApiError("请先登录", 401)
        return user

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            params = parse_qs(parsed.query)
            try:
                if path == "/api/auth/me":
                    user = self.current_user()
                    return self.send_json({"user": public_user(user) if user else None})
                if path == "/api/records":
                    return self.send_json(api_records(params, self.require_user()))
                if path == "/api/favs":
                    return self.send_json(api_favs_list(self.require_user()))
                if path == "/api/summary":
                    return self.send_json(api_summary(self.require_user()))
                if path == "/api/admin/students":
                    return self.send_json(admin_students(self.require_user()))
                if path == "/api/admin/export":
                    return self.send_csv(admin_export_records(self.require_user()), "typing-records.csv")
                return self.send_json({"error": "not found"}, 404)
            except ApiError as e:
                return self.send_json({"error": str(e)}, e.status)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        return self.serve_static(path)

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_response(405)
            self.send_header("Allow", "GET, POST, DELETE")
            self.end_headers()
            return
        return self.serve_static(path)

    def serve_static(self, path):
        if path == "/":
            return self.send_file(os.path.join(PUBLIC, "index.html"))
        public_root = os.path.realpath(PUBLIC)
        fs_path = os.path.realpath(os.path.join(public_root, path.lstrip("/")))
        if fs_path.startswith(public_root + os.sep) and os.path.isfile(fs_path):
            return self.send_file(fs_path)
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/auth/register":
                user, token, linked = register_student(self.read_json())
                return self.send_json({"user": public_user(user), "linked_records": linked},
                                      cookie=session_cookie(token))
            if path == "/api/auth/login":
                user, token = login_user(self.read_json())
                return self.send_json({"user": public_user(user)}, cookie=session_cookie(token))
            if path == "/api/auth/logout":
                cookie = SimpleCookie()
                cookie.load(self.headers.get("Cookie", ""))
                morsel = cookie.get(SESSION_COOKIE)
                if morsel:
                    with db() as c:
                        c.execute("DELETE FROM sessions WHERE token_hash=?",
                                  (token_digest(morsel.value),))
                return self.send_json({"ok": True}, cookie=clear_session_cookie())
            if path == "/api/records":
                return self.send_json(handle_post_records(self.read_json(), self.require_user()))
            if path == "/api/favs":
                return self.send_json(api_favs_update(self.require_user(), self.read_json()))
            if path == "/api/admin/students":
                return self.send_json(admin_create_student(self.require_user(), self.read_json()))
            if path.startswith("/api/admin/students/"):
                parts = path.split("/")
                if len(parts) == 6 and parts[5] == "password":
                    return self.send_json(
                        admin_reset_password(self.require_user(), int(parts[4]), self.read_json()))
                if len(parts) == 6 and parts[5] == "toggle":
                    return self.send_json(
                        admin_set_disabled(self.require_user(), int(parts[4]), self.read_json()))
            return self.send_json({"error": "not found"}, 404)
        except ApiError as e:
            return self.send_json({"error": str(e)}, e.status)
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": "请求格式错误"}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/records":
            return self.send_json({"error": "not found"}, 404)
        try:
            return self.send_json(handle_delete(parse_qs(parsed.query), self.require_user()))
        except ApiError as e:
            return self.send_json({"error": str(e)}, e.status)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("=" * 46)
    print("  雅思打字练习服务器已启动")
    print("  本机访问:  http://localhost:%d" % PORT)
    print("  局域网访问（学生用）: http://<本机IP>:%d" % PORT)
    print("  停止服务: 在此窗口按 Control + C")
    print("  数据文件: %s" % DB)
    print("=" * 46)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")


if __name__ == "__main__":
    main()
