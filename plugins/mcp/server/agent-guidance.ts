/** Discovery hints only. Every operation checks the caller's current authority. */
export function makeAgentInstructions(config: { readOnly?: boolean; allowIndex?: boolean; allowPublish?: boolean }) {
  return `DooKnow：18项有界工具；调用须实时核验身份、目录和权限，工具可见不代表获准。配置提示：readOnly=${config.readOnly !== false}，allowIndex=${config.allowIndex === true}，allowPublish=${config.allowPublish === true}，不授予权限。

研究：search(query)返回最多10个对象，再将原样id交给fetch(id)获取完整text。fetch.id是签名对象引用，15分钟有效且绑定版本和授权；它不是笔记noteId。search_notes和list_notes返回稳定noteId，供其他笔记工具使用。引用失效时重新搜索。

检索：search_notes支持text/semantic/hybrid、过滤与freshness；默认hybrid/indexed。检查degraded/reasons，不将降级结果解释为最新。list_notes只列摘要。两者limit默认10、最多50；续页原样传nextCursor，保持原查询、过滤、目录和limit。不自动翻页或批量下载。

读取：get_note_info先核对版本、大小和editorMode；get_note_outline列章节，read_note显式读取一页。默认8KiB/100行，每页最多16KiB/200行；行号从1开始且两端包含。cursor不能与snapshotId/range同用。snapshotId绑定原文版本；字节偏移按UTF8、从0开始、排他终点且须在字符边界。单会话最多32页/256KiB/15分钟，身份最多2并发和2MiB/分钟。

写入：create_note创建；update_note仅替换普通模式完整正文；patch_note修改版本快照，最多20项，旧文本与插入合计32KiB UTF8；archive_note按版本归档到可恢复流程。整篇正文最多32KiB。保留草稿，使用读取所得精确expectedModifiedAt；patch还须snapshotId与expectedContentHash。笔记版本冲突须读最新正文、合并草稿，核对后用新requestId，不得盲换版本。

幂等：一次写入保留同一requestId和原参数。结果未知时用operation_status(requestId)查询，或以原ID重试原请求；不能生成新ID重复写入。operation_status只提供operationId或requestId之一，建议至少间隔1秒查询。accepted/operationId表示后台任务已接受，只有终态succeeded确认完成。cancel_operation仅请求提交前取消；断开连接或取消不保证写入回滚，committing后查询终态。

索引：refresh_index返回jobId，随后用index_status检查进度和降级，接受不代表向量已完成。需要knowledge:index。读取需knowledge:read，写入需knowledge:write；授权失败先检查requiredScope和目录范围。

公开发布：get_blog_status核对站点、原文和发布版本。publish_blog_post须用户明确要求公开，提供原文版本/哈希和发布版本（首次0）；unpublish_blog_post显式撤下。两者版本冲突先用get_blog_status复核当前发布、原文和原意图；发布的原文变化时须读取并审阅最新正文，确认后用新requestId，不能只替换版本号。需独立blog:publish及读写权限、关闭只读并允许发布。私有修改不会自动更新公开快照。

完整请求最多128KiB，完整JSON-RPC响应最多64KiB。错误包含安全issues和recovery时据此修正；不要猜测ID、自动续读或越过权限。`;
}
