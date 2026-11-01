# Markdown 图形文档格式 v1

实现依据为 `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`。本文件冻结阶段 1 格式；不是已上线或迁移完成的说明。

主文件使用 UTF-8 Markdown。允许 BOM、已有 YAML frontmatter、LF 或 CRLF。frontmatter 后第一个顶层块为一条独立 HTML 注释：

```text
<!-- dooknow:document {"version":1,"type":"whiteboard","engine":"excalidraw"} -->
```

`type` 与 `engine` 对应为 whiteboard/excalidraw、mindmap/mind-elixir、flowchart/mermaid。一个独立一级标题位于主图区域之前，作为根标题。主图使用两个独立顶层注释包围：`<!-- dooknow:primary:start -->` 和 `<!-- dooknow:primary:end -->`。注释与正文块用空行分隔；不在列表、引用、代码块里识别标记。无类型标记按普通 Markdown 处理；未知类型/版本、冲突标记、缺失区域或无效受管内容进入源码恢复，绝不自动格式化。

白板区域包含一个指向相对路径 `.excalidraw` 场景的标准链接、一个 PNG 图片、一条主图绑定及可读文字摘要。摘要以标准 `text` fenced 代码块保存，选择不会与文字冲突的围栏，保留空行、缩进和原文字节；它是绑定场景摘要的派生检索文本，不是权威 JSON 源。脑图区域包含普通无序嵌套列表（根标题为根节点，无子节点时列表可为空）、一个 PNG 图片及绑定；具体文本大纲子集由同阶段的适配器验证。流程图区域包含一个闭合的 Mermaid 代码块、一个 PNG 图片和绑定。资源路径无协议、无主机绝对路径；允许按文档目录解析的相对跨目录引用，服务端仍必须验证范围及权限。

主图绑定使用独立注释，与旧内嵌图的 `dooknow:diagram-preview v1` 区分：

```text
<!-- dooknow:primary-binding {"version":1,"sourceHash":"<64位小写sha256>","renderHash":"<64位小写sha256>","previewHash":"<64位小写sha256>"} -->
```

三份完整结构样例位于 `tests/fixtures/diagram-documents/`。其相对附件名及重复字符摘要是格式测试占位，不代表可发布的匹配资源。

- 主文件并发版本：完整主文件原始 UTF-8 字节的 SHA-256。
- `sourceHash`：权威源的原始 UTF-8 字节 SHA-256，不规范化换行、不增删空格。白板为附件原字节；脑图为受管列表原字节（根标题另入渲染指纹）；流程图为 fence 内原字节。
- `renderHash`：以版本 1、类型、源摘要、根标题、renderer 精确版本和 config 为 JSON 的 SHA-256；对象键递归排序，数组保序。派生 PNG 路径、PNG 摘要、绑定注释、主文件摘要均不进入指纹，避免自引用。
- `previewHash`：实际 PNG 字节 SHA-256。完整提交检查资源存在、原字节摘要、渲染指纹和准备回执，结构解析不代替此检查。

已知字段经 schema 验证，未知 JSON 字段保留；写回元数据时 JSON 中 `<`、`>` 转义，防止提前结束注释。替换主图只改两个边界之间的范围，保留 frontmatter、文档标记未知字段、边界和说明区原字节。专用视图不能写回未知格式；移除类型是显式转换操作。

字符范围使用 JavaScript UTF-16 索引，指向原文；索引引用服务必须另计算真实 UTF-8 字节及行号，不能直接把字符索引当字节偏移。CRLF 与中文覆盖测试保证不会拿 Markdown 解析器规范化后的字符串切原文。
