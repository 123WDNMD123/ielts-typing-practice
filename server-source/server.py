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
# 页面资源全部同源（v2.0 起脚本样式拆为同源外链文件，仍无第三方域）。
# 保留 'unsafe-inline' 以兼容首屏防闪烁内联脚本与少量内联样式；
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
    ".woff2": "font/woff2",
}

# 可压缩的文本型静态资源。v2.0 前端拆多文件后按扩展名判定，
# 不再硬编码 index.html（否则 app.js / data.js 等不压缩，首屏传输量翻数倍）。
GZIP_EXTS = {".html", ".js", ".css", ".json", ".svg"}


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
        # F4 间隔重复：给生词本加复习调度字段（简化 SM-2）。
        # 旧数据平滑迁移：新列默认 due_at=0 => 全部立即到期，首次进入复习即可开始排程。
        fcols = [r[1] for r in c.execute("PRAGMA table_info(favorites)").fetchall()]
        for col, ddl in (
            ("ease", "ALTER TABLE favorites ADD COLUMN ease REAL NOT NULL DEFAULT 2.5"),
            ("interval", "ALTER TABLE favorites ADD COLUMN interval REAL NOT NULL DEFAULT 0"),
            ("reps", "ALTER TABLE favorites ADD COLUMN reps INTEGER NOT NULL DEFAULT 0"),
            ("lapses", "ALTER TABLE favorites ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0"),
            ("due_at", "ALTER TABLE favorites ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0"),
            ("last_review", "ALTER TABLE favorites ADD COLUMN last_review INTEGER NOT NULL DEFAULT 0"),
            # v2.3 错词回流：origin 区分「手动收藏」与「打错自动收录」。
            # 默认 manual ⇒ 旧数据语义不变（历史上生词本只有手动收藏一种来源）。
            ("origin", "ALTER TABLE favorites ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'"),
            # 累计打错次数。只增不减，作为「这个词反复出错」的证据，
            # 不参与 SM-2 调度计算（调度仍由自评四档驱动）。
            ("mistypes", "ALTER TABLE favorites ADD COLUMN mistypes INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in fcols:
                c.execute(ddl)
        c.execute("CREATE INDEX IF NOT EXISTS idx_fav_due ON favorites(user_id, due_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_fav_origin ON favorites(user_id, origin)")
        # F2 错键热力图：按「应打字符」累计错误次数与总敲击次数，用于算错误率。
        # 只存单字符（含空格），不做任何文本内容留存。
        c.execute("""CREATE TABLE IF NOT EXISTS keyerrors(
            user_id INTEGER NOT NULL,
            ch TEXT NOT NULL,
            errs INTEGER NOT NULL DEFAULT 0,
            hits INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(user_id, ch)
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_keyerr_user ON keyerrors(user_id)")
        # 个性化偏好：随账号同步（主题色/深浅/动效/音效/目标等），本机缓存仅用于首屏防闪烁。
        c.execute("""CREATE TABLE IF NOT EXISTS prefs(
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(user_id, key)
        )""")
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
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"]
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


# ---------------- 账号自助管理 ----------------

def update_profile(user, body):
    """修改自己的昵称（成绩展示名）。账号 username 是身份标识，不可修改。"""
    display_name = body.get("display_name", "").strip() if isinstance(body.get("display_name"), str) else ""
    if not DISPLAY_NAME_RE.match(display_name):
        raise ApiError("姓名需为 1～20 位中文、字母、数字、空格或 . · _ -，不能含引号等符号")
    with db() as c:
        c.execute("UPDATE users SET display_name=? WHERE id=?", (display_name, user["id"]))
        # 成绩表冗余了展示名（导出/全班视图使用），同步刷新，历史成绩本身不受影响。
        c.execute("UPDATE records SET student=? WHERE user_id=?", (display_name, user["id"]))
        row = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    return {"ok": True, "user": public_user(row)}


def change_password(user, body, ip=None):
    """修改自己的密码：必须验旧密码；成功后保留当前会话、踢掉其他设备会话。"""
    old = body.get("old_password")
    new = body.get("new_password")
    confirm = body.get("confirm_password")
    if not isinstance(old, str) or not isinstance(new, str):
        raise ApiError("请求格式错误")
    key = check_rate(ip, user["username"])
    if not verify_password(old, user["password_hash"]):
        note_rate_fail(key)
        raise ApiError("当前密码不正确", 401)
    if not 8 <= len(new) <= 128:
        raise ApiError("密码长度需为 8～128 位")
    if new == old:
        raise ApiError("新密码不能与当前密码相同")
    if isinstance(confirm, str) and confirm != new:
        raise ApiError("两次输入的新密码不一致")
    with db() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    clear_rate(key)
    # 当前浏览器换发新会话，其他设备需重新登录。
    return {"ok": True}, create_session(user["id"])


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


# ---------------- F4 间隔重复（简化 SM-2） ----------------

# 质量分：0=忘了 1=模糊 2=记得。映射到 SM-2 的 q(0..5)。
SRS_QUALITY = {"again": 0, "hard": 3, "good": 4, "easy": 5}


def srs_next(ease, interval, reps, lapses, quality, now):
    """返回 (ease, interval, reps, lapses, due_at)。interval 单位：天。

    简化 SM-2：
      - again(q<3)：reps 归零、lapses+1、ease 下调 0.2、10 分钟后再见（当日重现）
      - hard/good/easy：首次 1 天、第二次 3 天（easy 直接 4 天），其后 interval*ease
      - ease 下限 1.3、上限 3.2；interval 上限 365 天
    """
    q = SRS_QUALITY.get(quality, 4)
    ease = float(ease or 2.5)
    interval = float(interval or 0)
    reps = int(reps or 0)
    lapses = int(lapses or 0)
    if q < 3:
        reps = 0
        lapses += 1
        ease = max(1.3, ease - 0.2)
        return ease, 0.0, reps, lapses, now + 600  # 10 分钟后重现
    # 正常推进
    if reps == 0:
        interval = 4.0 if q == 5 else 1.0
    elif reps == 1:
        interval = 6.0 if q == 5 else 3.0
    else:
        mult = ease * (1.15 if q == 5 else (0.8 if q == 3 else 1.0))
        interval = max(1.0, interval * mult)
    reps += 1
    # ease 调整（SM-2 公式的简化版）
    ease = ease + (0.1 if q == 5 else (-0.15 if q == 3 else 0.0))
    ease = min(3.2, max(1.3, ease))
    interval = min(365.0, interval)
    return ease, interval, reps, lapses, now + int(interval * 86400)


def api_srs_get(user):
    """返回全部生词的调度状态 + 到期数量。"""
    now = int(time.time())
    with db() as c:
        rows = c.execute(
            "SELECT word, ease, interval, reps, lapses, due_at, last_review, origin, mistypes "
            "FROM favorites WHERE user_id=? ORDER BY due_at, word", (user["id"],)).fetchall()
    items = [{"word": r["word"], "ease": round(r["ease"], 3), "interval": round(r["interval"], 3),
              "reps": r["reps"], "lapses": r["lapses"], "due_at": r["due_at"],
              "last_review": r["last_review"], "origin": r["origin"],
              "mistypes": r["mistypes"]} for r in rows]
    due = [x["word"] for x in items if x["due_at"] <= now]
    return {"items": items, "due": due, "dueCount": len(due), "total": len(items), "now": now}


def api_srs_review(user, body):
    """提交一次复习结果，更新该词调度。"""
    word = (body.get("word") or "").strip() if isinstance(body.get("word"), str) else ""
    quality = body.get("quality")
    if not word or len(word) > 64:
        raise ApiError("单词格式无效", 400)
    if quality not in SRS_QUALITY:
        raise ApiError("复习评价无效", 400)
    now = int(time.time())
    with db() as c:
        row = c.execute("SELECT ease, interval, reps, lapses FROM favorites "
                        "WHERE user_id=? AND word=?", (user["id"], word)).fetchone()
        if not row:
            raise ApiError("该词不在生词本中", 404)
        ease, interval, reps, lapses, due = srs_next(
            row["ease"], row["interval"], row["reps"], row["lapses"], quality, now)
        c.execute("UPDATE favorites SET ease=?, interval=?, reps=?, lapses=?, due_at=?, last_review=? "
                  "WHERE user_id=? AND word=?",
                  (ease, interval, reps, lapses, due, now, user["id"], word))
    return {"ok": True, "word": word, "ease": round(ease, 3), "interval": round(interval, 3),
            "reps": reps, "lapses": lapses, "due_at": due}


def api_srs_reset(user, body):
    """重置某词（或全部）的复习进度，使其立即到期。"""
    now = int(time.time())
    word = (body.get("word") or "").strip() if isinstance(body.get("word"), str) else ""
    with db() as c:
        if body.get("all") is True:
            c.execute("UPDATE favorites SET ease=2.5, interval=0, reps=0, lapses=0, due_at=0, last_review=0 "
                      "WHERE user_id=?", (user["id"],))
        elif word:
            c.execute("UPDATE favorites SET ease=2.5, interval=0, reps=0, lapses=0, due_at=0, last_review=0 "
                      "WHERE user_id=? AND word=?", (user["id"], word))
        else:
            raise ApiError("缺少单词", 400)
    return {"ok": True}


# ---------------- F2 错键热力图 ----------------

def api_keyerrors_get(user):
    now = int(time.time())
    with db() as c:
        rows = c.execute("SELECT ch, errs, hits, updated_at FROM keyerrors WHERE user_id=? "
                         "ORDER BY errs DESC, ch", (user["id"],)).fetchall()
    items = []
    for r in rows:
        hits = int(r["hits"] or 0)
        errs = int(r["errs"] or 0)
        items.append({"ch": r["ch"], "errs": errs, "hits": hits,
                      "rate": round(errs / hits, 4) if hits > 0 else 0.0,
                      "updated_at": r["updated_at"]})
    return {"items": items, "totalErrs": sum(x["errs"] for x in items),
            "totalHits": sum(x["hits"] for x in items), "now": now}


def api_keyerrors_put(user, body):
    """批量累计敲击统计。body: {keys: [{ch, errs, hits}, ...]}

    只接受单字符（含空格），单次最多 128 项，数值上限防脏数据。
    """
    keys = body.get("keys")
    if not isinstance(keys, list) or not keys:
        raise ApiError("缺少按键统计", 400)
    if len(keys) > 128:
        raise ApiError("单次上报过多", 400)
    now = int(time.time())
    clean = []
    for k in keys:
        if not isinstance(k, dict):
            continue
        ch = k.get("ch")
        if not isinstance(ch, str) or len(ch) != 1:
            continue
        # 只存可打印 ASCII（打字素材范围），拒绝控制字符与换行
        if not (0x20 <= ord(ch) <= 0x7E):
            continue
        try:
            errs = max(0, min(100000, int(k.get("errs") or 0)))
            hits = max(0, min(100000, int(k.get("hits") or 0)))
        except (TypeError, ValueError):
            continue
        if errs == 0 and hits == 0:
            continue
        clean.append((ch, errs, hits))
    if not clean:
        raise ApiError("按键统计无效", 400)
    with db() as c:
        for ch, errs, hits in clean:
            c.execute(
                "INSERT INTO keyerrors(user_id,ch,errs,hits,updated_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(user_id,ch) DO UPDATE SET "
                "errs=errs+excluded.errs, hits=hits+excluded.hits, updated_at=excluded.updated_at",
                (user["id"], ch, errs, hits, now))
    return {"ok": True, "accepted": len(clean)}


def api_keyerrors_reset(user):
    with db() as c:
        c.execute("DELETE FROM keyerrors WHERE user_id=?", (user["id"],))
    return {"ok": True}


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


# ---------------- 错词回流 API（v2.3） ----------------

# 词长上限与既有收藏接口一致；单次批量上限与错键上报的 128 项保持同一量级。
FAV_MAX_WORD = 64
MISTAKE_MAX_ITEMS = 64
MISTAKE_MAX_COUNT = 10000


def api_favs_mistakes(user, body):
    """把练习中打错的词收进生词本，立即到期以便次日复习。

    两条硬规则：
      1. 新词才插入，origin='mistyped'、due_at=0（立即到期）。
      2. 已在生词本里的词**只累加 mistypes**，绝不改动 ease/interval/reps/due_at——
         用户可能已经复习过这个词，调度状态是他自己的学习进度，
         不能因为又打错一次就被重置回起点。
         origin 保持原值：手动收藏过的词不会因为打错而降级成 mistyped。
    """
    items = body.get("words")
    if not isinstance(items, list):
        raise ApiError("words 必须是数组", 400)
    if len(items) > MISTAKE_MAX_ITEMS:
        raise ApiError("单次最多上报 %d 个词" % MISTAKE_MAX_ITEMS, 400)

    # 先在内存里归并同一批次的重复词，避免同一次练习里同一个词出现两次
    # 导致两次 INSERT OR IGNORE 之间读不到刚插入的行。
    merged = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        word = it.get("word")
        if not isinstance(word, str):
            continue
        word = word.strip()
        if not word or len(word) > FAV_MAX_WORD:
            continue
        try:
            n = int(it.get("mistakes") or 1)
        except (TypeError, ValueError):
            n = 1
        n = max(1, min(n, MISTAKE_MAX_COUNT))
        merged[word] = merged.get(word, 0) + n
    if not merged:
        return {"ok": True, "added": 0, "updated": 0}

    now = int(time.time())
    added = updated = 0
    with db() as c:
        for word, n in merged.items():
            row = c.execute("SELECT mistypes FROM favorites WHERE user_id=? AND word=?",
                            (user["id"], word)).fetchone()
            if row:
                c.execute("UPDATE favorites SET mistypes = mistypes + ? WHERE user_id=? AND word=?",
                          (min(n, MISTAKE_MAX_COUNT), user["id"], word))
                updated += 1
            else:
                # due_at=0 ⇒ 立即可复习，与 F4 的旧数据迁移口径一致。
                c.execute(
                    "INSERT OR IGNORE INTO favorites"
                    "(user_id,word,created_at,due_at,origin,mistypes) VALUES(?,?,?,0,'mistyped',?)",
                    (user["id"], word, now, min(n, MISTAKE_MAX_COUNT)))
                added += 1
    return {"ok": True, "added": added, "updated": updated}


# ---------------- 个性化偏好 API（随账号同步） ----------------

# 白名单 + 取值校验：偏好只存展示/行为配置，不存敏感数据。
PREF_VALIDATORS = {
    "theme": lambda v: v == "" or v in ("light", "dark"),
    "accent": lambda v: v == "" or bool(re.fullmatch(r"#[0-9a-fA-F]{6}", v)),
    "motion": lambda v: v == "" or v in ("full", "lite", "off"),
    "sound": lambda v: v == "" or v in ("0", "1"),
    "soundStyle": lambda v: v == "" or v in ("soft", "mech", "typewriter"),
    "ignoreCase": lambda v: v == "" or v in ("0", "1"),
    "autoSpeak": lambda v: v == "" or v in ("0", "1"),
    "dailyGoal": lambda v: v == "" or (v.isdigit() and 50 <= int(v) <= 100000),
}


def api_prefs_get(user):
    with db() as c:
        rows = c.execute("SELECT key, value FROM prefs WHERE user_id=?", (user["id"],)).fetchall()
    return {"prefs": {r["key"]: r["value"] for r in rows}}


def api_prefs_put(user, body):
    items = body.get("prefs")
    if not isinstance(items, dict) or not items:
        raise ApiError("请求格式错误", 400)
    if len(items) > len(PREF_VALIDATORS):
        raise ApiError("偏好项过多", 400)
    cleaned = {}
    for k, v in items.items():
        if k not in PREF_VALIDATORS:
            raise ApiError("未知偏好项：" + str(k)[:32], 400)
        if not isinstance(v, str) or len(v) > 256:
            raise ApiError("偏好值格式错误", 400)
        if not PREF_VALIDATORS[k](v):
            raise ApiError("偏好值不合法：" + k, 400)
        cleaned[k] = v
    with db() as c:
        for k, v in cleaned.items():
            if v == "":
                # 空串 = 恢复默认：删除服务端行，其他设备下次同步回落到本机默认
                c.execute("DELETE FROM prefs WHERE user_id=? AND key=?", (user["id"], k))
            else:
                c.execute("INSERT INTO prefs(user_id,key,value) VALUES(?,?,?) "
                          "ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value",
                          (user["id"], k, v))
    return {"ok": True}


# ---------------- 打卡连续天数（≥100 正确字符/天，北京时间切日） ----------------

STREAK_THRESHOLD = 100
CN_OFFSET = 8 * 3600  # 服务器与用户口径统一按北京时间


def _cn_day(ts_ms):
    return (int(ts_ms) // 1000 + CN_OFFSET) // 86400


def api_streak(user):
    with db() as c:
        rows = c.execute(
            "SELECT t, chars FROM records WHERE user_id=? AND chars>0 ORDER BY t",
            (user["id"],)).fetchall()
    per_day = {}
    for r in rows:
        d = _cn_day(r["t"])
        per_day[d] = per_day.get(d, 0) + (r["chars"] or 0)
    today = _cn_day(int(time.time() * 1000))
    today_chars = per_day.get(today, 0)
    # 当前连续：从今天（未达标则从昨天）往回数达标日
    cur = 0
    d = today if today_chars >= STREAK_THRESHOLD else today - 1
    while per_day.get(d, 0) >= STREAK_THRESHOLD:
        cur += 1
        d -= 1
    # 历史最佳连续
    best = run = 0
    prev = None
    for day in sorted(k for k, v in per_day.items() if v >= STREAK_THRESHOLD):
        run = run + 1 if prev is not None and day == prev + 1 else 1
        best = max(best, run)
        prev = day
    return {"current": cur, "best": best, "today_chars": today_chars,
            "threshold": STREAK_THRESHOLD, "today_done": today_chars >= STREAK_THRESHOLD}


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
    # 静态文本 gzip 缓存：path -> (version, bytes)。
    # v2.0 起前端拆为多文件（index.html / tokens.css / app.css / data.js / motion.js / app.js），
    # 单槽缓存会让各文件互相踢掉缓存导致每次请求重压，故改为按路径分槽。
    static_gzip = {}
    # 兼容旧字段名（历史探针可能引用）
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
        # v2.0：前端拆多文件，压缩白名单改为按扩展名判定（原先硬编码只压 index.html）。
        # 注意 path 可能是 serve_static 解析过符号链的 realpath，故一律用 realpath 归一，
        # 否则 public 挂符号链做版本切换时路径比对失配、gzip 会静默失效。
        compressible = ext in GZIP_EXTS
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
                        cached = Handler.static_gzip.get(path)
                        if cached is None or cached[0] != version:
                            cached = (version, gzip.compress(f.read(), compresslevel=6))
                            Handler.static_gzip[path] = cached
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
                if path == "/api/prefs":
                    return self.send_json(api_prefs_get(self.require_user()))
                if path == "/api/srs":
                    return self.send_json(api_srs_get(self.require_user()))
                if path == "/api/keyerrors":
                    return self.send_json(api_keyerrors_get(self.require_user()))
                if path == "/api/streak":
                    return self.send_json(api_streak(self.require_user()))
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
            if path == "/api/auth/profile":
                return self.send_json(update_profile(self.require_user(), self.read_json()))
            if path == "/api/auth/password":
                result, token = change_password(self.require_user(), self.read_json(), self.client_address[0])
                return self.send_json(result, cookie=session_cookie(token))
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
            if path == "/api/favs/mistakes":
                return self.send_json(api_favs_mistakes(self.require_user(), self.read_json()))
            if path == "/api/prefs":
                return self.send_json(api_prefs_put(self.require_user(), self.read_json()))
            if path == "/api/srs/review":
                return self.send_json(api_srs_review(self.require_user(), self.read_json()))
            if path == "/api/srs/reset":
                return self.send_json(api_srs_reset(self.require_user(), self.read_json()))
            if path == "/api/keyerrors":
                return self.send_json(api_keyerrors_put(self.require_user(), self.read_json()))
            if path == "/api/keyerrors/reset":
                return self.send_json(api_keyerrors_reset(self.require_user()))
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
