# 知识图谱 Ant Design Vue UI 验收

日期：2026-10-30。基线 `c9b08ee`，分支 `codex/knowledge-graph`。按用户反馈使用当前已安装的 Ant Design Vue 4.2.6 统一图谱 UI，未安装新依赖、改动业务后端或发布正式服务。

## 变更

- 工具栏使用 Segmented、Input.Search、Dropdown、Badge、Tag 与 Button；二级操作收进“更多”，手机进一步收起审核入口。
- 筛选、模型配置、审核和问答使用 Form、Select/TreeSelect、Input/Password、InputNumber、Checkbox/Switch、Slider、Collapse、Progress、Alert 等组件，沿用现有主题。
- 节点与关系列表、详情及原文证据使用 List、Card、Space、Tag、Empty；移除原生表单和折叠控件样式。
- 新增图谱专用 Ant Modal/Drawer 封装，保留 busy 锁关闭、未保存输入确认、焦点恢复与抽屉 Tab 循环；未替换其他应用使用的共享设置弹层。
- 表单按 Ant name/namePath 关联真正的内部控件，附加控件使用 FormItemRest；抽屉层级跟随主题，滑块名称与暗色证据配色已修正。

## 验证

| 检查 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` 通过 |
| 生产构建 | `npm run build` 通过 |
| 6 个相关 Vitest 文件 | 84 项通过 |
| 桌面生产页面 | 2 条完整流程通过 |
| 手机生产页面 | 2 条完整流程通过 |
| 独立 UI 静态审查及修复复审 | 通过 |

浏览器覆盖原有引用探索、两类模型配置、密钥不回显、关系审核、别名、人工关系的 Ant Select 选择、视图导出、16 秒问答、原文行跳转、未保存模型输入的继续/放弃、抽屉焦点、滑块可访问名称与无水平溢出。深色测试通过实际保存的外观偏好重新初始化 Ant 主题，未仅修改 CSS 属性伪装主题。

模型响应和资料全部使用本机合成夹具。生产验收使用独立 Web/API 端口 4679/4680，未终止其他会话服务。截图与日志保存在 `.local/graph-antdv-artifacts/`，包括 overview、model-settings、review 和 inspector-dark。

没有把本轮相关回归描述为全仓库所有测试通过。图谱索引、权限、原文及模型协议未在本轮修改。
