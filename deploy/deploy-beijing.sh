#!/bin/bash
# Yousj 短视频 —— 部署到中继服务器（203.0.113.10）
#
#
# 服务器出网受限：它只能「被推」文件，不能从外网拉任何东西。
# 所以本脚本不在服务器上下载任何东西（后端是 Node 零依赖，连 npm install 都不需要），
# 流程是：先把项目文件推到，再在服务器本地跑这个脚本。
#
#
# 1. 把整个 yousj-video 文件夹推到 /opt/yousj-video，任选一种：
# - 服务器 MCP 网关推文件（推荐，日常改动也走它）
# - SFTP 传到 /opt/yousj-video（21 端口 FTP 已停用，走 SFTP/22）
# - 宝塔面板文件管理上传 zip 后解压到 /opt/yousj-video
# 2. 在服务器上（宝塔终端 / ssh 进去）跑：
# cd /opt/yousj-video && bash deploy/deploy-beijing.sh
# 如果文件推到了别的目录，在那个目录跑本脚本也行：
# 脚本会自己把项目同步到 /opt/yousj-video（且不会覆盖线上的
# server/data.json 和 uploads/ 里已有的数据）。
#
#
# node --check 语法检查 → 同步文件到 /opt/yousj-video → 装 systemd 服务
# yousj-video.service（User=root、Restart=always、PORT=18088）→
# 重启服务 → curl 本机健康检查（只 curl 127.0.0.1，不碰外网）。
# 另外会检查磁盘余量和 ffmpeg 是否存在，只警告、不中断。
#
#
# 注册验证码邮件（发件人 hello@yousj.cc，经自建邮局）二选一：
# MAIL_WEBHOOK_URL=<webhook 地址>
# SMTP_HOST=<主机> SMTP_PORT=<端口> SMTP_USER=<hello@yousj.cc> SMTP_PASS=<密码>
# 写法：把变量写进 /etc/yousj-video.env（chmod 600），服务单元已配
# EnvironmentFile 自动加载。再三强调：生产环境不要设置 ALLOW_DEV_CODE
# （那是本机开发 / e2e 测试拿 devCode 用的，线上开了等于免验证码注册）。
#
#
# - 磁盘：4K 原画约 11~22 GB/小时，磁盘建议 200GB 起步，先 df -h 看余量。
# - ffmpeg：超阈值视频（时长 >1h 或 文件 >5GB）压缩到 1080p 要用它转码，
# 缺了只会标记 compressReason、不真正转码；部署前用宝塔/apt 一次性装好。
#
#
# A. 直接放行端口：百度云安全组 + 宝塔面板防火墙都放行 18088，
# 然后访问 http://203.0.113.10:18088/ ——明文 HTTP，只应急。
# B. nginx 反代 + HTTPS（推荐）：宝塔给子域名建站并申请证书后，
# 站点配置参考下面（完整版见 README「部署到中继服务器」）：
#
# # 80 强制跳 443
# server {
# listen 80;
# server_name <你的子域名>;
# return 301 https://$host$request_uri;
#}
# server {
# listen 443 ssl;
# server_name <你的子域名>;
# ssl_certificate <宝塔证书路径>/fullchain.pem;
# ssl_certificate_key <宝塔证书路径>/privkey.pem;
# # HSTS：让浏览器记住只许 HTTPS，防降级窃听
# add_header Strict-Transport-Security "max-age=31536000" always;
# location / {
# proxy_pass http://127.0.0.1:18088;
# proxy_http_version 1.1;
# proxy_set_header Host $host;
# proxy_set_header X-Real-IP $remote_addr;
# proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# # 分片每片 8MB（base64 后约 11MB）；256m 兼顾整文件直传兜底
# client_max_body_size 256m;
# # 分片多、网速慢时放宽超时，别让 nginx 先掐断
# proxy_connect_timeout 60s;
# proxy_send_timeout 600s;
# proxy_read_timeout 600s;
# proxy_request_buffering off;
#}
#}
#
set -euo pipefail

TARGET="/opt/yousj-video"
PORT="${PORT:-18088}"

# --- 定位项目根目录（本脚本在 deploy/ 里，根目录是它的上一级） ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../server/server.js"]; then
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$SCRIPT_DIR/server/server.js"]; then
PROJECT_DIR="$SCRIPT_DIR"
else
echo "找不到 server/server.js：请在完整的 yousj-video 项目里跑本脚本"
exit 1
fi
echo "项目目录: $PROJECT_DIR → 部署目标: $TARGET (端口 $PORT)"

# --- 必须 root（要写 /etc/systemd/system） ---
if [ "$(id -u)"!= "0"]; then
echo "需要 root 运行（装 systemd 服务）"
exit 1
fi

# --- 环境检查（只警告不中断）：磁盘余量 + ffmpeg ---
echo "--- 磁盘余量（4K 原画约 11~22 GB/小时，建议 200GB 起步） ---"
df -h "$TARGET" 2>/dev/null || df -h /
if command -v ffmpeg >/dev/null 2>&1; then
echo "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)"
else
echo "警告：没有 ffmpeg——超阈值视频（>1h 或 >5GB）只能标记 compressReason，无法转码到 1080p。请用宝塔/apt 装好后重启服务。"
fi
if [! -f /etc/yousj-video.env]; then
echo "提醒：/etc/yousj-video.env 不存在——注册验证码邮件发不出去（需配 MAIL_WEBHOOK_URL 或 SMTP_*，见本脚本头部注释）。"
fi

# --- 找 node（优先 PATH 里的，其次宝塔自带路径） ---
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN"] && [ -x /www/server/nodejs/v24.22.1/bin/node]; then
NODE_BIN="/www/server/nodejs/v24.22.1/bin/node"
fi
if [ -z "$NODE_BIN"] || [! -x "$NODE_BIN"]; then
echo "服务器上没 node：先在宝塔里装 Node v24（或 apt 装 nodejs）再跑"
exit 1
fi
echo "node: $NODE_BIN ($("$NODE_BIN" --version))"

# --- 部署前语法检查，不过就不部署 ---
"$NODE_BIN" --check "$PROJECT_DIR/server/server.js"
echo "node --check server/server.js OK"
if [ -f "$PROJECT_DIR/tests/e2e.mjs"]; then
"$NODE_BIN" --check "$PROJECT_DIR/tests/e2e.mjs" && echo "node --check tests/e2e.mjs OK"
fi

# --- 同步到 /opt/yousj-video（在目标目录原地跑时跳过；同步时保住线上数据） ---
if [ "$PROJECT_DIR"!= "$TARGET"]; then
mkdir -p "$TARGET"
DATA_BAK=""
if [ -f "$TARGET/server/data.json"]; then
DATA_BAK="$(mktemp)"
cp "$TARGET/server/data.json" "$DATA_BAK"
echo "已备份线上数据 server/data.json，同步后还原（新代码不会冲掉老数据）"
fi
cp -a "$PROJECT_DIR/." "$TARGET/"
if [ -n "$DATA_BAK"]; then
cp "$DATA_BAK" "$TARGET/server/data.json"
rm -f "$DATA_BAK"
fi
fi
cd "$TARGET"

# --- 装 systemd 服务（把服务文件里的 node 路径替换成本机实际路径） ---
sed -e "s|/www/server/nodejs/v24.22.1/bin/node|$NODE_BIN|g" \
-e "s|Environment=PORT=18088|Environment=PORT=$PORT|" \
"$TARGET/deploy/yousj-video.service" > /etc/systemd/system/yousj-video.service
systemctl daemon-reload
systemctl enable yousj-video.service
systemctl restart yousj-video.service
sleep 2
systemctl status yousj-video.service --no-pager | head -20 || true

# --- 健康检查（只 curl 本机回环，不是外网） ---
HEALTH_OK=0
for i in 1 2 3 4 5; do
for path in /api/health /health /; do
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path" || echo 000)"
if [ "$CODE" = "200"]; then
echo "健康检查 OK: http://127.0.0.1:$PORT$path -> 200"
HEALTH_OK=1
break 2
fi
done
echo "第 $i 次健康检查未通过，等 2 秒重试…"
sleep 2
done
if [ "$HEALTH_OK"!= "1"]; then
echo "健康检查失败，看日志：journalctl -u yousj-video -n 50 --no-pager 或 tail -f /var/log/yousj-video.log"
exit 1
fi

echo ""
echo "部署完成。日志：journalctl -u yousj-video -f 或 tail -f /var/log/yousj-video.log"
echo "外网访问：优先 nginx 反代 + HTTPS + HSTS（见本脚本头部注释 / README）；或放行 $PORT 直连（明文，应急用）"
echo " 直连地址将是：http://203.0.113.10:$PORT/"
