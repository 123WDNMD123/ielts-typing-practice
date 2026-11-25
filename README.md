# 雅思打字练习 · IELTS Typing Practice

面向雅思备考与课堂打字教学的**零依赖** Web 应用：用真实雅思语料练指法，实时统计 WPM 与准确率，成绩按账号归档，教师可查看全班进度并导出记录。

后端只用 Python 标准库（`http.server` + `sqlite3`），前端是单文件 HTML（内联 CSS/JS，无构建步骤、无 CDN、无第三方运行时依赖）。一台装好 Python 3 的机器即可跑起来。

- **在线体验**：<http://47.120.61.237:8000/>
- **技术栈**：Python 3 标准库 · SQLite · 原生 HTML/CSS/JS（Web Animations API / Canvas / WebAudio）
- **当前发布版本**：`v2026.11.25-dolly`

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [配置说明](#配置说明)
- [HTTP API](#http-api)
- [数据模型](#数据模型)
- [安全设计](#安全设计)
- [性能约束](#性能约束)
- [生产部署与回滚](#生产部署与回滚)
- [版本记录](#版本记录)
- [已知限制](#已知限制)

---

## 功能特性

### 练习与语料

| 模块 | 说明 |
| --- | --- |
| 日常练习 | 词汇练习（8 个主题分类，10/20/30/50 词可选）＋ 每日一句（可换句、可朗读）＋ 推荐学习路径 |
| 速度测试 | 30 秒 / 1 / 2 / 3 分钟，素材可选阅读文章、听力原文或随机；**按下第一键才开始计时** |
| 分级课程 | 初级单字（547 个学术高频词）→ 中级词组（176 个固定搭配）→ 高级篇章（32 篇：23 篇阅读 + 9 篇听力原文） |
| 雅思语料 | 64 条可迁移表达，分写作观点 / 口语表达 / 同义替换 / 听力细节四类，支持关键词搜索与一键开练 |
| 生词本 | 收藏随账号云端同步，换设备不丢；支持搜索、清空 |
| 键盘指法提示 | 实时高亮「下一个应按的键」 |

内置词表含 1053 个带音标与中文释义的词条，全部素材内嵌在前端文件中，离线可用。

### 打字体验

- **两段式专注模式**：选定项目进入半专注（侧栏滑出、页头淡出），敲下第一键进入全屏；`Esc` 或退出钮逐级降级，切换页面、完成练习或重置时自动退出。
- **一镜到底的镜头过渡**：三档（正常 / 半专注 / 全屏）之间由单一 rAF 时钟驱动，卡片外框 `left/top/width/height` 全程连续插值，页头、键盘、辅助信息同拍淡入淡出，落定瞬间零几何突跳；不使用整卡 `scale`，文字字号恒定、无拉伸畸变。飞行中再次切换会从当前视觉状态续接，不重新起跳。
- **实时 WPM 曲线**：Canvas 采样绘制，约 1 秒一个点（上限 240 点），页面不可见时自动暂停。
- **按键音效**：WebAudio 实时合成，三种风格（柔和 / 机械 / 打字机），错键低音、退格与完成音区分，默认开启柔和档。
- **成绩分享卡**：Canvas 生成 1200×675 PNG，含 WPM、准确率、用时、昵称与连续打卡天数，可下载。
- **计分口径**：退格不重复计数，正确字符数与 WPM 均以净输入计算；服务端拒绝空成绩入库。
- **连续打卡**：按北京时间统计，单日正确字符 ≥100 记为完成一天，返回当前/最佳连续天数。

### 个性化

- **统一设置菜单**：侧栏单一「设置」入口，内部分「外观 / 账号」两段。外观段集中主题色、深浅模式、动效三档、按键音效；账号段集中账号信息、修改昵称、修改密码与登录状态（退出登录）。记住上次所在分段；未登录时账号段自动隐藏并降级到外观段。
- **主题色**：6 个预设 ＋ 自定义取色器，按 HSL 派生整套变量；浅色主色自动压暗，保证按钮文字对比度 ≥ 4.5:1。
- **深浅模式**：深色基底随主题色自动派生近黑色阶（饱和度 5–12%、亮度 5–19%），换色时深色背景自动协调。
- **动效三档**：完整 / 精简 / 关闭；系统 `prefers-reduced-motion` 强制关闭。
- **偏好跨设备同步**：主题色、深浅、动效、音效及风格、忽略大小写、自动朗读等写入服务端 `prefs` 表；本机 `localStorage` 仅作首屏防闪烁缓存。写入空串表示「恢复默认」，会删除服务端行并传播到其他设备。

### 账号与课堂管理

- **学生自助**：注册 / 登录 / 退出，修改昵称、修改密码（改密后踢掉其他会话，当前浏览器换发新 Cookie）；以上操作统一收在「设置 → 账号」分段内。
- **教师后台**：创建学生账号、重置密码、启用/停用、查看全班总览与最近动态、导出全部成绩 CSV。
- **数据隔离**：学生只能读写自己的成绩；教师账号不开放网络注册，需在服务器上用 `create_teacher()` 初始化。
- **允许同名学生**：`username` 唯一，`display_name` 可重复，教师视图同时展示账号以区分。

---

## 快速开始

### 环境要求

- Python **3.11+**（推荐；代码兼容 3.6，但生产使用 3.11）
- 无需 `pip install`，无 Node.js / 构建工具依赖

### 本地运行

```bash
cd server-source

# 后端从自身所在目录读取 public/index.html，先准备静态目录
mkdir -p public
cp index.server.html public/index.html

# 启动（默认 8000 端口，可传参改端口）
python3 server.py 8000
```

打开 <http://localhost:8000/>。首次启动会在 `server-source/` 下自动创建 `data.db` 并建表。

> Windows 上把 `python3` 换成 `python`，`cp` 换成 `copy`。
> 学生从局域网访问时，用 `http://<本机IP>:8000/`，并确保防火墙放行该端口。

### 初始化教师账号

教师角色不开放注册，在服务器上执行：

```bash
cd /path/to/server-source
python3 -c "import server; server.init_db(); server.create_teacher('teacher01', 'ChangeMe-2026!', '王老师')"
```

账号需 3–20 位字母/数字/`.`/`_`/`-`，密码 8–128 位，姓名 1–20 位中文或字母数字（不含引号等符号）。

---

## 项目结构

```
.
├── README.md
├── server-source/
│   ├── server.py                 # 后端：HTTP 服务 + API + SQLite（零依赖）
│   ├── index.server.html         # 权威前端单文件（线上部署名 index.html）
│   ├── index.html                # 旧版前端，仅作历史基线，不用于生产
│   ├── update-typing.server.sh   # 生产发布脚本：备份 → 原子替换 → 重启 → 健康检查 → 失败回滚
│   └── 更新部署.sh                # 旧版简易重启脚本（历史保留）
└── typing-practice-release-*.tar.gz   # 历次发布归档（仅三份源码，不含数据库）
```

运行时产物 `data.db`、`__pycache__/`、含真实学生姓名的截图目录均已在 `.gitignore` 中排除，不入库。

---

## 配置说明

| 项 | 位置 | 默认值 |
| --- | --- | --- |
| 监听端口 | `python3 server.py <port>` | `8000`，绑定 `0.0.0.0` |
| 数据库路径 | `server.py` 中 `DB` | 脚本同目录 `data.db` |
| 静态目录 | `server.py` 中 `PUBLIC` | 脚本同目录 `public/` |
| 会话有效期 | `SESSION_SECONDS` | 7 天 |
| 密码哈希轮数 | `PBKDF2_ITERATIONS` | 200000 |
| 登录失败限流 | `LOGIN_FAIL_LIMIT` / `WINDOW` / `LOCK_SECONDS` | 10 分钟内失败 6 次锁定 10 分钟 |

偏好项白名单见 `server.py` 的 `PREF_VALIDATORS`，新增偏好必须同时在后端白名单和前端 `PREF_KEYS` 中登记，否则会被拒绝。

---

## HTTP API

所有接口返回 JSON（导出接口返回 CSV），错误形如 `{"error": "..."}` 并带相应状态码。会话通过 `typing_session` Cookie 传递，未登录访问受保护接口返回 `401`。

### 认证与账号

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 学生注册并自动登录；仅当该姓名此前没有账号时，才继承未关联的历史成绩（避免同名学生互相认领） |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出并清除会话 |
| GET | `/api/auth/me` | 当前登录用户（未登录返回 `{"user": null}`） |
| POST | `/api/auth/profile` | 修改自己的昵称 |
| POST | `/api/auth/password` | 修改密码（校验旧密码，成功后换发会话） |

### 练习数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/records?scope=mine&limit=200` | 自己的成绩与统计；`scope=class` 仅教师可用 |
| POST | `/api/records` | 提交一次成绩（`chars`/`wpm` 必须 > 0） |
| DELETE | `/api/records` | 清空**当前账号**的成绩，不接受任何查询参数 |
| GET | `/api/streak` | 连续打卡：当前/最佳天数、今日正确字符数、今日是否达标 |
| GET | `/api/favs` · POST `/api/favs` | 生词本读取 / 增删（`{"clear": true}` 清空） |
| GET | `/api/prefs` · POST `/api/prefs` | 偏好读取 / 写入（白名单校验，空串＝恢复默认） |

### 教师后台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary` | 全班学生总览（次数、最佳/平均 WPM、平均准确率、最近练习） |
| GET | `/api/admin/students` | 学生账号列表 |
| POST | `/api/admin/students` | 创建学生账号 |
| POST | `/api/admin/students/{id}/password` | 重置指定学生密码 |
| POST | `/api/admin/students/{id}/toggle` | 启用 / 停用账号 |
| GET | `/api/admin/export` | 导出全部成绩为 `typing-records.csv` |

静态资源支持 `gzip`、`ETag`/`304` 与 `HEAD`；`/api/*` 的 `HEAD` 返回 `405`。

---

## 数据模型

启动时 `init_db()` 幂等建表，并对旧库做增量迁移（补列、去约束、清理脏数据），**不会覆盖已有数据**。

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `users` | 账号 | `username` 唯一（NOCASE）；`role` ∈ student/teacher；`disabled` 停用标记 |
| `sessions` | 会话 | 只存 token 的 SHA-256 摘要，过期即清理 |
| `records` | 成绩 | 按 `user_id` 归属，索引 `(user_id, t)` |
| `favorites` | 生词本 | 主键 `(user_id, word)` |
| `prefs` | 个性化偏好 | 主键 `(user_id, key)`，值经白名单校验 |

---

## 安全设计

- 密码 **PBKDF2-HMAC-SHA256 / 200000 轮 / 16 字节随机盐**，比对使用 `hmac.compare_digest`。
- 会话 token 由 `secrets` 生成，数据库只存摘要；改密与教师重置密码会失效该用户全部会话。
- 登录/注册失败按 `IP + 账号` 限流，缓解在线爆破。
- 姓名与账号字符白名单校验，杜绝可注入字符进入教师视图。
- 响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Cross-Origin-Opener-Policy: same-origin`。
- CSP 禁止外域脚本与数据外发（`default-src 'self'`、`connect-src 'self'`、`frame-ancestors 'none'`）；页面无外部资源，脚本样式均内联。
- 静态文件路径经 `realpath` 归一并限定在 `public/` 内，防目录穿越。

---

## 性能约束

前端视效层遵循以下红线（源自一次整站 18.7fps → 60fps 的实测修复）：

- 大尺寸常驻动画元素**不使用 `blur` 滤镜**，柔光直接用径向渐变实现；
- 常驻动画只动 `transform: translate`，配合 `will-change: transform` 提升为合成层；
- `backdrop-filter` 不与常驻动画同屏；
- 页面不可见时暂停背景动画与曲线采样；动效「关闭」档与 `prefers-reduced-motion` 下全部动画停用。

镜头过渡（focusDolly）另有两条来自 CDP tracing 实测的约束：

- **逐帧改外框尺寸的代价在 Paint 而非 Layout**。实测 Layout 均 0.70ms/帧，Paint 均 6.83ms/帧——整卡（约 500 字符 + 背景 + 阴影）每帧重绘。把卡片与文本区各自 `translateZ(0)` 提层后 Paint 降至 2.73ms（−60%）。`will-change` **只列 `transform`/`opacity`**：`left/top/width/height` 不可合成，列上去反而强制重绘。
- **文本区内容宽度钉死**：飞行期间文本区改为 `content-box` 并锁定起点内容盒宽，宽度插值不触发长文重新换行，从而「既连续又满帧」。

> 反面教训：为保帧率而冻结内部布局，会把几何突跳挪到落定瞬间（实测残留 94–198px 宽 / 72–213px 高），本质上仍是「第二次起跳」。因此**落定突跳必须单独量测**，只断言飞行帧会漏判。

本地实测（Edge headless，rAF 帧间隔采样 + longtask 观测）：空闲、半专注、全屏打字、分享弹窗、动效关闭五种场景均 ≈60fps，p95 帧间隔 ≤16.8ms，零长任务；五段镜头飞行 55–62fps，四段落定突跳 `dw=0 / dh=0`。生产站点真实浏览器复测同样达标。

---

## 生产部署与回滚

生产以 systemd 服务 `typing-practice.service` 运行，应用目录 `/root/typing-server`，解释器 `/usr/bin/python3.11`。

发布包只包含三份源码（`server.py`、`index.server.html`、`update-typing.server.sh`），**绝不携带数据库**。

```bash
# 1. 本地打包
tar -czf typing-practice-release-YYYYMMDD.tar.gz \
  -C server-source server.py index.server.html update-typing.server.sh

# 2. 传到服务器独立暂存目录并校验哈希
sha256sum /root/typing-release-xxxx/*

# 3. 在维护窗口执行发布（root）
bash /root/typing-release-xxxx/update-typing.server.sh \
  /root/typing-release-xxxx /usr/bin/python3.11
```

发布脚本的行为：

1. 校验暂存文件齐全、Python 版本合法、源码可编译、服务当前处于运行态；
2. 备份现有 `server.py`、`index.html`、systemd 覆盖配置，并对生产库做**在线 SQLite 快照**（`sqlite3.backup`，不中断服务、不覆盖生产库）；
3. 在目标目录内暂存新文件后 `mv` **原子替换**，避免服务读到半个文件；
4. `daemon-reload` + 重启，随后健康检查：首页内容逐字节比对、`gzip` 生效、服务 active、解释器路径正确；
5. 任一步失败触发 `trap` **自动回滚**代码与配置并重启，再做一次健康检查。

备份目录形如 `/root/typing-backup/typing-opt-XXXXXXXX`。手动回滚即把该目录下的 `rollback-server.py` / `rollback-index.html` 覆盖回应用目录并重启服务。

发布后建议复验：公网 `GET`/`HEAD` 状态与内容哈希、`gzip` 压缩、`ETag` 304、访客接口，以及一次真实浏览器登录练习冒烟。

---

## 版本记录

每次生产发布对应一个 Git 标签与一份发布归档。

| 标签 | 内容 |
| --- | --- |
| `v2026.11.25-dolly` | 专注过渡重做为一镜到底（外框连续插值 + 合成层 + 文本宽度钉死，落定零突跳）＋ 统一设置菜单（外观/账号两段）＋ 修复对话框层叠导致的 Esc 误关 |
| `v2026.11.25-batcha` | 偏好后端同步 + 两段式专注 + 实时 WPM 曲线 + 按键音效 + 成绩分享卡 + 连续打卡接口 |
| `v2026.11.25-perf` | 修复视效层导致的整站卡顿（去 blur / 去 backdrop-filter / 纯 translate） |
| `v2026.11.25-ambience` | 动态背景光斑、噪点、卡片辉光、标题流光等高级感视效 |
| `v2026.11.25-account` | 账号管理入口（改名/改密码）+ 深色自动配色 + 无后端友好提示 |
| `v2026.11.25-motion` | 动画系统：练习手感、完成庆祝、页面转场，三档开关 |
| `v2026.11.25-studio` | IELTS Type Studio 前端重写 + 主题色 + 外观设置抽屉 |
| `v2026.11.25-opt` | 换句/退格计分/换轮隔离等缺陷修复，成绩按账号隔离，gzip/ETag，发布脚本与回滚 |

```bash
git tag -l                 # 查看全部发布标签
git show v2026.11.25-dolly --stat
```

---

## 已知限制

- **未启用 HTTPS**：当前按明确决定保持 HTTP，公网传输不加密，请勿在演示环境使用真实敏感密码。
- **单机 SQLite**：适合课堂规模（数十人并发），未做分布式或读写分离。
- **无外部依赖即无框架能力**：没有 ORM、模板引擎与前端构建链，改动直接编辑源码文件。
- **教师账号需服务器初始化**，不能通过网页注册。
- 仓库为公开仓库，**不包含任何真实账号、成绩数据或含学生姓名的截图**；`data.db` 与 `shots/` 已被忽略规则排除。
