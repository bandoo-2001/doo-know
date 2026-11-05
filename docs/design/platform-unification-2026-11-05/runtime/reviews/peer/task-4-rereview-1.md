# Task 4 — scoped re-review 1

固定对象：`1088e38c11436ab35c9f231a03d4cc39bd69a44a` 中 `task-4-fix-review.diff` 提供的三文件范围：`apps/web/platform-ui.css`、`apps/web/blog.css`、`apps/web/blog-admin.css`。复核原 `task-4-code-review.md` 唯一 P2 和本修复引入的问题；不重审其他并行模块，不混入 working diff。本报告使用原 requesting-code-review 模板；唯一写入为本报告。

## Strengths / 原问题处理

**原 P2：静态层面已解决。**

- `platform-ui.css:25`–:27 添加共享语义正文 alias，以原 ToDoo seed 70% + ink 30% 派生；没有更改 root seed、ToDoo 页面色、布局或 provider。声明置于现有 `:root, :root[data-theme='dark']` 合同，深色会消费对应 dark seed/ink。
- `blog.css:197`–:208 分离 seed / text；8% soft 和30% line仍由原 seed计算，正文消费共享 `--ui-*-text`。未保存、changes hint、published/changes badge、site-off、success/error alert的文本路径全部改用 foreground alias。`blog-admin.css:154`–:179 的高优先级覆盖同步改用前景，避免基底修复被第二层反向覆盖。studio 未找到仍把 seed当作正文色的覆盖。
- `blog-admin.css:1366` 的 `.danger` 使用强前景；:1370 的 `.danger-button` 使用强 danger填充 + `--on-accent`。既有非primary hover排除danger-button，且实心button的fill/text均 `!important`，不会被现有普通hover规则改回低对比组合。已有disabled opacity/业务guard保持不变。

独立从固定提交的 `to-doo-tokens.css` 读取颜色并按 sRGB混色、相对亮度公式计算，保留浮点通道，复现修复报告的数值：

| 状态 | Light text / soft | Dark text / soft |
| --- | --- | --- |
| Warning | 5.209:1 | 8.628:1 |
| Success | 5.534:1 | 8.593:1 |
| Error | 5.752:1 | 8.206:1 |

普通surface背景最小值 light5.361:1 / dark8.286:1；实心danger为 light6.353:1 / dark10.421:1。均高于原问题要求的4.5:1。这些是**静态CSS组合计算，并非浏览器computed style或截图**。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

无新增问题；原P2静态修复通过。

### Minor (Nice to Have)

无。

## Recommendations

按已协调的root runtime pass，读取真实 warning/unsaved/changes、published/success、error/conflict和实心danger确认按钮的 light/dark computed foreground/background，核对最终cascade及enabled hover/focus。site-off内的文字操作明确继承修正后的父色；alert内原有文字操作仍使用平台accent，检查真实状态时应一并观察。disabled原有opacity仍在，未把其声称为4.5:1达标状态，也未新增业务禁用变化。

本修复不需再添加CSS声明镜像测试。原任务的viewport、焦点、SSR/导出print等集中验收继续保留，不因颜色复核通过而视为完成。

## Evidence / limits

- 已读原审查、`task-4-fix-1-report.md`、完整fix review diff，以及固定提交的相关alias、主题源、实际使用与hover选择器。三文件diff与Git对象一致；`git diff --check 1088e38^..1088e38` exit0。
- 已读修复日志：`fix-1-blog-models.log` 为2文件/32 tests passed；沿用实现者结果，**未重跑**unit。既有CSS audit结果也只按报告引用。
- 独立静态计算复现上表及solid比值；初次辅助计算器没有展开`#fff`，light soft产生NaN，已修正为支持三位hex后重算，最终数值与报告一致。未用该失败输出作验收依据。
- 未启动server/browser/E2E，未运行typecheck/build/full suite，未修改源码、index、HEAD、branch、服务或真实数据。只有本报告落盘。

## Declined to judge

- 运行时computed style、浏览器颜色序列化/舍入、实际hover/focus/disabled最终呈现：root随后统一验证；本次无浏览器，不声称运行达标。
- 320/390/1440布局与命中、iframe Escape/return focus、三SSR模板最终呈现、独立导出print分页：原集中runtime清单，未被本修复变更，不能由静态比值代替。
- 同一提交的PluginManager/settings消费改动：不在本次给定三文件review package内，由对应审查席位评判。这里只核对新增共享alias定义无冲突/循环，未评价其他模块全部状态。
- 既有业务控制器、安全/权限/保存/发布行为与其他并行workspace修复：本次三文件CSS修复未触及，不扩大审查范围。

## Assessment

**Spec alignment:** 通过本次scoped静态复核。共享foreground与seed分离，保留既有root palette、角色/状态与三层CSS边界，落实原P2修复方向。

**Code quality:** 修复集中、无重复light/dark私有调色板、未引入新的控制器或布局变更；未发现新增问题。

**Ready to merge? Yes（本修复静态范围）。**

**Reasoning:** 原P2在声明与静态数值上已经解决，可进入root集中运行验收。该结论不代表最终computed/viewport/print或全平台验收通过。
