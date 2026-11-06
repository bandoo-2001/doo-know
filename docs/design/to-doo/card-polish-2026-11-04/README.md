# 纪念日、专注底栏与提示改进

2026-11-04 的三项截图反馈已在源码中落实。

- 纪念日新增花间、远山、星轨、留白四套卡片样式及五种配色。在新建、编辑表单中实时预览，随纪念日一起保存；旧记录不需要迁移。
- 专注工作区填满内容高度，计时栏吸附内容区底部，手机端保留底部导航空间。历史说明放在记录列表下方，矮屏仍能完整看到第一条记录。
- 说明性提示统一使用可关闭的 Ant Design Alert。关闭状态按数据集和提示 ID 保存在当前浏览器，刷新和重新打开后继续隐藏；不同设备独立保存。动态错误和必要的字段限制继续显示。

`index.html` 展示隔离测试数据生成的桌面、手机及深浅主题截图。它是截图预览，页面交互功能在应用源码中。

临时 Tailscale 截图预览：<http://100.93.35.65:8184/>。仅绑定本机 Tailscale 地址，未设置开机启动。启动命令：

```sh
python3 -m http.server 8184 --bind 100.93.35.65 --directory /home/bandoo/workspace/projects/doo-know/docs/design/to-doo/card-polish-2026-11-04
```

验证入口：

```sh
npm run typecheck
npm run build
npx vitest run tests/to-doo-*.test.ts
npx playwright test tests/e2e/to-doo-anniversary-appearance.spec.ts
npx playwright test tests/e2e/to-doo-hints.spec.ts
npx playwright test tests/e2e/to-doo-focus-bottom-bar.spec.ts
npx playwright test tests/e2e/to-doo-focus-space.spec.ts --grep 'compact focus overview'
```

浏览器夹具共用 `.local/e2e-cookies.json` 与配置文件，必须串行运行。旧的专注历史测试在桌面和手机中复用相同记录文字，验证该用例时需要分别用 `--project=desktop` 和 `--project=mobile` 启动干净夹具，避免不同项目的数据互相匹配。

验证结果：ToDoo 的 50 个单元测试文件、654 项用例全部通过；纪念日外观 4 项、持久关闭提示 4 项、底栏短长列表 4 项、矮屏首条记录 2 项浏览器检查通过。专注历史的休息设置、保存与刷新用例另按项目隔离验证通过。类型检查、构建、两轮代码审查及截图页 10 张图片的 HTTP 检查通过。

曾启动全项目 `npm test`，因覆盖大量无关模块主动中止（退出码 130），不将其记作全量通过；最终完成的单元验证范围为上述全部 ToDoo 测试。
