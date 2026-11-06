#!/usr/bin/env python3
"""Yousj 短视频上传中转（跑在 Instabox 机器上）：
把本地文件经分片接口上传到 video.yousj.cc，可选直接发布。
用法: relay-upload.py <文件> [--publish '{"title":"标题","desc":"简介","posterHue":210}']
密钥读 /data/yousj-video-relay/agent-key（600 权限），不打印。
"""
import json, math, os, sys, time, urllib.request

BASE = "https://video.yousj.cc"
KEY_FILE = "/data/yousj-video-relay/agent-key"
CHUNK = 4 * 1024 * 1024

def api(method, path, body=None, key=""):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def api_retry(method, path, body, key, tries=4):
    for i in range(tries):
        try:
            st, d = api(method, path, body, key)
            if st == 200 or i == tries - 1:
                return st, d
        except Exception as e:
            if i == tries - 1:
                raise
            print("retry", path, e, flush=True)
        time.sleep(5)

def main():
    path = sys.argv[1]
    publish = None
    if "--publish" in sys.argv:
        publish = json.loads(sys.argv[sys.argv.index("--publish") + 1])
    key = open(KEY_FILE).read().strip()
    size = os.path.getsize(path)
    t0 = time.time()
    st, d = api("POST", "/api/upload/init", {"filename": os.path.basename(path), "size": size, "mime": "video/mp4"}, key)
    if st != 200:
        print("INIT FAIL", st, d); sys.exit(1)
    uid = d["uploadId"]
    n = math.ceil(size / CHUNK)
    with open(path, "rb") as f:
        for i in range(n):
            part = f.read(CHUNK)
            import base64
            st, d = api_retry("POST", "/api/upload/chunk",
                        {"uploadId": uid, "index": i, "dataBase64": base64.b64encode(part).decode()}, key)
            if st != 200:
                print("CHUNK FAIL", i, st, d); sys.exit(1)
            print(f"chunk {i+1}/{n} ok ({time.time()-t0:.0f}s)", flush=True)
    st, d = api("POST", "/api/upload/complete", {"uploadId": uid}, key)
    if st != 200:
        print("COMPLETE FAIL", st, d); sys.exit(1)
    dt = time.time() - t0
    print(f"UPLOAD OK url={d['url']} size={d['size']} elapsed={dt:.0f}s speed={size/dt/1024:.0f} KB/s")
    if publish:
        publish["videoUrl"] = d["url"]
        st, v = api("POST", "/api/videos", publish, key)
        print("PUBLISH", st, json.dumps(v, ensure_ascii=False)[:200])
        if st != 200: sys.exit(1)

if __name__ == "__main__":
    main()
