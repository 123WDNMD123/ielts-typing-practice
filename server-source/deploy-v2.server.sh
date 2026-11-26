#!/bin/bash
# ============================================================
#  v2.0 发布脚本（服务器上 root 执行）
#  用法: bash deploy-v2.server.sh <stagingDir>
#
#  与 v1.x 的差别：
#   1. 前端由单文件变为七文件（index.html + tokens.css + app.css
#      + data.js + motion.js + app.js + server.py），健康检查逐文件哈希。
#   2. 双版本并存：public-v1 / public-v2 两个实体目录，public 是符号链。
#      回滚 = 重指符号链，秒级、无需重启服务。
#   3. 数据库绝不覆盖；仅做在线 SQLite 快照备份。
#
#  任何一步失败 → trap 自动把符号链指回旧版并退出非零。
# ============================================================
set -euo pipefail

STAGING="${1:?用法: bash deploy-v2.server.sh <stagingDir>}"
ROOT=/root/typing-server
BACKUP=/root/typing-backup
TS=$(date +%Y%m%d_%H%M%S)
BK="$BACKUP/typing-v2-$TS"
SERVICE=typing-practice

FRONT_FILES=(index.html tokens.css app.css data.js motion.js app.js)
ALL_FILES=("${FRONT_FILES[@]}" server.py)

log(){ echo "==> $*"; }
die(){ echo "!! $*" >&2; exit 1; }

# ---------- 0. 暂存区校验 ----------
log "校验暂存区 $STAGING"
[ -d "$STAGING" ] || die "暂存目录不存在"
for f in "${ALL_FILES[@]}"; do
  [ -f "$STAGING/$f" ] || die "暂存缺文件: $f"
done
log "暂存区文件哈希:"
( cd "$STAGING" && sha256sum "${ALL_FILES[@]}" )

# ---------- 1. 记录当前状态（用于回滚） ----------
CUR_PUBLIC="$ROOT/public"
OLD_TARGET=""
if [ -L "$CUR_PUBLIC" ]; then
  OLD_TARGET=$(readlink -f "$CUR_PUBLIC")
  log "当前 public 符号链指向: $OLD_TARGET"
elif [ -d "$CUR_PUBLIC" ]; then
  OLD_TARGET="$CUR_PUBLIC"
  log "当前 public 是实体目录（首次迁移到双版本结构）"
else
  die "public 不存在"
fi

ROLLBACK_DONE=0
rollback(){
  [ "$ROLLBACK_DONE" = "1" ] && return
  ROLLBACK_DONE=1
  echo "!! 触发回滚" >&2
  if [ -n "$OLD_TARGET" ] && [ -d "$OLD_TARGET" ]; then
    if [ "$OLD_TARGET" != "$CUR_PUBLIC" ]; then
      rm -f "$CUR_PUBLIC" 2>/dev/null || true
      ln -sfn "$OLD_TARGET" "$CUR_PUBLIC"
      echo "!! public 已指回 $OLD_TARGET" >&2
    fi
  fi
  if [ -f "$BK/server.py" ]; then
    cp -f "$BK/server.py" "$ROOT/server.py"
    systemctl restart "$SERVICE" || true
    echo "!! server.py 已还原并重启" >&2
  fi
}
trap rollback ERR

# ---------- 2. 备份 ----------
log "备份到 $BK"
mkdir -p "$BK"
cp -f "$ROOT/server.py" "$BK/server.py"
if [ -L "$CUR_PUBLIC" ]; then
  cp -rf "$(readlink -f "$CUR_PUBLIC")" "$BK/public"
else
  cp -rf "$CUR_PUBLIC" "$BK/public"
fi
# 在线 SQLite 快照（绝不直接 cp 活跃库）
python3.11 - "$ROOT/data.db" "$BK/data.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src); d = sqlite3.connect(dst)
with d: s.backup(d)
d.close(); s.close()
print("SQLite 在线快照完成")
PY
DB_TABLES_BEFORE=$(python3.11 -c "
import sqlite3;c=sqlite3.connect('$ROOT/data.db')
print(len(c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()))")
DB_RECORDS_BEFORE=$(python3.11 -c "
import sqlite3;c=sqlite3.connect('$ROOT/data.db')
print(c.execute('SELECT COUNT(*) FROM records').fetchone()[0])")
log "发布前: ${DB_TABLES_BEFORE} 表 / ${DB_RECORDS_BEFORE} 条成绩"

# ---------- 3. 布置 v2 实体目录 ----------
V2DIR="$ROOT/public-v2"
log "布置 $V2DIR"
mkdir -p "$V2DIR"
for f in "${FRONT_FILES[@]}"; do
  cp -f "$STAGING/$f" "$V2DIR/$f.new"
  mv -f "$V2DIR/$f.new" "$V2DIR/$f"
done

log "校验 v2 目录逐文件哈希"
for f in "${FRONT_FILES[@]}"; do
  A=$(sha256sum "$STAGING/$f" | cut -d' ' -f1)
  B=$(sha256sum "$V2DIR/$f"  | cut -d' ' -f1)
  [ "$A" = "$B" ] || die "哈希不一致: $f"
  echo "  OK $f  $A"
done

# ---------- 4. 旧版留档为 public-v1 ----------
V1DIR="$ROOT/public-v1"
if [ ! -d "$V1DIR" ]; then
  log "首次迁移：把当前前端留档为 $V1DIR"
  mkdir -p "$V1DIR"
  if [ -L "$CUR_PUBLIC" ]; then
    cp -rf "$(readlink -f "$CUR_PUBLIC")/." "$V1DIR/"
  else
    cp -rf "$CUR_PUBLIC/." "$V1DIR/"
  fi
fi

# ---------- 5. 更新 server.py 并重启 ----------
log "更新 server.py"
cp -f "$STAGING/server.py" "$ROOT/server.py.new"
A=$(sha256sum "$STAGING/server.py" | cut -d' ' -f1)
B=$(sha256sum "$ROOT/server.py.new" | cut -d' ' -f1)
[ "$A" = "$B" ] || die "server.py 哈希不一致"
mv -f "$ROOT/server.py.new" "$ROOT/server.py"
rm -rf "$ROOT/__pycache__"

# ---------- 6. 切符号链到 v2 ----------
log "切换 public → public-v2"
if [ -L "$CUR_PUBLIC" ]; then
  ln -sfn "$V2DIR" "$CUR_PUBLIC"
elif [ -d "$CUR_PUBLIC" ]; then
  # 实体目录：先搬走再建链（v1 留档已在上一步完成）
  mv "$CUR_PUBLIC" "$ROOT/public-legacy-$TS"
  ln -sfn "$V2DIR" "$CUR_PUBLIC"
fi
[ "$(readlink -f "$CUR_PUBLIC")" = "$(readlink -f "$V2DIR")" ] || die "符号链切换失败"

log "重启服务"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active "$SERVICE" >/dev/null || die "服务未 active"

# ---------- 7. 健康检查：逐文件 200 + 哈希 + gzip ----------
log "健康检查（逐文件）"
for f in "${FRONT_FILES[@]}"; do
  URL="http://127.0.0.1:8000/$f"
  [ "$f" = "index.html" ] && URL="http://127.0.0.1:8000/"
  CODE=$(curl -s -o /tmp/v2check.bin -w '%{http_code}' "$URL")
  [ "$CODE" = "200" ] || die "$f HTTP $CODE"
  GOT=$(sha256sum /tmp/v2check.bin | cut -d' ' -f1)
  WANT=$(sha256sum "$V2DIR/$f" | cut -d' ' -f1)
  [ "$GOT" = "$WANT" ] || die "$f 内容哈希不一致"
  GZ=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$URL")
  ID=$(stat -c%s "$V2DIR/$f")
  [ "$GZ" -lt "$ID" ] || die "$f gzip 未生效（gzip=$GZ identity=$ID）"
  echo "  OK $f  200  identity=$ID gzip=$GZ"
done
rm -f /tmp/v2check.bin

# 304 协商（同编码口径）
ET=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' http://127.0.0.1:8000/ | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2-)
C304=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' -H "If-None-Match: $ET" http://127.0.0.1:8000/)
[ "$C304" = "304" ] || die "首页 304 协商失败（$C304）"
echo "  OK 首页 304 协商"

# nginx 前置
CODE80=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)
[ "$CODE80" = "200" ] || die "nginx 80 首页 $CODE80"
echo "  OK nginx 80"

# 访客 API 鉴权
GUEST=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/records)
[ "$GUEST" = "401" ] || die "访客 records 应 401，实际 $GUEST"
echo "  OK 访客鉴权 401"

# ---------- 8. 数据库完好性 ----------
DB_TABLES_AFTER=$(python3.11 -c "
import sqlite3;c=sqlite3.connect('$ROOT/data.db')
print(len(c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()))")
DB_RECORDS_AFTER=$(python3.11 -c "
import sqlite3;c=sqlite3.connect('$ROOT/data.db')
print(c.execute('SELECT COUNT(*) FROM records').fetchone()[0])")
[ "$DB_TABLES_BEFORE" = "$DB_TABLES_AFTER" ] || die "表数变化 $DB_TABLES_BEFORE → $DB_TABLES_AFTER"
[ "$DB_RECORDS_BEFORE" = "$DB_RECORDS_AFTER" ] || die "成绩数变化 $DB_RECORDS_BEFORE → $DB_RECORDS_AFTER"
log "数据库完好: ${DB_TABLES_AFTER} 表 / ${DB_RECORDS_AFTER} 条成绩（与发布前一致）"

trap - ERR
log "发布成功。备份: $BK"
log "回滚方法（秒级，无需重启）: ln -sfn $V1DIR $CUR_PUBLIC"
echo "DONE"