#!/bin/bash
# 在已确认的生产维护窗口运行：bash update-typing.server.sh STAGING_DIR /usr/bin/python3.11
# STAGING_DIR 下须有 server.py 和 index.server.html。不替换系统 Python；数据库只做在线快照，不覆盖生产数据库。
set -euo pipefail
umask 077
[[ $# -eq 2 && $(id -u) -eq 0 ]] || { echo 'Usage: update-typing.server.sh STAGING_DIR /absolute/path/to/python3.11' >&2; exit 2; }
source_dir=$(realpath "$1")
python=$2
[[ "$python" =~ ^/[a-zA-Z0-9/._-]+$ && -x "$python" ]] || { echo 'Invalid Python executable' >&2; exit 2; }
app=/root/typing-server
unit=typing-practice.service
confdir=/etc/systemd/system/typing-practice.service.d
conf=$confdir/90-typing-python.conf
[[ -f "$source_dir/server.py" && -f "$source_dir/index.server.html" && -f "$app/data.db" ]]
systemctl is-active --quiet "$unit"
curl --retry-connrefused --version >/dev/null
"$python" -B -c 'import gzip, pathlib, sqlite3, sys; assert sys.version_info[:2] in ((3,11), (3,12), (3,13), (3,14)), sys.version; p=pathlib.Path(sys.argv[1]); compile(p.read_bytes(), str(p), "exec")' "$source_dir/server.py"
# 本次只覆盖已知的原服务启动命令，遇到未知配置先停止。
exec_start=$(systemctl show "$unit" -p ExecStart --value)
[[ "$exec_start" == *' /root/typing-server/server.py 8000 '* ]]
backup=$(mktemp -d /root/typing-backup/typing-opt-XXXXXXXX)
cp -p "$app/server.py" "$backup/server.py"
cp -p "$app/public/index.html" "$backup/index.html"
if [[ -e "$conf" ]]; then cp -p "$conf" "$backup/90-typing-python.conf"; fi
"$python" -B -c 'import sqlite3,sys; a=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()' "$app/data.db" "$backup/data.db"
echo "Backup: $backup"

rollback() {
  trap - ERR
  set +e
  echo "Deployment failed; restoring code and unit config from $backup" >&2
  mv -f "$backup/rollback-server.py" "$app/server.py" &&
    mv -f "$backup/rollback-index.html" "$app/public/index.html" &&
    if [[ -f "$backup/90-typing-python.conf" ]]; then
      cp -p "$backup/90-typing-python.conf" "$conf"
    else
      rm -f -- "$conf"
    fi &&
    systemctl daemon-reload && systemctl restart "$unit" &&
    curl --retry 3 --retry-connrefused --max-time 5 -fsS -o /dev/null http://127.0.0.1:8000/ ||
    echo 'Rollback health check failed; verify the service in Workbench.' >&2
  exit 1
}
# 在各目标目录内暂存，避免跨挂载点复制时让服务读到半个文件。
cp -p "$backup/server.py" "$backup/rollback-server.py"
cp -p "$backup/index.html" "$backup/rollback-index.html"
install -d -m 755 "$confdir"
front=$(mktemp "$app/public/.typing-new-XXXXXXXX")
back=$(mktemp "$app/.typing-new-XXXXXXXX")
unit_tmp=$(mktemp "$confdir/.typing-new-XXXXXXXX")
install -m 644 "$source_dir/index.server.html" "$front"
install -m 644 "$source_dir/server.py" "$back"
printf '[Service]\nExecStart=\nExecStart=%s /root/typing-server/server.py 8000\n' "$python" > "$unit_tmp"
chmod 644 "$unit_tmp"
trap rollback ERR
mv -f "$back" "$app/server.py"
mv -f "$front" "$app/public/index.html"
mv -f "$unit_tmp" "$conf"
systemctl daemon-reload
systemctl restart "$unit"
curl --retry 4 --retry-connrefused --max-time 5 -fsS --compressed -o "$backup/verified-index.html" http://127.0.0.1:8000/
cmp -s "$source_dir/index.server.html" "$backup/verified-index.html"
curl --max-time 5 -fsSI -H 'Accept-Encoding: gzip' http://127.0.0.1:8000/ | tr -d '\r' | grep -qi '^Content-Encoding: gzip$'
systemctl is-active --quiet "$unit"
systemctl show "$unit" -p ExecStart --value | grep -Fq "path=$python "
trap - ERR
echo "Deployed and verified. Backup: $backup"
