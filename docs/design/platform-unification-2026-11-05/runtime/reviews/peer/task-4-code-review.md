# Task 4 — Public / auth / blog / SSR / export 独立代码审查

Review range: `7a5cfcc..016931d`（单个提交，13 个文件）。按 `requesting-code-review/code-reviewer.md` 模板审查。完整读取归档 diff 与逐文件 Git diff，并用 `git show 016931d:<path>` 追踪相邻宿主；不把其他 worker 的 working diff 或后续提交混入结论。唯一写入为本报告。

## Strengths

- 范围克制且易审：7 个 Vue 文件在 `<style>` 前的全部字节与 base 相同；`reading-export.ts` 在 `readingStyles` 外相同。认证、OAuth policy/legacy、guest 手动保存/CAS/草稿/确认及图形资源证明没有被视觉工作重写。
- 主题在实际角色宿主中承接：`main.ts` 加载 root token/aliases；`App.vue` 的 Ant/Naive provider 包裹 Login、Setup、OAuth、ShareReader 及 PublicShareEditor。紧凑重认证继续由原 NModal 承载，没有引入私有 owner rail 或第二套 root 调色板。
- 博客维持现有三层 CSS。`blog.css` 从 `.apps-home` 分离博客 alias map；`blog-admin.css` 删除自身独立 light/dark palette 和越界修改 owner rail 的规则；studio 层继续局部限定 `.blog-workspace.blog-admin`。article sticky top 归零符合 header 在 main scroller 外的真实结构。
- SSR 仍独立输出样式，保留 `--brand-accent`、system/explicit-light、serif、wide、bordered 与 journal/magazine/profile 的全部结构选择器。`render.ts` / `routes.ts` 与 base 相同：escaping、safeHref、sanitized body、CSP、skip-link、no-JS 导航、私有 preview 和撤销资源路径没有改动。
- BlogWorkbench、BlogDesignStudio、BlogPreviewViewport 与 base 相同，发布快照/草稿恢复/手动 save 的模型隔离和 1100/375 内视口、`sandbox="allow-same-origin"`、无 allow-scripts、iframe Escape 监听与外部焦点归还均被保留。
- 独立阅读导出继续静态、script-free、只内嵌已授权资源；导出 CSP、SVG/PNG 验证、primary preview hash/proof、静态 MathML、打印 API 都未改。screen table/code 约束和 print 中取消滚动的规则方向合理。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

1. **[P2] 博客浅色语义提示与徽章的文字对比度退化，保存/冲突状态更难读。**
   - 定位：`apps/web/blog.css:197`（warning/success/error alias 及其 8% soft 背景，至 :205）；实际文字使用在 `apps/web/blog-admin.css:154` / :164 / :170 / :176；危险确认按钮在 `apps/web/blog-admin.css:1370`。
   - 触发：浅色博客管理中出现“文章信息有未保存修改”、已发布徽章、读取/保存失败或冲突提示；这些是现有普通业务路径，不依赖异常数据。
   - 问题：新 map 将 `#a47939 / #438674 / #b75b66` 同时当作小字号文字色，并在白 paper 上混入 8% 作为对应背景。静态 sRGB 相对亮度计算的对比分别约 **3.57 / 3.90 / 4.04:1**；旧 admin 配对 `#826321/#fff9ed`、`#286b52/#edf8f2`、`#a44238/#fff2ef` 分别为 **5.33 / 5.83 / 5.62:1**。这里的文字为 13–14px，不能依靠大字号例外。新危险按钮白字对 `#b75b66` 也约 4.47:1。
   - 用户影响：未保存、发布状态、失败/冲突和危险动作等必要反馈在浅色下更难辨认；这是本提交的实际配色回归，unit/语法检查不能发现。
   - 最小修复：区分语义填充色与正文色，在博客局部由共享语义色及 `--text` 派生达到至少 4.5:1 的文字色，soft 背景仍消费共享色相；danger 填充也需保证 `--on-accent` 的对比。无需修改业务状态，也无需另定义 root palette。若 root 正在统一增加共享语义文字 token，可由本模块直接消费，避免两处独立选色。
   - 验收：先对实际 light/dark 组合做静态对比计算，再在 root 的隔离 browser pass 中核对上述真实状态的 computed foreground/background；确认 hover/disabled 不覆盖修正。这里的数值是静态计算，未声称已获取浏览器 computed style。

### Minor (Nice to Have)

无单独的模块级 Minor 问题。

## Recommendations

- 优先修复语义文字对比度，再进入已协调的集中 runtime 验收。无需为 CSS 添加实现镜像测试。
- 后续重点检查 320/390 长 OAuth client/path、guest 搜索/冲突/放弃 modal、完整 metadata 和 studio 字段、note picker/crop/review、sticky action/savebar 的目标矩形与键盘焦点。`scroll-margin-block:24px` 与会换行增高的 sticky action panel 尤其应通过实际 Tab/scrollIntoView 核验；静态审查不足以断言其必然遮挡，未将其报告成已复现 bug。
- SSR 三模板和不同 brand/font/width/cards、no-JS 导航，以及真实导出 HTML 的长表格/代码/MathML 和 print 完整性仍须使用实际输出验证。设计图与 375 内视口均不能替代 320/390 页面运行截图。

## Review evidence / limits

- 已读 `review-7a5cfcc..016931d.diff`、`task-4-report.md`、`task-4-brief.md`、`module-handoff.md`、`public-implementation-plan-proposal.md`、style-contract。读取 current catalog 的 PB-001–060 映射；相关 126 个输出均 current passed/accepted，所有设计 gates 为 true。没有布局歧义需要额外查看 PNG；设计 gate 不作为运行验收。
- 完整审查了 13 文件 diff；只读检查 root import/provider/theme、七个宿主 template/style、blog 三层 cascade、BlogWorkspace/Studio/PreviewViewport、SSR render/routes 与导出 renderer/resource/CSP。独立对固定 Git 对象比较确认七 Vue 非 style、导出非 readingStyles 和上述控制器文件相同。一次辅助检查末尾尝试了不存在的 `apps/web/blog-studio-workbench.ts`，因此该命令以 128 结束；随后确认实际 studio 使用现有 `blog-workbench.ts`，未据此声称额外 controller 文件通过。
- 已检查实现者三份现有日志：7 文件/20 tests、5 文件/72 tests、8 文件/84 tests，共 **20 文件/176 tests passed**。这是实现者证据，本次未重跑同源码 unit 或 CSS audit；其首个测试过程缺失 exit-code receipt 的限制继续保留。
- 独立运行 `git diff --check 7a5cfcc..016931d`，exit 0。颜色检查仅为本地静态数字计算。报告中的语法/SFC 编译、PostCSS、应用目录规则不变审计按实现者已有证据引用，未冒充本次重跑。
- 未启动 server/browser/E2E，未运行 typecheck/build/full suite，未修改源码、HEAD、index、branch、服务或真实数据。没有最终 runtime 截图或像素达标结论。

## Declined to judge

- 1440/390/320 布局、hit/focus/Escape/滚动、iframe 后焦点、dark 最终 computed style、SSR 三模板最终视觉和导出 print 实际分页：handoff 明确由 root 集中调度；本次没有执行，报告也未声称其完成。
- App-owned PB004–007/PB021、会话过期 owner-switch root 流程：只核对现有连接关系，具体 root 实现不在此 13 文件提交内，不重复审查其他 worker 的任务。
- 共享 ToDoo 根调色板、Ant/Naive 全局语义主题的重新选色：root/shared 层权威；本报告仅指出本提交新增博客 map 和实际背景组合的回归，并给出可局部消费的修复方向。
- guest 通用 editor/search/context 内部重构、现存业务模型扩展、额外图形编辑/生成授权、SSR API/权限/发布模型重写：brief 明确保留，提交也未改动；不借视觉审查扩展功能。
- PB060 HTML 错误页：仍为 HTTP-only，不要求新页面。
- 其他并行 workspace/settings/short-native 源码与修复：不属于固定审查范围。

## Assessment

**Spec alignment:** 主题继承、角色宿主、三层博客样式、SSR 三模板/配置、导出独立样式与安全契约在静态实现上与 brief 一致。集中 browser/type/build 尚待 root 完成，不将这种已明示移交误判为虚报完成。

**Code quality:** 控制器与安全边界未见本次削弱；局部 alias map 引入一项浅色语义文字可读性回归，需要修正。

**Ready to merge? With fixes.**

**Reasoning:** 修复博客语义文字与危险动作的对比度后，该范围可进入 root 的集中运行验收。当前证据仅支持静态审查与现有相关 unit 结果，不支持最终 viewport/print 验收通过。
