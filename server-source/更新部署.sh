#!/bin/bash
# 改完代码后一键生效：备份 → 重启服务 → 验证
# 用法（服务器上 root 执行）：bash /root/update-typing.sh
set -e

TS=$(date +%Y%m%d_%H%M%S)
echo "==> 备份当前版本到 /root/typing-backup/$TS"
mkdir -p /root/typing-backup/$TS
cp /root/typing-server/server.py /root/typing-server/public/index.html /root/typing-backup/$TS/
cp /root/typing-server/data.db /root/typing-backup/$TS/ 2>/dev/null || true

echo "==> 清理 Python 缓存并重启服务"
rm -rf /root/typing-server/__pycache__
systemctl restart typing-practice
sleep 2

echo "==> 验证"
systemctl --no-pager status typing-practice | head -3
curl -s -o /dev/null -w "8000 首页: %{http_code}\n" http://127.0.0.1:8000/
curl -s -o /dev/null -w "80   首页: %{http_code}\n" http://127.0.0.1/
echo "完成。"
