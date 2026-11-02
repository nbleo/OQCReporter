# OQCRporter

**淋浴房 OQC 检验报告 · 手机/电脑录入 → PDF → 私有仓库备份**

线上地址：<https://nbleo.github.io/OQCRporter/>

---

## 这是什么

把纸质的 OQC Checklist 变成手机上能直接按的录入表：23 个检验项逐项判 `i.O. / n.i.O. / n/a`，n.i.O. 写原因，每项随手拍照，最后生成排版好的 A4 检验报告（浏览器打印 → 另存为 PDF，文字是矢量的）。

- **手机优先**：相机/相册直拍，照片自动纠正方向、压到长边 1600px
- **离线可用**：装到主屏后断网也能录（PWA + IndexedDB）
- **报告**：9 组 / 23 项判定表 + 照片页 + 签名，按内容自动分页
- **数据归自己**：录的内容留在本机；需要跨设备/防丢时，同步到**你自己的私有 GitHub 仓库**

## 架构：公开程序仓 + 私有数据仓

```
nbleo/OQCRporter   (public)   ← 只放程序，GitHub Pages 部署
  └─ app/                      index.html / sync.js / sw.js / manifest / icons

<你>/<你的私有仓库>  (private)  ← 只放数据，别人看不到
  └─ users/<你的登录名>/oqc/
       ├─ manifest.json                索引：记录清单、照片清单、删除墓碑
       ├─ records/<记录id>.json         单张检验单
       └─ photos/<记录id>/<照片id>.jpg   照片原图
```

每个用户在 App 里绑定**自己的**私有仓库和**自己的** GitHub 令牌，互不影响；公开仓里从来没有任何业务数据。

同步细节（与 [FairRecorder](https://github.com/nbleo/fair_recorder) 同一套做法）：

| 项 | 做法 |
|---|---|
| 写仓库 | Git Data API `blob → tree → commit → patch ref`（Contents API 单文件 1 MB，装不下照片） |
| 增量 | 记录按 `updatedAt` 判断；照片看远端 tree 里是否已有该路径，有就跳过 |
| 冲突 | `PATCH ref` 遇 422 就重读 ref、重建 tree/commit 重试，最多 4 次 |
| 合并 | 后写者胜、只升不降：远端比本地新才覆盖本地 |
| 删除 | 写墓碑 `deletedAt`，别的设备拉到后删本地副本 |
| 加密 | 可选 AES-GCM-256 / PBKDF2-SHA256 10 万轮；口令只在内存，不存盘 |

## 用起来（3 步）

1. **建私有仓库**：GitHub → New repository → 名字随意（如 `oqc-data`）→ 选 **Private** → 勾 Add README
2. **建令牌**：Settings → Developer settings → Personal access tokens → Fine-grained tokens → 只勾这一个仓库的 **Contents: Read and write**
3. **绑定**：手机打开 <https://nbleo.github.io/OQCRporter/> → 右上角 ☁ → 填 owner / 仓库名 / 令牌 → 保存配置 → 测试连接 → 双向同步

详见 [部署说明.md](部署说明.md)（含手机装到主屏、多设备共用、忘记口令等）。

## 本地开发

```bash
# 任意静态服务器都行，必须走 http://（file:// 下浏览器不给存照片）
cd app && python -m http.server 8000
# 打开 http://localhost:8000/index.html
```

调试入口（贴在地址后）：

| 参数 | 作用 |
|---|---|
| `?demo=1` | 填一份演示数据（含 n.i.O. 原因示例） |
| `?selftest=1` | 自检：打包 → 导入 → 读回照片/签名/原因 |
| `?print=1` | 直接生成打印视图 |

改了 `app/` 里的文件，记得把 `app/sw.js` 的 `CACHE` 版本号加一，否则手机还吃旧缓存。

## 目录

```
app/index.html            录入 + 报告（单文件，零外部依赖）
app/sync.js               云备份：私有仓库同步 + 加密
app/sw.js                 离线缓存
app/manifest.webmanifest  PWA 清单
.github/workflows/pages.yml  Pages 部署（上传 app/ 目录）
```

## 说明

- 模板按 Schulte OQC Checklist 的 Real 编号编排（`1.1.1` ~ `1.1.9`，23 项）。改检验项改 `index.html` 里的 `TPL.sections`。
- 令牌存在手机浏览器的 localStorage 里，只对当前设备生效；手机借人前请先在弹层里清掉。
- 记录里没有照片时报告不会出现空框；整组没拍照，该组照片段整段不出现。
