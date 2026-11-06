#!/bin/bash
# 经 Instabox 中转发布视频（智能体 Muse 专用工具）
#
# 用法: publish-via-relay.sh <本地视频文件> <标题> <简介> [posterHue]
#
# 流程：本地文件先用 instabox push 快速送到云电脑 muse 的
# /data/yousj-video-relay/inbox/（实测约 1.4MB/s），再在 muse 上以
# 后台 job 方式跑 relay-upload.py 分片上传到 video.yousj.cc 并发布。
# muse→北京一段受北京机入境带宽限制（实测约 15KB/s），所以发布是
# 异步的：本脚本拿到 job id 即返回，用
#   ibx jobs logs muse <jobId> 查看进度，UPLOAD OK + PUBLISH 200 即完成。
set -e
FILE=$1; TITLE=$2; DESC=${3:-}; HUE=${4:-210}
[ -f "$FILE" ] || { echo "文件不存在: $FILE"; exit 1; }

# instabox CLI 包装：优先 PATH 上的 ibx，其次用 API key 环境变量 + npx
if command -v ibx >/dev/null 2>&1; then IBX="ibx";
else
  if [ -z "$INSTABOX_API_KEY" ] && [ -f ~/.config/instabox/credentials.json ]; then
    INSTABOX_API_KEY=$(python3 -c "
import json
d = json.load(open('$HOME/.config/instabox/credentials.json'))
def find(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and v.startswith('ibk_'): return v
            r = find(v)
            if r: return r
    return None
print(find(d) or '')")
    export INSTABOX_API_KEY
  fi
  IBX="npx -y instabox@latest"
fi

BASE=$(basename "$FILE")
REMOTE=/data/yousj-video-relay/inbox/$BASE
$IBX exec muse -- mkdir -p /data/yousj-video-relay/inbox
$IBX push muse "$FILE" "$REMOTE"
PUB=$(TITLE="$TITLE" DESC="$DESC" HUE="$HUE" python3 -c "
import json, os
print(json.dumps({'title': os.environ['TITLE'], 'desc': os.environ['DESC'], 'posterHue': int(os.environ['HUE'])}, ensure_ascii=False))")
$IBX exec --background muse -- python3 /data/yousj-video-relay/relay-upload.py "$REMOTE" --publish "$PUB"
echo "已提交后台发布 job（见上方 job id）。查进度: ibx jobs logs muse <jobId>"
