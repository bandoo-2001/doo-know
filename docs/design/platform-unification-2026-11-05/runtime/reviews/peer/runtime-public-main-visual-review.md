# 公开页面与博客主批次视觉对照

只审 55174d48cd4dc6c315d7595d982749994ad1cdbe 的 main-remaining；198 个 PB 主窗口、6 个跨栏 ST-024 导出窗口、51 个控件滚动辅助窗口，18 条旧 PB failed 完整保留。前述辅助和导出不重复计全局覆盖。结果 {'pass-with-observations': 31, 'pass': 139, 'recapture-required': 7, 'needs-revision': 27}。

- GUEST-BADGE · P2 · 320 编辑模式下“可编辑”徽标换行到标题栏底边之外，后续第一排模式按钮盖住徽标下半部。读者看不完整当前权限。
- STUDIO-FEEDBACK · P2 · 手机保存后停在滚动表单和固定保存栏；失败和 CAS 冲突错误/核对按钮都在高处。当前视口仍只写有未保存修改，控件图也没有错误。
- NETWORK-TEXT · P2 · 真实断网时桌面返回 Failed to fetch 给中文用户。没有说明此次保存失败及可执行的恢复步骤。
- FOCUS-COVERED · P2 · 默认聚焦滚动后若干真实输入、下拉或排序按钮仍在粘性保存栏下面。可继续手动滚动，未判定永久不可达；图片 file input/透明包装和 0×0 隐藏节点不作为本结论的依据。
- LOW-DANGER-CONTRAST · P3 · 已启用的红色放弃按钮在白底的实测文字比 4.466（目标 4.5），保留/放弃两个按钮都可达。
- OAUTH-ALERT-SAMPLE · review · 容器探测 3.554；画面中的内层字形显著更深，不能把容器计算值当作字形实际比值，也不能据此断言已通过对比度。需采直接文本节点样式。
- OAUTH-RETRY-STYLE · P3 · 唯一重试动作使用细边次级样式并紧贴错误框，MP-S046/R053 给出主色重试。
- LOADING-MISMATCH · redo · 320 目标页面主图仅有正在加载博客。articles/taxonomy 控件图仍加载；design 控件图仍在读取装修配置；settings 辅图只覆盖页面下段，不替代完整主状态。
- SHARE-ABORT-MISMATCH · redo · 应静默的取消分支实际呈现复制后备状态。只认截图中的反馈；未据此推断实际系统分享取消行为。
- OAUTH-BRANCH · scope · 主图为旧式操作/目录授权，不能覆盖现代业务预设；原 sourceIds PB-018 与可见分支不同。
- COVER-CLOSED · scope · PB-032 文章信息已显示；同时映射的 PB-034 原稿附件封面选择未展开。本行不能充当附件选择证据。
- HIDDEN-NODE · scope · 保留内部节点、文件代理等探针异常，但其数值单独不足以证明使用者不能与可见控件交互。
- DRAFT-REMOVE-COPY · P3 · 所选草稿明确“还未公开发布”，移除确认却称“公开文章将无法访问”。建议针对未发布选稿采用准确影响说明。
- CROP-COLOR · scope · 单色测试图可查控件布局，不能视觉确认裁切图像内容变化。
- EXPORT-ERROR-CODE · P3 · 受控未知 503 原样展示内部错误码；可增加通用中文失败说明。此图不足以证明真实生产错误使用相同代码。

稳定的 PB-003 三宽重认证对照已见；未将作者其他 build 的进场帧升格为稳定帧。完整逐图、最新版本限制、排除和 SHA 见 docs/design/platform-unification-2026-11-05/runtime/reviews/public-main-review.json。
