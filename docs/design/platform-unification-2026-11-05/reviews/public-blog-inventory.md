# Public, authentication, onboarding and blog inventory

Read-only source inventory against `933d63d942b6499fee964f8a060c7b22b9d299d1` in `/home/bandoo/.codex/worktrees/60c5/doo-know`. Only the two assigned design-document paths were written. No application code, image generation, server startup, dependency installation, tests or commits were performed.

Found **60 surfaces**. Every record has route/trigger, concrete source references, fields/actions/guards, states, responsive targets and test source references where identified. All are queued as requiring distinct GPT Image 2 design review; none has image/model verification or approval evidence.

| Module | Surfaces |
| --- | ---: |
| auth | 7 |
| setup | 10 |
| oauth | 4 |
| share | 4 |
| public-edit | 4 |
| blog-owner | 11 |
| studio | 9 |
| blog-public | 11 |

## Route and permission findings

- The Vue application routes public share tokens through `/s/:token` before session boot. Login and `/oauth/consent` are handled in App; owner blogging is workspace query navigation `/?view=apps&app=blog&appSection=overview|articles|taxonomy|settings|design`.
- Public blogs are server-rendered in `apps/server/blog/routes.ts` and `render.ts`: `/blog`, reserved article/collection index routes, post slug, collection detail, about and archive. Legacy `/blog/articles` and `/blog/collections` can resolve old article slugs first.
- Public sharing is a token capability, with no password gate. Invalid, expired, revoked and rotated links deliberately share the same404 message. Public readers and editors must have guest navigation; owner workspace rails would misrepresent authorization.
- Public edit is manual CAS save with anonymous CSRF/same-Origin enforcement, resource restrictions and token rate limits. Conflict, revoked/downgraded authorization, expiry, lost responses and new-resource rejection preserve draft text. Referenced whiteboards remain read-only.
- Blog public content uses immutable manual publication snapshots. Metadata save, source note edit, design draft save and history restore do not publish. Site enablement is another explicit saved setting. Publication rechecks source hash, modification version and article version.
- There is no general offline UI in this domain. Existing request-failure/retry states and in-memory draft retention must be represented accurately.

## Responsive evidence and limits

Review targets are320,390 and1440 CSS pixels for each surface. This pass inspected responsive source only. Public homepage tests explicitly exercise320; a collection-picker phone case uses390; blog admin visual source includes1440. Existing configs also include desktop and iPhone13 projects. None was executed here.

Setup collapses at600; public share/edit at720; owner blog article/taxonomy at860 with compact controls below680/720; design editor/preview stacks at1250 with phone adjustments at760. Embedded preview deliberately preserves1100 or375 internal viewport and scales it into its host. These numbers describe current source, not a new design constraint or verified screenshot result.

## Coverage register

| ID | Surface | Kind | Entry |
| --- | --- | --- | --- |
| PB-001 | 登录 DooKnow | page | `/ (unauthenticated); /login` |
| PB-002 | 首次使用与账号来源帮助 | state | `/; /login` |
| PB-003 | 会话失效重新登录 | dialog | `Any mounted authenticated route` |
| PB-004 | 启动与异步页面加载 | state | `/; /login; /oauth/consent` |
| PB-005 | 无法确认登录状态 | state | `/; /login; /oauth/consent` |
| PB-006 | 已登录但知识库状态无法读取 | state | `/; /login; /oauth/consent` |
| PB-007 | 页面模块无法加载 | state | `/; /login; /oauth/consent; /s/:token` |
| PB-008 | 首次设置：创建知识库 | page | `/ (platform.phase=setup_required)` |
| PB-009 | 首次设置：已有资料目录浏览 | page | `/ (platform.phase=setup_required)` |
| PB-010 | 首次设置：高级位置与时区 | state | `/ (setup required)` |
| PB-011 | 首次设置：从 GitHub/Gitee 导入 | page | `/ (setup required)` |
| PB-012 | 首次设置：选择可选功能 | page | `/ (phase ready; onboarding required; step2)` |
| PB-013 | 首次设置：准备完成 | page | `/ (ready onboarding step3)` |
| PB-014 | 首次设置：导入单个 Markdown | state | `/ (ready onboarding step3)` |
| PB-015 | 首次设置：初始化中 | state | `/ (platform.phase=initializing)` |
| PB-016 | 首次设置：尚无主人账号 | state | `/ (platform.phase=owner_required)` |
| PB-017 | 首次设置：目录不可用或配置冲突 | state | `/ (source_unavailable/configuration_error)` |
| PB-018 | OAuth 连接授权：业务与资源策略 | page | `/oauth/consent?oauth_query=…` |
| PB-019 | OAuth 连接授权：兼容目录与操作列表 | state | `/oauth/consent?oauth_query=…` |
| PB-020 | OAuth 无效/过期与提交失败 | state | `/oauth/consent?oauth_query=…` |
| PB-021 | OAuth 登录后继续授权 | state | `/login?oauth_query=… (or raw signed query)` |
| PB-022 | 公开分享阅读：普通笔记 | page | `/s/:token` |
| PB-023 | 公开分享阅读：大文件片段 | page | `/s/:token` |
| PB-024 | 公开分享：不存在/过期/撤销/轮换 | state | `/s/:token` |
| PB-025 | 公开分享：临时读取失败 | state | `/s/:token` |
| PB-026 | 公开编辑：文档模式 | page | `/s/:token (editing=true)` |
| PB-027 | 公开编辑：Markdown 源码 | page | `/s/:token (editing=true)` |
| PB-028 | 公开编辑：冲突与保存恢复 | state | `/s/:token (editing=true)` |
| PB-029 | 公开编辑：未保存离开/重新加载确认 | dialog | `/s/:token (editing=true)` |
| PB-030 | 博客管理：概览 | page | `/?view=apps&app=blog&appSection=overview` |
| PB-031 | 博客管理：文章列表与筛选 | page | `/?view=apps&app=blog&appSection=articles` |
| PB-032 | 博客管理：文章发布信息 | page | `/?view=apps&app=blog&appSection=articles` |
| PB-033 | 博客管理：选择 Markdown 笔记 | dialog | `/?view=apps&app=blog&appSection=overview|articles|taxonomy|design|settings` |
| PB-034 | 博客文章：附件封面选择 | state | `/?view=apps&app=blog&appSection=articles` |
| PB-035 | 博客图片：裁切与上传 | state | `/?view=apps&app=blog&appSection=design|articles` |
| PB-036 | 博客文章：私有预览与发布前核对 | state | `/?view=apps&app=blog&appSection=articles` |
| PB-037 | 博客文章：下架确认 | dialog | `/?view=apps&app=blog&appSection=articles` |
| PB-038 | 博客文章：移除选稿确认 | dialog | `/?view=apps&app=blog&appSection=articles` |
| PB-039 | 博客管理：分类与标签 | page | `/?view=apps&app=blog&appSection=taxonomy` |
| PB-040 | 博客管理：站点设置 | page | `/?view=apps&app=blog&appSection=settings` |
| PB-041 | 博客装修：主题与个人资料 | page | `/?view=apps&app=blog&appSection=design` |
| PB-042 | 博客装修：首页模块 | page | `/?view=apps&app=blog&appSection=design (modules tab)` |
| PB-043 | 博客装修：专题合集 | page | `/?view=apps&app=blog&appSection=design (collections tab)` |
| PB-044 | 博客装修：导航、社交与友情链接 | page | `/?view=apps&app=blog&appSection=design (links tab)` |
| PB-045 | 博客装修：项目作品 | page | `/?view=apps&app=blog&appSection=design (projects tab)` |
| PB-046 | 博客装修：实时私有预览 | state | `/?view=apps&app=blog&appSection=design`; authenticated HTML alias `GET /api/blog/design/preview` |
| PB-047 | 博客装修：放大主页预览 | dialog | `/?view=apps&app=blog&appSection=design` |
| PB-048 | 博客装修：发布历史与恢复 | state | `/?view=apps&app=blog&appSection=design` |
| PB-049 | 博客管理：冲突与保留修改恢复 | state | `/?view=apps&app=blog&appSection=articles|settings|design` |
| PB-050 | 公开博客：文字博客主页 | page | `/blog` |
| PB-051 | 公开博客：卡片杂志主页 | page | `/blog` |
| PB-052 | 公开博客：个人主页 | page | `/blog` |
| PB-053 | 公开博客：文章索引、搜索与筛选 | page | `/blog/-/articles; /blog?q=…|category=…|tag=…|page=…` |
| PB-054 | 公开博客：文章阅读 | page | `/blog/:slug` |
| PB-055 | 公开博客阅读：复制/分享反馈 | state | `/blog/:slug` |
| PB-056 | 公开博客：关于 | page | `/blog/about` |
| PB-057 | 公开博客：专题合集索引 | page | `/blog/-/collections` |
| PB-058 | 公开博客：专题阅读路线 | page | `/blog/-/collections/:slug; /blog/collections/:slug` |
| PB-059 | 公开博客：文章归档 | page | `/blog/archive` |
| PB-060 | 公开博客：不可访问响应 | state | `/blog; /blog/:slug; /blog/-/collections/:slug` |

## Shared ownership exclusions

- **Owner note editor and share-creation dialog** — workspace inventory: ShareDialog and note publishing entry points belong to owner workspace; public reader/editor is covered here.
- **Platform/account settings; MCP client manager and shared permission editor** — settings inventory: Only OAuth authorization page composition and exact grant rules are owned here; shared MCPDomainPermissions interiors cross-reference settings.
- **PluginManager, Git credential/sync/job editors, SearchRuntimeSettings** — settings/plugin inventory: Onboarding feature/import entry and import-specific fields are recorded here; shared detailed interiors excluded to prevent duplicate ownership.
- **TransferPanel batch/portable import and resume** — settings inventory: Baseline SetupImport is single-file direct import; settings owns the broader transfer UI and any shared wrapper used elsewhere.
- **RSS, sitemap, assets, reader.js endpoints** — non-visual interface contracts: Their visible entry links and reader behaviors are recorded; raw XML/JS/binary endpoints are not page mockups.
- **First-owner browser registration/password recovery/share password gate** — not implemented: Installation/CLI creates owner; share contracts contain no password. No invented UI.
- **ToDoo product pages** — excluded by user scope: ToDoo names remain only where existing OAuth permission contract needs them.

## Gaps and decisions before images

- GPT Image 2 model route remains unverified by parent; no images were requested/generated by this inventory. Every requiresDistinctImage=true is a review-queue requirement, not evidence of an image or approval.
- No browser/server/test processes were run. All 320/390/1440 behavior claims are static source evidence; runtime status remains unverified. Existing tests cited are evidence locations, not claimed passing.
- Owner-required SetupWizard state exists but normal public reachability is uncertain because App renders Login first and platform status requires an owner session; first-owner CLI is outside visual browser inventory.
- Public blog HTTP404/400 errors currently have no dedicated rendered HTML page identified; disabled/setup-required are404 while other runtime KnowledgeError status/code propagates. Determine whether visual unification may introduce an explicit page contract before designing it as existing behavior.
- Blog metadata UI/API limits differ (title200 vs256, summary1000 vs2000); site/profile/link fields have similar UI/server differences. Preserve current effective UI limits unless a separately authorized contract change is planned.
- Blog image chooser allows10MB source; processed design-media upload enforces5MiB. Preserve both distinctions; parent must decide wording during design review without silently widening API limits.
- Public guest error privacy must remain common404 for expired/revoked/rotated/missing share tokens. No password-gate or owner-rail route exists.
- Article/design drafts are retained through in-session failed requests and delayed reads; persistence across full reload or a distinct offline mode is not established in these components.

## Source correction and shared guest reachability

- **PB-046 preview entries:** `GET /api/blog/design/preview` returns standalone private homepage HTML using the stored draft. `POST` to the same path accepts the current unsaved design and returns JSON `{html}` for the studio. Both remain owner-authenticated API routes; the direct GET is an alias of the same homepage-preview surface and does not expose studio controls or a guest route (`apps/server/blog/routes.ts:151`, `:158`; `apps/server/app.ts:141`).
- **PB-026/027 public document/source eligibility:** public editing initializes `kind=document` directly. `NoteEditorHost:161` calls `parseSource`; `source-codec:156` passes `enabled:true`. Public rich mode therefore cannot be declared disabled by the owner `VITE_DOCUMENT_EDITOR_ENABLED` flag. More than262144 UTF-8 bytes,5000 source units,32 nesting levels, or global reference-link syntax triggers source fallback with a warning; explicit source mode remains available. This differs from async editor chunk failure.
- **PB-026/027 blank draft:** `draft.required=false` means no UI nonempty requirement. The save payload still requires a string `content` property; `content:""` is valid. Dirty deletion to blank can save under the normal state guards, and an unchanged blank baseline is simply clean (`PublicShareEditor:35`; `packages/core/notes.ts:366`; `packages/core/errors.ts:10`).
- **PB-026/027 find and replace:** Ctrl/Cmd+F and Ctrl/Cmd+H open the same shared search panel in either mode (`NoteEditorHost:266`, `:449`). Cross-reference workspace **WS-045**. No-match, case sensitivity, previous/next, current/all replacement and Escape close are real states; replacement is disabled while read-only and refused during composition.
- **PB-026 shared document context:** guest-reachable layouts cross-reference **WS-034–041**: table tools, image settings, link actions/edit dialog, image preview/zoom, preserved-source copy/delete confirmation and unsupported-paste choice (`DocumentEditor:1125`, `:1233–1342`). These do not grant the owner full toolbar, insert menu, upload workflow, navigation or publication controls. Image replacement/upload reaches the existing public warning; resource authorization still applies on save.
- **PB-022/026 diagram permission variants:** actual component is `DiagramPreview.vue`, not `PublicDiagramPreview.vue`. Normal public graph/Excalidraw projections can be PNG-only with no source controls. When a referenced whiteboard is actually resolved into a card, the source tab uses returned `board.capabilities.canDownloadSource` (`:127`, `:299–333`); the source panel downloads its local `sourceText` Blob, without fetching an owner asset or extra `source.path` to recover absent source bytes. `shareToken` forces `canEdit=false` and therefore `canGenerate=false` (`:42–43`) even when source download is explicitly allowed. Inline SVG/Mermaid already present in shared Markdown is a separate public-content case, not permission to fetch native/private source (`public-diagram-projection.ts:190`).

The register remains **60 surfaces**: these corrections extend existing entries and shared-state references without adding duplicate mockup IDs. No image, server, product change or test execution was performed for this correction.

## Evidence spot-checks

- Bootstrap/session failures: `App.vue:264`, `:318`, `:361`, `:389`; `tests/e2e/session-bootstrap-retry.spec.ts`.
- Setup phases/real direct import: `SetupWizard.vue:198`, `:402`, `:443`; `SetupImport.vue:32`; `apps/server/platform/settings.ts:80`.
- Public editor failure/recovery: `PublicShareEditor.vue:47`, `:128`, `:246`; `apps/server/knowledge/web-routes.ts:159`; `tests/e2e/sharing-permissions.spec.ts`.
- Blog functional state and CAS: `BlogWorkspace.vue:508`, `:897`; `blog-workbench.ts:249`, `:351`, `:374`; `packages/core/blog/service.ts:568`.
- Studio tabs/media/preview/history: `components/blog/BlogDesignStudio.vue:53`, `:211`, `:301`; `BlogImageEditor.vue:41`; `BlogPreviewViewport.vue:34`.
- Public templates/reader/search: `apps/server/blog/render.ts:109`, `:170`, `:212`; `reader-script.ts:2`; `tests/e2e/blog-public-redesign.spec.ts`.
