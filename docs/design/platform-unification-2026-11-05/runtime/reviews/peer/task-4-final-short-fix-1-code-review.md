# Task 4 final short fix 1 — scoped code re-review

固定范围为b453包上的三文件增量：`blog-savebar.ts`、`blog-admin.css`、`public-final.spec.ts`。patch SHA256 `193ba6ce204c2d1278efa7bcecc2e1310253671673fe16fdd6fe94c8d46a2271`；manifest SHA256 `0914c805ec62054f49bd16d61ea8c457a33eb24c7972e282f74f5bf2acf585a3`。行号指manifest对应的独立modal-focus树。旧b453的0 C/I/M结论不重开，不扩展新scope/P3。

## Strengths / 原新增Finding处理

**shortFocusP2：本增量代码修复通过。**

- `blog-savebar.ts:20`–:28从真实owner的client区域计算上下边界；:89–:102以实际bar高度、当前form最高控件高度和clearance决定sticky/static，不依赖固定视口高度断点。不能同屏时完整保存反馈和手动操作继续留在form正常流中，未隐藏/截断内容。
- :61–:70只在实际sticky且相交时扣除footer占用，并优先保护field.top，再处理bottom越界。旧代码只向上推到footer之上的问题被替换为真实owner上下界保护。
- :53–:56在正常流且完整actions可装入owner时，把actions整体作为滚动目标；lastAction仅记住savebar内真实获得焦点的动作，允许native disabled使activeElement变为body后继续显示当前反馈。不同focusin表面会清记忆；target必须仍连接、属于当前form，并继续遵守active/inert/aria-hidden守卫。helper没有focus调用、请求或业务状态写入。
- root/bar/owner ResizeObserver和window resize重新测量；ref切换或卸载时disconnect、取消RAF、移除resize/focusin listener、清lastAction并恢复两个局部CSS变量。新CSS只消费本地position变量，不改root shell、editor或preview身份。
- 增量没有API/UUID/CAS/pending/retry/generation/draft或手动read/save协议变化。原b453另7文件hash保持一致。原反馈文案、guest header和iframe契约未被本轮修改。

## Issues

### Critical (Must Fix)

无新增。

### Important (Should Fix)

无新增；shortFocusP2已按brief处理。

## Evidence / limits

- 完整读取brief、report、三文件patch及真实`public-final-integrated-review.json`的shortFocusP2；review文件hash符合manifest。独立核对patch/manifest SHA及三个最终文件hash，原b453其他7文件hash均未变。
- 独立`git diff --check`和增量`git apply --reverse --check`均exit0，只检查未应用。未改源码、index、HEAD或分支。
- 已读原2个short RED及native-disable/body反馈可见性diagnostic RED；最终日志为short2passed、原三宽36passed、相关4文件57unit passed、typecheck无错误。沿用作者已执行结果，未重跑测试/fixture。
- 新test使用真实接受PATCH后丢响应，检查template/select/textarea native nearest focus与center hit、8次Tab、tall→short实测重测、同一iframe仍连接、草稿保留、明确核对READ及总PATCH为1。没有DOM或成功结果伪造。
- 当前代码修复与上述作者行为证据相符；本审查未启动server/browser，未独立运行截图或认证全部18张after图。最终main集成后的source/视觉复验仍由root/closeout完成。

## Declined to judge

- 新18图逐图接受与main集成源码绑定：root/closeout后续验证，本报告不代替视觉席位。
- 旧b453已审范围及其他ST/PB/WS/P3、全分支fresh审查、全量测试/发布：不在这次三文件增量范围。
- 实体软键盘/visualViewport、比当前owner本身还高的任意自定义控件、完整App reauth和1100/375放大preview再次E2E：本轮未新证明，不宣称额外通过；本次没有改相关协议或重挂载。

## Assessment

**Spec alignment:** 通过。以真实几何决定顺流回退，保护owner上下界，并保留native禁用后body焦点时的完整反馈可见性。

**Code quality:** 本增量无新增Critical/Important，布局副作用局部且有清理，未改协议或模型。

**Ready to merge? Yes（此固定增量）。**

**Reasoning:** shortFocusP2已有对应修复及有意义RED→GREEN证据，可交root集成和最终source/视觉复验；不表示全分支或发布验收完成。
