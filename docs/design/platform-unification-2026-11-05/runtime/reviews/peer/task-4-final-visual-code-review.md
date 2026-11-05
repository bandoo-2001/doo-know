# Task 4 final public visual fixes — 独立代码审查

固定审查包：`task-4-final-visual-fix-patch`，SHA256 `b4536386d37bebb84c6c060e92c5cfd945f189367ffe240f2968d142c842d10a`；base `0a890634f37fdc56037426ca01f1a0b2a27ca82c`。完整10文件（6产品/4测试与配置），行号均指向manifest对应实现树 `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know`，不是尚未合入的main。按requesting-code-review模板，只读审查本包；唯一写入为本报告。closeout-image-review-brief中的其他产品/补拍范围不混入结论。

## Strengths

- **GUEST-BADGE有明确的局部修复。** `PublicShareEditor.vue:276`的global selector限定为`.share-page:has(> .public-share-editor) > .reader-header`，只在实际guest编辑器作为直接子节点时取消继承的固定height并阻止header被flex压缩。standalone ShareReader和其他公开form不满足此selector；guest script/template、权限徽章、document/source切换与CAS处理没有改变。
- **保存错误与现有核对动作处于同一实际操作区。** `BlogDesignStudio.vue:124`保留初次未加载时的错误，已有form时将同一error放入:182的原sticky savebar；`BlogWorkspace.vue:1021`同样承接settingsError。按钮明确`type="button"`，仍调用原`loadDesign()` / `reviewSettings()`读取动作，busy/loading guard保持。没有新增自动save/publish或混合另一份状态。
- **未知结果文案诚实。** `blog-workbench.ts:71`–:80仅将已识别的浏览器network/timeout错误转换成中文，明确“操作结果尚未确认”“当前修改已保留”“重新读取并核对版本，再决定是否保存”。未将丢响应描述为服务器确定失败或成功，CAS与其他业务错误继续原消息。该文件其余请求、requestId、generation、pending、merge/dirty、save/publish/restore流程均未改。
- **动态底栏保护只处理几何，不接管焦点或模型。** `blog-savebar.ts`的实例局部ref/RAF检查当前form、bar、target仍连接、target仍属于form且保持真实activeElement；footer自身的控制、已失焦或inert/aria-hidden祖先不触发滚动。它测量实际bar高度，在form上设置局部scroll-margin变量，必要时调整包含form与footer的滚动祖先。没有调用focus或修改输入、草稿、选择、API、iframe key/srcdoc；ResizeObserver/RAF和局部style在ref切换/卸载时清理。
- **共享边界保持。** `blog-admin.css:30`的scroll clearance仅限blog form控件与既有排序/添加/模板动作；没有改root header、所有者导航或公开页CSS。表单ref和focusin新增不会重建组件。BlogDesignStudio原history-to-draft、实时preview watch、native enlarged dialog、1100/375内视口、sandbox无allow-scripts、iframe Escape与return focus均保持原实现。
- **回归用例针对真实问题。** 两个new unit证明unknown文案、保留本地修改、单次write与显式READ核对；新browser未知响应先让真实server接受再丢response，conflict通过真实竞争写入触发。密集form case逐个检查native控件focus、viewport、center hit及footer上方位置，持有同一个iframe element验证连接和sandbox，没有使用CSS字符串镜像或伪造成功页。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

本固定补丁未发现新增Important；原三组P2（guest徽章、保存反馈/网络文案、sticky footer遮焦点）均有与真实源码/测试对应的实现。

### Minor (Nice to Have)

无。

## Recommendations

root可进入本包集成与36张实际after图的独立视觉审查，再完成最终source-bound复验。本代码审查通过不替代逐图接受；保持main当前其他已授权改动，勿按author整树覆盖main。无需为本包再增加纯CSS镜像测试或重构保存协议。

## Review evidence / limits

- 已完整读取patch10文件、`task-4-final-visual-fix-report.md`与manifest，核对真实`public-main-review.json`中GUEST-BADGE、STUDIO-FEEDBACK、NETWORK-TEXT、FOCUS-COVERED的来源；网络文案与保存反馈作为同组处理。
- 独立计算patch SHA256符合上述值，全部10个最终源码文件hash匹配manifest；实现树HEAD为0a890。独立`git diff --check`及`git apply --reverse --check <固定patch>`均exit0，仅检查，没有apply/stage或其他Git写入。
- 额外只读追踪原BlogWorkbench的settings/design请求和merge/generation、BlogWorkspace/Studio宿主、BlogImageEditor/Collections等嵌套native控件结构、BlogPreviewViewport、三层blog CSS及原preview回归的实际断言。未发现新权限、保存身份、旧回复所有权或历史/快照隔离变更。
- 已读作者RED日志：2个unknown unit真实失败；初始browser的测试标签前提失败与产品失败分开保留；修正为密集真实native控件后，五form家族focus RED均为center hit失败。未把前提修正伪称成产品修复。
- 已读GREEN日志：4文件/57unit passed、36个三宽browser passed、原preview回归2passed、typecheck无错误。均沿用作者结果，**本审查没有重复运行同源码unit/E2E/typecheck**。原preview的第1case检查真实1100/375、sandbox、Escape/backdrop/close return focus及零design写入；第2case显式390px检查长collection identity，不能将它称为另一份1440实测。
- 新browser核对按钮后的断言验证error消失、字段保留、PATCH数量仍为1；它没有额外显式等待某个GET响应。原模型和unit证明动作是READ，这个证据边界与作者报告一致。
- 本轮未启动server/browser，未查看/认证全部36PNG，未运行build/full suite或修改源码、index、HEAD、branch、服务、真实账号/数据。唯一产物为本报告。

## Declined to judge / residual boundaries

- 36张after图的逐图视觉接受、最终main集成后的源码绑定/运行复验：root/closeout另行负责，本报告仅静态审查与引用已存在行为证据。
- 完整暗色/短横屏、移动实体键盘/软键盘visualViewport变化、任意高于可用视口的自定义textarea等未由当前36case覆盖的环境：未宣称这些全部达标；本次按明确1440/320/390实际问题与已有native控件范围评价。
- SSR/导出/全平台/ST/WS新补拍、其他closeout产品改动、release或部署：不属于此patch，不作为本scope新增要求。
- 既有requestId/unknown receipt/CAS协议或历史恢复模型重写：本轮明确不扩展，实际代码也未改；这里只确认呈现修复没有削弱原有路径。

## Assessment

**Spec alignment:** 通过本固定scope的代码审查。guest header修复限于实际编辑宿主，保存错误在原sticky操作区可呈现，未知结果中文与原手动核对模型相容，动态footer保护没有引入重挂载或焦点接管。

**Code quality:** 范围集中，scroll clearance以真实高度和当前active target为依据，资源清理和局部CSS边界明确；未发现新Critical/Important/Minor、权限或保存契约退化。

**Ready to merge? Yes（本固定patch代码范围）。**

**Reasoning:** 三组真实P2已有具体实现与有意义RED→GREEN证据，可以继续root集成和独立视觉接受。该结论不代表最终source-bound或全平台验收完成。
