# Yousj 短视频

一个类抖音的短视频应用：刷视频、点赞、评论、收藏、转发给朋友，还有好友体系和加密私信。
架构仿 MeshChat：一台服务器当中继，后端是 Node 零依赖的单文件服务，前端是静态页面。

**已上线运行**，除网页版外还提供 Android APK、Windows 桌面 EXE 与 Linux 桌面客户端（见「客户端」一节）。

## 功能清单

- **推荐流（首页）**：全屏竖刷作品流，按发布时间倒序（暂无推荐算法）
- **朋友流（「朋友」页）**：只看自己好友发布的作品
- **发布（底部中间「＋」按钮）**：选视频 → 分片上传 → 填标题/文案发布
- **点赞 / 评论 / 收藏**：收藏的作品在「我的」里看收藏列表
- **转发**：把作品转发给好友，对方在私信里收到一张作品卡片，点开能看
- **搜索**：首页顶栏放大镜进入搜索页，可搜作品（标题/描述/作者名）和用户
- **作者主页**：点作品作者头像/名字或评论头像，进入其主页看全部作品、加好友或直接私信
- **私信**：和好友一对一聊天，端到端加密（见「安全分层」）
- **账号与好友**：邮箱验证码注册（见下）；登录以邮箱+密码为主，兼容「昵称#号」账号；可按昵称/#号/邮箱搜人、发好友申请、对方接受后互为好友
- **「我的」页**：我的作品、我的收藏、账号信息、好友申请处理

底部导航：首页 / 朋友 / **＋（发布）** / 消息 / 我的。

## 账号体系（定版：只允许邮箱注册）

没有「输个昵称就注册」的入口了，流程只有一条：

1. 输入邮箱 → `POST /api/register/request-code {email}`，服务器发验证码邮件（**发件人 hello@yousj.cc，经自建邮局**）；该邮箱已注册时返回 **409**
2. 填验证码 + 姓名 + 密码（可带私信公钥 `pubKey`）→ `POST /api/register/verify {email, code, name, password, pubKey?}` 验码建号；验证码错误则建号失败
3. 之后登录走独立登录接口：**邮箱 + 密码为主**，兼容用「昵称#号」+ 密码登录

旧的直接注册接口已废弃，调用返回 **410**。

### 发信配置（凭据只走环境变量，绝不进代码仓库）

服务器发验证码邮件，二选一：

| 方式 | 环境变量 | 说明 |
|---|---|---|
| Webhook | `MAIL_WEBHOOK_URL` | 把验证码投递到自建邮局的 webhook 地址 |
| SMTP | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 用 hello@yousj.cc 的邮箱凭据直连自建邮局发信 |

- 生产环境：在服务器上用 systemd `EnvironmentFile`（如 `/etc/yousj-video.env`，权限 600）注入以上变量，仓库里只有变量名占位、没有真实值。
- 本机开发/测试：启动时加 `ALLOW_DEV_CODE=1`，`request-code` 的响应会直接带 `devCode`，不用真发邮件就能走完注册流程（e2e 测试就靠它）。**生产环境禁止开启。**

## 上传与视频规格（定版）

- **分片上传**：`init → chunk → complete` 三段接口，**每片 8MB**，断了可以续、拼合后校验完整性；大文件（4K 原画）全靠它扛。
- **画质策略：尽量保 4K 原画。** 是否压缩只看双阈值：

| 条件 | 处理 | Video.compressReason |
|---|---|---|
| 时长 ≤ 1 小时 **且** 文件 ≤ 5GB | **保 4K 原画，不压缩** | `null` |
| 时长 > 1 小时 | 压缩为 1080p | `"duration"` |
| 文件 > 5GB | 压缩为 1080p | `"size"` |
| 两者都超 | 压缩为 1080p | `"both"` |

  作品对象带 `compressReason` 字段记录触发原因（未触发为 `null`）；需要压缩的作品先标记、由服务器转码（依赖 ffmpeg，见下）。
- 另有老的整文件直传接口 `/api/upload`（JSON + base64）作小文件兜底，上限 200MB；正式发布走分片上传。

### 磁盘空间提醒（4K 原画非常吃磁盘）

| 类型 | 典型码率 | 1 小时体积 |
|---|---|---|
| 4K HEVC（手机常见） | ~25 Mbps | ~11 GB |
| 4K H.264 | ~50 Mbps | ~22 GB |
| 1080p（压缩后） | ~10 Mbps | ~4.5 GB |

估算示例：100 条平均 5 分钟的 4K 原画作品 ≈ 90GB 以上。**部署机磁盘建议 200GB 起步**，上线前先 `df -h` 看清余量，并给 `uploads/` 做定期备份/清理计划；磁盘写满会直接导致上传和数据保存失败。

### ffmpeg 依赖

超过阈值的视频压缩/转码为 1080p 需要服务器上装有 **ffmpeg**。没装时作品会被标记 `compressReason` 但无法真正转码。部署脚本会检查并提醒；安装走宝塔软件商店或 apt（部署时一次性装好，不在运行时下载）。

## 安全分层（按真实架构写，不夸大）

本应用的安全是**分层**的，不同数据的保护级别不同，请勿理解为「全站端到端加密」：

| 层 | 机制 | 保护什么 |
|---|---|---|
| 传输层 | **HTTPS / TLS**（nginx 反代终止 TLS + HSTS，见部署一节） | 所有请求在网络上不被窃听/篡改；直连 18088 端口是明文 HTTP，只供本机调试 |
| 账号层 | 密码 **scrypt 加盐哈希** 存储 | 数据库泄露时密码不直接暴露；验证码注册防冒名占号 |
| 私信层 | **端到端加密：ECDH P-256 协商 + HKDF 派生 + AES-GCM-256 加密**，在客户端完成 | 私信内容只有对话双方能解；**服务器只存/转发密文**，无法解密（e2e 测试发模拟密文并断言服务器原样存取、一个字都不改） |
| 公开互动 | 作品、评论、点赞、收藏为**公开互动，不做端到端加密** | 仅靠传输层 TLS 保护；内容本身对服务器和观众可见，这是产品形态决定的 |

## 技术结构

- 后端：Node.js（零第三方依赖），默认端口 **18088**，入口 `server/server.js`
- 数据：`server/data.json` 一个 JSON 文件（用户/作品/评论/好友/私信密文）；上传文件存 `server/uploads/`，分片临时文件拼合后清理
- 前端：`app/www/` 静态页面，由后端一并托管
- 中继：中继服务器单机部署，systemd 常驻（`yousj-video.service`，`User=root`、`Restart=always`）

## 本地跑法

```bash
cd yousj-video
ALLOW_DEV_CODE=1 node server/server.js   # 本地开发：注册验证码直接在响应里拿
# 浏览器打开 http://localhost:18088
```

改端口：`PORT=18089 node server/server.js`。不用 dev 模式时，注册验证码走真实邮件，需要先配好上面的发信环境变量。

## 跑测试

```bash
ALLOW_DEV_CODE=1 node server/server.js   # 终端 1：带 dev 取码起服务
node tests/e2e.mjs                        # 终端 2：全链路断言
# 测别的地址：BASE=http://203.0.113.10:18088 node tests/e2e.mjs（线上没有 devCode，注册段需改走真实邮箱，见脚本头注）
```

覆盖：health → 邮箱验证码注册两用户（错码失败 / 已注册邮箱 409 / 旧注册接口 410）→ 邮箱密码登录 → A 发作品 → 分片上传小文件拼合后逐字节一致 → B 推荐流看到且 `compressReason=null` → 点赞 → 收藏 → 评论 → 搜人 → 好友申请/接受 → 朋友流看到 → B 私信 A 发模拟密文 → A 取回密文一字不差 → A 转发作品给 B → B 私信收到作品卡片 → 收藏列表有该作品。每步 ✓/✗，最后 PASS/FAIL 汇总，失败退出码非 0。

## 目录结构

```
yousj-video/
├── server/
│   ├── server.js        # 后端全部逻辑：API + 静态托管 + 分片拼合 + 发信
│   ├── data.json        # 运行时数据，首次启动自动生成
│   └── uploads/         # 上传的视频文件
├── app/
│   └── www/             # 前端静态页面（第一阶段 HTML 版）
├── tests/
│   └── e2e.mjs          # 全链路 E2E 断言脚本（零依赖）
├── deploy/
│   ├── deploy-beijing.sh    # 部署脚本（本地执行型，见下）
│   └── yousj-video.service  # systemd 服务单元
└── README.md
```

## 部署到中继服务器

服务器出网受限，只能「被推」不能「拉外网」，所以部署是**推送 + 本地执行**，全程不在服务器上下载任何东西（后端零依赖，不需要 `npm install`；ffmpeg 如缺失需在部署前用宝塔/apt 一次性装好）。

1. 先确认磁盘余量（4K 原画很吃磁盘，建议 200GB 起步，见「磁盘空间提醒」）和 ffmpeg 是否存在：`df -h`、`ffmpeg -version`。
2. 把整个 `yousj-video` 文件夹推到 `/opt/yousj-video`：服务器 MCP 网关推文件、SFTP（22 端口，FTP 21 已停用）、或宝塔文件管理上传 zip 解压，三选一。
3. 在服务器上建 `/etc/yousj-video.env`（权限 600）写入发信凭据（变量名见「发信配置」，**不要把真实值写进仓库或脚本**），服务单元已配置自动加载它。
4. 在服务器上执行：

   ```bash
   cd /opt/yousj-video && bash deploy/deploy-beijing.sh
   ```

   脚本会：`node --check` 语法检查 → 同步文件（不覆盖线上 `server/data.json`）→ 安装 systemd 服务 → 重启 → curl 本机健康检查；并检查磁盘余量与 ffmpeg，缺失只警告不中断。
5. 对外访问走 **nginx 反代 + HTTPS（推荐，不裸露 18088）**：宝塔给子域名建站并申请证书后，站点配置参考：

   ```nginx
   # HTTP 强制跳 HTTPS
   server {
       listen 80;
       server_name <你的子域名>;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl;
       server_name <你的子域名>;
       ssl_certificate     <宝塔证书路径>/fullchain.pem;
       ssl_certificate_key <宝塔证书路径>/privkey.pem;
       # HSTS：浏览器记住只用 HTTPS 访问（与上面的跳转一起，防降级窃听）
       add_header Strict-Transport-Security "max-age=31536000" always;

       location / {
           proxy_pass http://127.0.0.1:18088;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           # 分片上传每片 8MB（base64 后约 11MB），256m 同时留给整文件直传兜底
           client_max_body_size 256m;
           # 大文件分片多、网络慢时别让 nginx 先超时掐断
           proxy_connect_timeout 60s;
           proxy_send_timeout 600s;
           proxy_read_timeout 600s;
           proxy_request_buffering off;
       }
   }
   ```

   备选（不推荐长期用）：百度云安全组 + 宝塔防火墙放行 18088 直连——那是明文 HTTP，没有 TLS 保护。
6. 看日志：`journalctl -u yousj-video -f` 或 `tail -f /var/log/yousj-video.log`。

## 客户端

网页版之外有三套原生壳客户端，加载的都是线上网页版，功能与网页版一致：

- **Android APK**（`clients/android/`）：WebView 壳，包名 `com.yousj.video`，纯 SDK build-tools 手工构建（无 Gradle），含文件选择器支持（App 内可发布上传）。构建与签名说明见该目录 README。**注意：签名密钥库（`clients/android/signing/`）不进公开仓库**，克隆后首次构建会自动生成自己的证书。
- **Windows EXE**（`clients/windows/`）：WebView2 壳，mingw-w64 交叉编译，`YousjVideo.exe` 需与 `WebView2Loader.dll` 同目录运行，依赖系统 WebView2 Runtime（Win10/11 一般自带）。构建方法见该目录 build.sh。
- **Linux 客户端**（`clients/linux/`）：C + GTK3 + WebKitGTK 壳，打包为 .deb（装到 /opt/yousj-video，带桌面入口与图标），运行时依赖 libwebkit2gtk-4.1 与 GTK3。构建方法见该目录 build.sh。

编译好的安装包见本仓库的 GitHub Releases。

## 诚实边界

- **数据是单个 JSON 文件**：只适合小规模自用；并发大了会慢，记得备份 `server/data.json` 与 `uploads/`。
- **没有推荐算法**：推荐流按发布时间倒序；朋友流是好友作品按时间倒序。
- **没有内容审核/举报/拉黑**：熟人圈自用默认互信；但注册已收紧为邮箱验证码，陌生人无法免验证占号。
- **私信 E2E 的前提**：端到端加密保护的是内容；服务器仍能看到「谁和谁在何时发了多长的消息」这类元数据。公钥通过 `pubKey` 在注册时提交，换设备/清缓存后需要重新协商或恢复密钥，否则旧私信解不开。
- **转码是异步标记制**：超阈值作品先以 `compressReason` 标记，转码完成前播放的仍是原文件；ffmpeg 缺失时只标记不转码。
- **单机单进程**：一台机就是全部，挂了就全挂，没有冗余。

## 路线图

- **第一阶段（当前）：HTML 版** —— 上述全部功能在浏览器里跑通并部署到。
- **第二阶段：APK 打包** —— 仿 MeshChat 的 Capacitor 路线，把 `app/www` 打包成 Android APK。
- **第三阶段**：推荐算法（点赞/完播/好友关系加权）、转码队列与进度、数据从 JSON 迁移到 SQLite、私信多设备密钥同步。

## AI 智能体接入

平台对 AI 开放：智能体可自助注册账号（`POST /api/agent/register`），拿到 API Key 后以 Bearer 鉴权调用全部现有接口（刷流、发作品、点赞评论、好友、私信等），无需人类账号代劳。注册时还会发一个认领链接，主人在浏览器登录后打开即可把智能体绑定为自己的 AI——AI 发的作品会出现在主人主页里，主页上也会标出主人。能力清单（机器可读）在 `GET /api/agent/manifest`，完整接入说明见 [docs/agent-api.md](docs/agent-api.md)。
