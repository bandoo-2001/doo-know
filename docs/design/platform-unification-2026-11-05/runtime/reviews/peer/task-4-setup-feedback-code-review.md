# Task 4 setup feedback — 独立代码审查

审查固定补丁 `task-4-setup-feedback-fix-patch`，SHA256 `633d46de9051e09e3cdb2e4647058605d90f38ed2f41ea171bbb256043eea30d`，相对 base `55174d48cd4dc6c315d7595d982749994ad1cdbe` 的完整9文件。源码行号均指向 manifest 对应的实现树 `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know`，不是尚未整合的 main。按 requesting-code-review 模板，只读审查；唯一写入为本报告。

## Strengths

- 原 runtime issueDefinitions 中 GIT-FEEDBACK、RECEIPT-ACTION、RESUMED-JOB、UNAVAILABLE、FILE-PRECISION 及四项允许的P3都有对应实现。没有将 CLIPPED-PROBE / INNER-INPUT 的证据限制编造成业务缺陷。
- 未确认clone的主按钮根据真实 unresolved.kind改名，仍经原 `startJob → reconcile` 分支读取既有 requestId对应的任务；没有用“重试”偷偷产生新clone。表单空字段不再阻止核对，是合理的调整，原 running/repositoryPending守卫仍保留。
- 恢复中的clone以本地 submitted requestId区分当前内存提交与恢复receipt；任务卡显示真实job.id、status/phase及地址/名称缺失说明，并隐藏误导的默认URL/name表单。GitJob DTO确实没有这两个字段；补丁未扩DTO、存凭据、虚构来源或成功状态。
- Git原 jobIntent/receiptEpoch/loadEpoch、旧回复丢弃、poll/retry/cancel ID、成功导入事件去重、未mount导航阻断及提交CAS路径保持原逻辑。新增submittedCloneRequest只是本地UI判断，没有进入服务器身份协议。
- SetupFeatures同时增加UI禁用和handler guard，只有成功registry read后且catalog/installed中确有条目才允许configure；单飞registryBusy阻断并发重读/安装，失败允许重读，外部skip继续存在。安装仍沿原installPlugin的receipt-first恢复与AbortSignal，不新增安装权限。
- SetupImport仅将大小回执改为精确字节并标明262144上限；`source.size > 256 * 1024`、UTF-8、requestId复用与错误重试均未改变。SetupWizard仅记录当前finish intent控制spinner，两个动作仍一同禁用，原API和welcome-action不变。
- 新用例包含行为断言而非CSS字符串镜像；独立三宽fixture调用真实本地app/API及bare Git transport，lost-response场景先让服务器接受再丢浏览器回复，仍断言POST次数为1。旧首启测试的catalog重读、兼容区展开、精确alert作用域和权威 `_doo-data` 常量维护与当前真实前提一致，没有削弱目录集或安装失败断言。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

1. **[P2] 导入模式的页面反馈watch跨越凭据modal边界，凭据错误会将焦点重置并滚动背景。**
   - 定位：`apps/web/components/GitRemotePanel.vue:104`–:120，特别是:106仅检查`mode`以及:116选择顶层`feedbackAlert`。顶层目标位于:831；真正弹窗内的错误位于:1005，当前overlay由:989的SettingsOverlay承载。
   - 触发：首次设置选Git导入，点击“添加凭据”，在凭据modal中保存时收到真实服务器拒绝/网络错误，或读取SSH指纹失败。`saveCredential`的catch(:649–:652) / `startJob`错误路径会写同一error并解除busy，新的watch随即运行。即使不涉及旧回复，这也是普通可达错误流程；另一个例子是在背景status读取未结束时进入凭据modal，随后status读失败。
   - 问题：watch没有判断`overlay`，nextTick后也只检查active/busy。它对**modal外**的顶层alert执行focus和scrollIntoView；`SettingsOverlay.vue:92`–:94开启autoFocus/trapFocus，实际依赖`node_modules/vueuc/es/focus-trap/src/index.js:64`–:75会将modal外focus同步重置到modal的first descendant。因此modal里用户当前焦点被拉回首个可聚焦项，真正的modal错误区未成为焦点目标，随后scrollIntoView仍滚动背景。页面级错误反馈修复不应抢占当前modal自己的焦点/滚动所有者。
   - 用户影响：手机凭据表单出错后，键盘/辅助技术使用者从保存或指纹操作跳回表单开头，无法按设计定位当前错误；背景导入页面还会在modal下跳动。凭据草稿虽未丢失，但错误恢复交互被本补丁改变。
   - 最小修正：仅在当前没有overlay的import页面中执行页面级反馈；在nextTick回调里再次核对overlay和反馈是否仍有效，避免调度后打开modal仍偷焦。若希望modal也自动定位错误，应另外引用**当前SettingsOverlay内部**的错误区并只滚动其body；不能复用背景alert。保留已有active/receipt guards及凭据秘密处理。
   - 验收：补有意义的回归：mode=import打开凭据modal→保存/SSH读取失败，确认焦点仍在当前modal（可定位modal内反馈），背景scroll不变、秘密/草稿保留；再覆盖页面反馈排队后进入overlay、以及延迟背景load失败不能将当前modal焦点重置。现有unit将SettingsOverlay stub为null且元素无真实focus；新增18个browser case只覆盖无overlay的反馈，因此未覆盖此问题。
   - 证据边界：上述结论来自实际组件与本地focus-trap实现的调用链，**本审查没有启动浏览器复现或声称已有失败截图**。root可在最小修正后的隔离lease中完成真实焦点/滚动验证。

### Minor (Nice to Have)

无单独新增项。

## Recommendations

- 修正上述overlay边界后，保留当前严格的整块反馈inViewport和focused断言，不用放宽容差掩盖焦点或滚动问题。
- UI调度应在执行时核对当前反馈资格；业务旧回复仍应继续由现有ownsJob/epoch阻断。这里无需重构durable请求或CAS协议。
- 新fixture的测试数据、随机token、loopback端口、临时根路径与清理均与主服务隔离；最终runtime视觉仍由root独立按图片复核，不能把本报告的代码结论当作逐图通过。

## Review evidence / limits

- 已读固定patch、manifest/report/brief、真实`docs/design/platform-unification-2026-11-05/runtime/reviews/setup-public-review.json`的全部issueDefinitions。独立计算patch SHA256符合上述值；manifest全部9文件hash均与实现树一致，HEAD为55174，未stage。全patch9文件已阅读，包含新增config/spec/fixture。
- 追踪4个产品SFC的异步与实际宿主、plugins refresh队列/session epoch、installPlugin原receipt协议、GitJob DTO、SettingsOverlay和本地vueuc focus trap。GitDiff仅用于只读定位；`git diff --check` exit0。未执行或重复同源码测试。
- 已读真实RED日志：4个unit expected failures、5个phone320 browser expected failures；GREEN日志为4文件/65unit passed、18个三宽browser passed、旧完整首启1case passed、typecheck最终无错误。以上沿用作者已执行结果，不冒称本审查重跑。中间失败及fixture前提修正均在原报告保留；没有因最终通过删除失败证据。
- 本次未启动server/browser/E2E，未运行unit/typecheck/build/full suite，未操作真实账号/服务/数据，未写源码、index、HEAD或分支。唯一产物为本报告。

## Declined to judge

- 27张after图的逐图视觉接受、与旧图的细节对齐、最终集成后实际hit/focus/scroll：root另有视觉复核席位，本审查没有重新查看每张图或运行browser。
- missing URL/name重建：DTO与授权范围明确禁止虚构，当前真实ID/phase和缺失说明符合裁定；不要求新增后端字段或持久化凭据。
- 恢复task的非pending历史全量浏览、新的registry/安装业务协议或完整设置重构：不是本集中fix要求；原模型未变，不借审查扩大范围。
- CLIPPED-PROBE、INNER-INPUT以及全平台暗色/short-landscape/SSR/blog/export/最终发布产物：不是本package能够证明的行为，继续保留证据边界。
- Main尚未合入的其他修复、服务状态和最终source-bound打包：不属于这段固定patch。

## Assessment

**Spec alignment:** 原集中问题在正常无overlay流程中已有直接实现，大小/安装/恢复信息契约符合要求；页面反馈仍需补上当前overlay/focus边界，才能满足“不让异步反馈抢占现有窗口”的整体约束。

**Code quality:** 原请求、权限、CAS、未知结果和真实成功语义未见削弱；新增页面级focus副作用作用域过宽，需要1项局部修正和对应回归。

**Ready to merge? With fixes.**

**Reasoning:** 修正凭据modal内错误被页面watch抢焦后，该package可继续root的集成与逐图视觉验收。现有65unit/18browser/旧首启/typecheck通过不能覆盖未测试的modal错误分支，也不代表最终全平台验收完成。
