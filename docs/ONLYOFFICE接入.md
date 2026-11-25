# ONLYOFFICE 接入与局域网使用

DooKnow 可连接自托管的 ONLYOFFICE Docs Community。完成配置后，在「应用 → 办公文档」上传 `.docx`、`.xlsx`、`.pptx` 或 `.pdf` 并打开编辑，单个文件上限为 10 MiB。用编辑器的保存按钮或 `Ctrl+S` 保存，返回文件列表后可查看更新时间，也可下载同一份文件检查修改。

PDF 打开后，先点工具栏的「编辑 PDF」。要修改文件已有的正文，再点「编辑文本」并选择页面上的文字。 [ONLYOFFICE PDF 编辑说明](https://helpcenter.onlyoffice.com/docs/userguides/pdf-editor/basic-operations/edit-pdf)

## 服务和地址

在局域网部署独立的 ONLYOFFICE Docs 服务。按其 [Community Docker 安装说明](https://helpcenter.onlyoffice.com/docs/installation/community/docker/installing/install) 准备镜像，保留 JWT 校验，配置 `JWT_SECRET`。若 DooKnow 地址是私网 IP，Document Server 需要允许访问该地址。官方镜像用 `ALLOW_PRIVATE_IP_ADDRESS=true` 开启私网访问，可用容器网络或防火墙把编辑服务的访问范围限制到实际需要的主机。

为 DooKnow 进程设置以下变量。地址示例中的主机名和端口应替换成你的实际值。使用 HTTPS 访问 DooKnow 时，浏览器加载的编辑器地址也应使用 HTTPS。

| 变量 | 用途 |
| --- | --- |
| `DOOKNOW_ONLYOFFICE_URL` | 浏览器访问 Document Server 的地址，例如 `http://office.lan:8081`。设置后启用办公文档入口。 |
| `DOOKNOW_ONLYOFFICE_INTERNAL_URL` | DooKnow 下载编辑结果时访问 Document Server 的地址，默认取浏览器地址。 |
| `DOOKNOW_ONLYOFFICE_APP_URL` | Document Server 下载文件和回调保存时访问 DooKnow 的地址，默认取 `APP_ORIGIN`。容器中的 `localhost` 指向容器自身。 |
| `DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE` | 保存与 Document Server 一致的 JWT 密钥的文件路径。密钥至少 32 字节，文件使用 `0600` 权限。也可通过 `DOOKNOW_ONLYOFFICE_JWT_SECRET` 注入同一密钥。 |

DooKnow 由 systemd 用户服务启动时，可为当前实例的服务添加 `EnvironmentFile`，把上述变量放入该文件，然后重启该实例。将密钥文件放在源码和知识库之外。按 [ONLYOFFICE 保存回调说明](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler)，两项服务都在线时，编辑结果才能写回 DooKnow。

## 文件位置和恢复

上传的文件保存在绑定知识库的 `_doo-data/apps/onlyoffice/documents/`。每份文档使用稳定 ID，保存会更新该 ID 对应的原格式文件。之前保存的 Word 文件可以继续打开。完整知识库备份可包含这些文件和文件名等元数据。迁移时随知识库复制该目录，并在目标实例加载相应的服务配置。

## 断外网验收

先取得运行所需的镜像和依赖。保持浏览器、DooKnow 和 Document Server 的局域网互通，再在没有公网出口的环境验证以下流程。

1. 从局域网地址打开 DooKnow，在「应用 → 办公文档」上传待验证的文件。
2. 打开文档，修改一处容易辨认的内容，然后点击保存。
3. 回到列表，重新打开同一份文件并核对内容，再下载原格式文件复核。

实际验收使用 ONLYOFFICE Docs Community `10.0.0-169` 和 Chromium，浏览器与服务位于两个仅通过私有链路互通的网络命名空间。两个环境均无 IPv4 或 IPv6 公网默认路由，浏览器直连公网地址失败。每种文件均通过 DooKnow 打开、编辑和保存，关闭首个编辑会话后重新打开核对修改。下载内容与知识库中的同一 ID、同一路径的原格式文件一致。

| 格式 | 编辑后重开核对的内容 |
| --- | --- |
| `.docx` | 新增的一段正文。 |
| `.xlsx` | 更改的单元格数值及引用它的原公式。 |
| `.pptx` | 幻灯片文本框中的新增文字。 |
| `.pdf` | 编辑已有正文后写入的新文字。 |

PDF 样张重新打开后，新文字仍在，编辑区域的换行和字距出现了变化。此次验证覆盖原格式写回和重开，PDF 版式保真需要按实际文件核对。

## 在 ChatGPT 里检索办公文档

DooKnow 在本机提取办公文档的可读文字，按 Word 章节、Excel 工作表、PPT 幻灯片和 PDF 页建立全文索引。上传、编辑器保存以及已有文档扫描会更新索引。原格式文件和文件 ID 用于来源链接，索引可以从这些原件重建。PDF 优先使用每一页已有的文字层，提取不到正文的页会尝试本地 OCR。

使用 MCP 2.0.5 的 `search` 和 `fetch` 可搜索正文、读取匹配片段及定位信息。MCP 服务和对应客户端都应授权读取「整个知识库」。配置 MCP 的外部 Web 地址后，结果会附上原文件下载链接，在浏览器登录 DooKnow 即可打开。搜索引用绑定当时的文件版本，文档变化后需重新搜索。提取完成后再次查询即可取得新结果。

### 扫描版 PDF 中文 OCR

DooKnow 使用本机 Poppler 渲染单页，再交给 Tesseract 识别，默认使用简体中文和英文。以 Ubuntu 或 Debian 为例，可提前准备以下系统包。安装好程序和语言数据后，识别过程可以在断外网时运行。 [Tesseract 安装和语言数据](https://tesseract-ocr.github.io/tessdoc/Installation)

```sh
sudo apt install poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
```

重启 DooKnow 后会检查本地工具和语言数据，并为需要 OCR 的已有 PDF 更新索引。使用独立安装目录时，可通过 `DOOKNOW_PDF_OCR_PDFTOPPM`、`DOOKNOW_PDF_OCR_TESSERACT`、`DOOKNOW_PDF_OCR_TESSDATA` 指定位置。可通过 `DOOKNOW_PDF_OCR_LANGUAGES` 选择已安装的语言，例如使用 `chi_tra+eng` 识别繁体中文和英文。设 `DOOKNOW_PDF_OCR_ENABLED=0` 关闭 OCR。

单份 PDF 默认最多识别 32 个无字页，处理预算为 90 秒。可用 `DOOKNOW_PDF_OCR_MAX_PAGES` 将页数上限设为 1 到 128。达到处理限制时，已完成的页面会加入索引，MCP 查询会提示 OCR 尚不完整。

PDF 搜索结果保留原始页码。原件链接指向同一份 PDF，并带有 `#page=N`，支持 PDF 页码定位的浏览器可直接跳到命中页。原文件下载入口也可继续使用。

在没有公网路由的验收环境中，用 Poppler 26.01 和 Tesseract 5.5 识别了三页纯图像中文 PDF。MCP 搜索「备用电源检查」返回第 2 页，Chromium 打开来源链接后显示原件第 2 页。
