# DooKnow 其余平台 UI 统一：覆盖清单与执行状态

日期：2026-11-05（Asia/Shanghai）。本目录是当前唯一主任务的持久化入口：**除已完成 ToDoo 外的全平台 UI 统一，直至设计、实现、验证、主分支整合与新版本打包交付**。**设计门槛已通过，当前正在实现后的集中验证阶段；本轮主分支整合与新版本交付尚未完成。**

[机器可核对目录](./design/catalog.json)记录 **390/390 个计划资产已生成并通过逐图审查**，待审、待修、缺失、映射错误和来源未决均为 0；[独立全局设计审查](./design/reviews/global-design-review.json)为 `pass`，冻结覆盖摘要为 `b422b7cb1336e0322291ad9ed619fa3c719f02859ec7f5427b7c76a2d6435879`。目录中的全部设计门槛及 `developmentPermitted` 均为 `true`。图稿与审查冻结保留，后续实现截图另行取证；设计通过不等于运行、整合或发行通过。精确当前图稿与历史版本仍以[设计图集](./design/index.html)为准，按需展开原图。

- 本轮盘点和设计的源码基线：`txj/doo-know-web-v1@933d63d942b6499fee964f8a060c7b22b9d299d1`；这是上一任务已整合版本，本轮最终整合仍须重新核对远端。
- ToDoo 基准：应用源码 `f44d608`；沿用其布局层级、主题、配色、密度、组件与响应式做法。已完成的 ToDoo 内部页面不重复设计，但共享宿主及后续回归仍需覆盖。
- 本轮独立工作区：`/home/bandoo/.codex/worktrees/60c5/doo-know`，分支 `txj/platform-ui-unification`。原项目及其他任务工作区未覆盖、切换、重置或清理。
- 当前实现源码冻结点：`12b7798`。共享主题/所有者外壳、工作区与编辑器/图形/图谱/回收站、设置/插件/Git/MCP、认证/分享/博客/SSR/导出已进入实现；定点验证已记录，集中全量检查和运行覆盖仍在进行。详见[实现状态](./IMPLEMENTATION.md)和[实施计划](../../superpowers/plans/2026-11-05-platform-ui-implementation.md)。

## 图像工具核验（已通过）

**已核实可使用 Codex 内置 GPT-Image2，无需额外 API Key。** [OpenAI 官方 Codex 生图说明](https://learn.chatgpt.com/docs/image-generation)明确指出内置生图使用 `gpt-image-2`。本会话提供 `image_gen.imagegen`，按该官方工具契约执行；不会改用更新的2.5、1.5或其他模型。

前期只检查工具参数/回执，型号尚未确认；继续查询官方文档后已解除该疑问。旧图 provenance 的通用 `gpt-image` 文本不是型号依据。CLI 支持显式模型但缺APIKey的事实仍保留在[核验记录](./model-preflight.json)，它不是内置工具的阻塞项。没有必要为内置生成安装SDK或索要密钥。

图稿已保存模型核验来源、实际工具、完整提示词、参照、功能/角色/状态映射、图稿及散列；全部选中资产已完成逐图及全局审查。比例与平面化作为共用 CSS 指导保留，栅格数值不是精确布局合同。设计通过的事实以冻结目录和摘要绑定的全局审查为准。

## 清单与索引

- [交互索引](./index.html)：分页搜索路由、角色、字段、约束、操作和源码；真实改造前截图默认折叠，避免手机一次加载大量图片。
- [完整覆盖索引](./coverage-index.json)：保留盘点/改造前快照；其中早期 `gates` 不代表当前设计阶段，当前设计门槛以 `design/catalog.json` 为准。
- [实现状态与验证边界](./IMPLEMENTATION.md)；[运行证据计划](./verification-plan.json)仍是计划，不能充当改造后验收结果。
- [知识工作区、编辑器、图形与图谱](./coverage/workspace.json)：124 条。
- [平台设置、插件、MCP、Git 与后台任务](./coverage/settings.json)：91 条。
- [认证、首次使用、公开分享和博客](./coverage/public-and-blog.json)：60 条。
- [独立源码覆盖审查](./reviews/inventory-global-review.md)。

当前共 **275 条应用自有界面/状态记录**：51 页面、55 对话框、10 抽屉、24 浮层、135 状态。它们不是 275 个独立路由。268 条需要图像表现，按共享组件/状态及响应式矩阵逐项映射；5 条仅注册/未挂载记录保留追踪而不假定为当前可达页面；ST-015 复用 WS-023 的 DirectoryTreeSelect 视觉，仍保留宿主字段别名、权限和选择约束；PB-060 当前只有HTTP错误响应，没有应用自有HTML界面，4项业务状态保留为非视觉契约，不生造新的访客页面。

每条记录包含实际入口/触发、源码与测试位置、字段及数据约束、操作/API、角色权限、重要状态、当前响应式证据和设计需求。所有 ID、父级、共享引用、文件及行号已校验。源码复核发现的遗漏与矛盾已补齐，包括回收站、完整路径、完整分享表单、打印阅读文档、跨模块提醒宿主、Git 装饰及访客编辑权限。

## 真实运行基线

已在独立临时数据库和知识目录启动当前未改造代码，记录 **188 张真实基线/观察截图**：其中主页面与公开流程为 41 个场景的 1440/390px 共82张；画布运行观察另55张；所有者富文本开关开启的 6 类界面在1440/390/320px另18张；创建、导入、笔记操作/移动/分享/历史等11类窗口在三种宽度另33张。

- [工作区/设置/博客管理/认证基线结果](./baseline/capture-results.json)：54 张。
- [公开博客、只读/可编辑分享、查找与真实 OAuth 授权基线](./baseline/public/capture-results.json)：28 张。
- [画布运行补充](./coverage/runtime-diagrams.json)与[实测报告](./reviews/runtime-diagrams.md)：25类运行观察（6类对应应用清单、19类厂商子界面），55张证据。50张目标可见，2张目标在屏外，3张未出现所尝试目标；后三类不冒充可用布局通过。
- [所有者富文本开关开启基线](./baseline/rich/capture-results.json)：编辑器、段落样式、表格、颜色、链接和查找/替换，共18张。首次命令12张成功、6项因采集选择器错误未验证；源码确认段落触发器为combobox、链接为Naive卡片后，只重跑这6项，全部捕获成功。[首次结果](./baseline/rich/capture-results-first-attempt.json)保留，不将原失败改写为零失败。采集成功不等于操作保存、所有窗口几何或实体手机键盘已验证。
- [所有者窗口基线](./baseline/windows/capture-results.json)：11类×三宽度，共33张；首次27成功/6选择器失败，作用域收紧到创建菜单并按真实Naive浮层定位后只补采失败6项。[首次结果](./baseline/windows/capture-results-first-attempt.json)保留。33个目标窗口边界均在视口内，仍不代表保存/错误分支行为已全部验证。

截图由真实 Vue/SSR 页面及真实接口驱动，数据仅为临时夹具，不复制用户知识资料或真实凭据。这些是 **改造前的运行参考**，不是生成设计图，也不代表所有窗口或 320px 已完成验收。

初次批量采集触发夹具的认证频率限制，已如实保留中断记录；随后沿用仓库既有测试约定，仅在已验证的 `/tmp/dooknow-browser-*` 夹具中重置测试认证预算后重采，54/54 完成，未修改生产限制。公开 OAuth 注册初次缺同源头，补齐真实认证请求头后得到 201，公开扩展采集 28/28 完成。

第三方画布已完成空白白板的有限运行枚举；19类厂商子界面必须在后续图稿计划中逐项映射，不能用一张父画布图冒充全部覆盖。390px Excalidraw 查找/素材库侧栏完全在屏外，即使外层 overflow 为0，控件仍不可达；3次指令面板/移动统计尝试没有显示目标窗口，均明确标为未验证。320px只有代表性画布窗口检查，富文本开关组合、其他图形/嵌入和填充内容仍须补验。未在设计门槛之前修改这些产品问题。

后续[定点源码核验](./reviews/vendor-attempt-resolution.md)已解释3次无目标观察：锁定包的CommandPalette未在当前集成挂载，统计面板仅在非移动编辑器分支渲染。原采集结果保持不变，不把它们改写成运行通过，也不新增不存在的手机统计窗口。查找/素材库屏外问题已在实现阶段通过限定自有侧栏选择器和短窗口滚动修复，并已有 390/320px 与短横屏的定点检查；全平台最终运行验收仍待汇总，详见[实现状态](./IMPLEMENTATION.md)。

## 功能与设计边界

- 私有所有者页面参考两级菜单；公开分享、博客、认证和打印文档只使用与其权限相符的导航，不能复制私有入口给访客。
- 分享没有密码门；不存在/过期/撤销等使用相同 404，保留隐私边界。访客原件下载按解析后的能力授权，不能据此增加编辑/生成权限。
- 保留手动保存、冲突比较、草稿、发布快照、重试、撤回、分页与长任务恢复。图稿中的示例数据不成为业务结果。
- UI 限制、服务端限制、富文本准入和读取/写入限制分开记录，不能把“请求属性必需”误当作“正文不可为空”。源代码中已有不一致先作为待决事实记录，不扩大后台能力。
- 原生浏览器/系统打印和文件选择器本身不由平台重绘；应用生成的阅读/导出 HTML 仍在覆盖范围。
- 继续使用当前真实 Vue/TypeScript、Ant Design Vue、Naive UI 和原有图形引擎；不做无关升级或擅自替换渲染器。

## 图像归档与恢复

本目录内 **694 张 PNG（659,260,850 字节）** 已按目录内 `.gitignore` 排除 Git：506 张生成设计图（包含历史/失败/未选版本）及 188 张改造前基线。390 个选中设计资产是覆盖单位，不能与 PNG 总文件数混用。提示词、侧车、清单、审查及索引保留为文本；本轮没有删除已有跟踪图片。完整逐文件清单见 [image-artifacts.json](./image-artifacts.json)。

独立归档位于 `/home/bandoo/documents/doo-know/design-artifacts/platform-unification-2026-11-05-images-b422b7cb.tar.gz`，537,188,063 字节，SHA-256 为 `3b01a27209b559a54c8dd9be3a7741f99d38aba4b57d79e2d26bb6d710cf2885`。已有恢复验证把归档解到新的临时目录，**694/694** 文件的长度与 SHA-256 均匹配，状态 `passed`。这份本机独立副本不代表已完成异地备份，且不含改造后的运行截图。

在可访问该归档的全新仓库根目录恢复时，先核对归档，再解包，最后核对清单中的每一张图片：

```sh
printf '%s  %s\n' '3b01a27209b559a54c8dd9be3a7741f99d38aba4b57d79e2d26bb6d710cf2885' '/home/bandoo/documents/doo-know/design-artifacts/platform-unification-2026-11-05-images-b422b7cb.tar.gz' | sha256sum -c -
tar -xzf /home/bandoo/documents/doo-know/design-artifacts/platform-unification-2026-11-05-images-b422b7cb.tar.gz -C .
python3 - <<'PY_VERIFY'
import hashlib
import json
from pathlib import Path

root = Path.cwd().resolve()
manifest = json.loads((root / 'docs/design/platform-unification-2026-11-05/image-artifacts.json').read_text())
assert len(manifest['files']) == 694
for item in manifest['files']:
    path = (root / item['file']).resolve()
    path.relative_to(root)
    data = path.read_bytes()
    assert len(data) == item['bytes'], item['file']
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['file']
print('694/694 PNGs match the manifest')
PY_VERIFY
```

## 当前门槛与未完成项

1. **已通过：** 390/390 设计资产、逐图功能审查、来源核验与摘要绑定的独立全局设计审查。冻结资产计划、PNG、侧车和审查不再随实现改写。
2. **实现与定点验证已有记录：** 当前源码 `12b7798`；历史失败、修复、重跑、筛选跳过及验证范围见[实现状态](./IMPLEMENTATION.md)。
3. **仍在进行：** 集中单元、类型、生产构建和端到端结果汇总；按真实 1440/390/320px、深浅色、角色及重要状态建立改造后运行证据，检查实际目标矩形、焦点、操作与内滚动。设计图和 188 张改造前截图均不算这一步通过。
4. **尚未完成：** 全局实现验收、独立分支终审、核对最新主分支后正常整合/推送，以及新版本原生包与隔离可执行门禁。见[发行预检](./release-preflight.md)；本入口尚无新版本号、制品或校验值可交付。

本轮没有更改正式/预览部署、服务配置、真实账号、密钥和持久数据，也没有向外部正式环境发布。
