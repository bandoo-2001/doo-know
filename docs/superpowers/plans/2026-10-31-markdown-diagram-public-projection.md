# 图形公开投影与旧白板资源适配 Implementation Plan

父计划 Task5A，依据已批准的 `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`。整体目标继续执行七阶段；这不是缩减后的替代方案。

## Global Constraints

- 只改隔离工作树，测试临时知识库；不部署、不迁移真实资料，不改原工作目录。
- 服务器不渲染图形；没有固定版本 PNG 时返回可识别的待准备状态，绝不公开原件作为替代。
- 主 Markdown、原生源、公开投影必须独立；公开默认只读。仅隐藏 HTML 链接不构成权限隔离。
- 私有原文/opaque 下载保持原协议；常规 Markdown 分享编辑保持兼容。

## Task 1: 统一旧白板解析与公开能力

**Owned files:** `packages/core/knowledge/diagram-resource-resolver.ts`、新 `packages/core/knowledge/legacy-diagram-previews.ts` 与相应 additive schema、`apps/server/knowledge/diagram-routes.ts`；`packages/core/shares.ts`、`share-policy.ts`、`share-resources.ts`、新公开投影/分页模块、`assets.ts`、`apps/server/app.ts`、`apps/server/knowledge/web-routes.ts`、`snapshots.ts`（仅 share raw 防护）、`shared/share-contracts.ts`、必要 MCP share schema，测试与协议文档。可改 blog primary capture 的新语义分支，但不要重构旧图块发布逻辑。父执行者同时负责所有 web 编辑器、draft/session、knowledge-markdown 隐藏 token；不修改这些。

**Stable interfaces for parent UI:**

- owner `GET /api/notes/:id/diagram` 同时解析旧 `.excalidraw` 与新主 Markdown，返回现有 `DiagramResource`；legacy `documentHash`/`source.hash` 都按精确旧文件字节，`source.content` 是 JSON，默认可编辑仍按当前权限/支持版本判断；允许没有 preview。
- legacy owner `POST /api/notes/:id/diagram/legacy-preview`，输入 `{expectedDocumentHash,expectedSourceHash,pngBase64,renderer,config,requestId}`，固定真实旧文件、标题、renderer/config 的渲染指纹；上传不可变 PNG，登记同一版本预览后返回 `DiagramResource`。不创建新主文件、不改源、不把 preview-only 当作迁移。新主文档继续既有 prepare/commit。与 primary 白板相同 renderer 版本；客户端用当前 source 快照生成 PNG。
- 分享选项/状态/公开 access 增加 `allowDiagramSource?:boolean`（默认 false，持久化，修改由 owner 操作）。新主图/旧白板永远公开只读，显式 grant 仅开放原件能力。旧普通 Markdown 分享编辑保持既有行为。
- public `/api/public/shares/:token/whiteboards/:reference` 保留 URL，但返回安全 `DiagramResource` 视图：无 grant 时 `source` 仅有 format/hash、canEdit=false、canDownloadSource=false；PNG 用 preview.path，前端通过此 share 的 `/asset?source=...` 取图。显式 grant 可提供原件，但每次当前 share/reference/角色校验。支持旧 UUID/路径以及指向新 Markdown 白板的同一身份引用。

- public `GET /api/public/shares/:token/diagram` 返回分享主图（含三种新类型及旧白板）的相同安全 DTO。需要原件时 UI 可在 `allowDiagramSource` 为真后读取该 DTO 的 source/content；可增独立 attachment 下载 route，但不能借用只允许公开编辑的 `/source` 或把 grant 当作 edit 权限。公开普通 Markdown body 不暴露内部 schema/配置。

**Implementation requirements:**

- [ ] RED 真正 HTTP 测试：新三类型和旧白板默认无场景/大纲/Mermaid/隐藏文字泄露，公开只读；主正文、源 GET、分段读取、附件 ID 与 source 两入口、旧 whiteboard 资源 URL 均受同一能力约束。伪造路径/类型数据库缓存不能升级权限；撤销/到期/收紧 grant 后旧 cursor/asset/source 也拒绝。
- [ ] legacy preview 使用持久的固定资源清单/摘要和 actor requestId 幂等，不依赖浏览器现场、不从 JSON 猜 PNG。PNG 缺失/变化与源变更报告 stale/missing，legacy 原件私有双读继续可用。
- [ ] 主图公开 Markdown 用 parser 的真实范围移除声明、受管区域及摘要，保留标题和用户说明、替换为固定 PNG。白板派生摘要可能含隐藏/低透明元素，不能公开该自动文本。脑图/流程图权威源码也不默认公开。重复链接到原件不能扩大能力，附件授权按角色、固定资源版本与语义能力决定。
- [ ] 常规 Markdown 的 embedded 白板必须公开 PNG 资源；无可用 PNG 返回结构化 DIAGRAM_PREVIEW_REQUIRED，不回传 JSON。已准备旧绑定 PNG 可在完整 source/code/binding 校验下复用；不可把任意 PNG 重绑到变化的源。完整 parent 分享本身不授予其他不相关文档读取。
- [ ] 公开分页基于投影快照，签名 cursor 绑定 grant/主文档/源/PNG 版本及 channel，每页重鉴权；不能复用 raw-owner snapshot。底层 snapshotService 对 share 主体直接请求原件拒绝，常规普通 Markdown 分页不受影响。可新增独立投影分页服务，复用现有预算/签名与过期机制；不要让 raw 与 public source_key 混淆。
- [ ] 发布/博客新 primary 分支消费同一解析和固定预览证明，冻结允许公开的 PNG+说明；源/标题/config/PNG 变化时 BLOG_PREVIEW_REQUIRED，即使没有 fenced 图块也不能跳过。当前 blog frozen resources 不保存源附件。旧图块逻辑保留；Task14 最终贯通另有全量审阅。
- [ ] source grant 的 UI checkbox 由父执行者负责；公开 UI 无 source grant 不展示源码/原件动作。公开资源 schema/path 若需变化先告知父执行者。
- [ ] 新真实入口测试以及旧 shares/share-options/shares-permissions-security/blog-security/blog-core 回归（旧 raw JSON 公共断言须明确改为符合批准安全目标的行为），不改无关验收。测试只用临时数据，TDD，self-review，显式 owned 文件提交，写报告。

全量长套件由父执行者在阶段2冻结后统一运行；不要边父编辑边跑全量。报告所有未完成及明确接口成本，不以部分通过宣称整个阶段完成。不得再分派子代理。
