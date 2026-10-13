// Labels were authored by AI for an isolated synthetic corpus. Review before treating them as truth.
export interface BenchmarkDocument {
  path: string;
  title: string;
  content: string;
}
export interface BenchmarkQuestion {
  id: string;
  kind: 'chinese-short' | 'identifier' | 'paraphrase' | 'unrelated' | 'directory';
  query: string;
  expectedPaths: string[];
  directory?: string;
}
const topics = [
  [
    '备份',
    'backup_restore',
    '恢复备份',
    '数据库要做一致性导出，原文、历史和配置另存独立设备，并定期演练恢复。',
    '怎样避免机器坏掉后笔记彻底丢失？',
    'operations',
  ],
  [
    '租约',
    'lease_epoch',
    '任务租约',
    '后台任务用递增租约 epoch 防止旧 worker 提交，心跳续期，失去租约后停止发布。',
    '过时的后台进程怎样避免覆盖新结果？',
    'engineering',
  ],
  [
    '权限',
    'allowed_prefixes',
    '目录权限',
    '每个调用身份只能访问授权的目录前缀，检索和读取前复核权限，不能跨目录泄露私人资料。',
    '如何让一个客户端只看到指定目录？',
    'engineering',
  ],
  [
    '快照',
    'snapshot_id',
    '分页快照',
    '分页固定一个不可变快照，记录正文哈希和版本，源文件变化让旧 cursor 失效。',
    '多次读取怎样保证不会拼出两个版本的笔记？',
    'engineering',
  ],
  [
    '向量',
    'flat_file',
    '精确向量检索',
    '归一化 Float32 向量保存在不可变 segment，CPU 计算点积后取 top-k，查询固定 generation。',
    '没有向量数据库时怎样在本机搜索语义？',
    'engineering',
  ],
  [
    '融合',
    'reciprocal_rank_fusion',
    '混合结果排序',
    '文本和语义召回用 RRF 融合，每路贡献一除以六十加排名，不直接相加原始分数。',
    '关键词和语义搜索分数不一样，该怎样合并？',
    'engineering',
  ],
  [
    '分词',
    'jieba_search',
    '中文全文检索',
    '全文检索使用 jieba 搜索模式与 FTS5，短词以字符和二元词候选验证原文子串。',
    '只有两个汉字的查询怎么找到准确的片段？',
    'engineering',
  ],
  [
    '离线',
    'HF_HUB_OFFLINE',
    '本地模型离线',
    '本地模型固定修订版本并检查 SHA256，运行时关闭联网下载，缺少模型直接报告不可用。',
    '断网后模型能继续工作且不偷偷下载吗？',
    'operations',
  ],
  [
    '幂等',
    'request_id',
    '写入请求重试',
    '同身份和 requestId 的相同参数返回原操作，不同参数报冲突，传输超时先查询原任务结果。',
    '保存响应丢了以后再次请求怎样避免重复写入？',
    'engineering',
  ],
  [
    '取消',
    'operation_cancel',
    '保存任务取消',
    '准备阶段支持取消，进入 committing 后需要查询最终结果，不能因为断开连接就宣称写入失败。',
    '保存正在提交的时候断开网络会怎样？',
    'engineering',
  ],
  [
    '同步',
    'git_sync',
    'Git 更新核对',
    '在其他机器提交后本机拉取，结合 Git diff、文件监听、启动核对和全量哈希保证索引收敛。',
    '另一台电脑提交的笔记什么时候能被搜索到？',
    'operations',
  ],
  [
    '哈希',
    'strict_freshness',
    '严格搜索刷新',
    'strict 对授权范围核对内容哈希并等待索引屏障，最多十秒，超时返回 INDEX_NOT_READY。',
    '文件大小和时间都没变怎样发现内容被改了？',
    'engineering',
  ],
  [
    '补丁',
    'replace_range',
    '大文件局部修改',
    '范围补丁绑定快照和 SHA256，在 UTF8 字符边界修改，流式复制未改区域，保存结果只返回摘要。',
    '只读到一段的大笔记如何安全修改这一段？',
    'engineering',
  ],
  [
    '预算',
    'RESPONSE_TOO_LARGE',
    '消息响应预算',
    'MCP 完整响应最多六十四 KiB，JSON 双份兼容正文和元数据都算在内，正文单页最多十六 KiB。',
    '转义很多的片段怎么避免撑爆返回消息？',
    'engineering',
  ],
  [
    '密钥',
    'token_permissions',
    '凭据文件保护',
    '真实令牌保存在外部受控文件，权限设为六百，不写进知识库、日志、提交记录或聊天。',
    '服务口令应该放在哪里才能防止意外泄露？',
    'operations',
  ],
  [
    '冲突',
    'GIT_CONFLICT',
    '同步冲突处理',
    '未解决的 Git 冲突不发布索引，strict 返回明确错误，不能搜索冲突标记混入的正文。',
    '拉取产生冲突时怎样避免错误内容被检索？',
    'operations',
  ],
  [
    '磁盘',
    'ENOSPC',
    '磁盘容量不足',
    '快照、历史和临时文件预估所需空间，磁盘满保留原文并报告失败，不删除用户历史腾空间。',
    '保存到一半硬盘满了，原笔记会怎样？',
    'operations',
  ],
  [
    '压实',
    'segment_compaction',
    '向量段压实',
    'segment 数达到三十二或无效行达到百分之二十时安排后台压实，发布新的 generation。',
    '越来越多的旧向量文件该什么时候合并？',
    'engineering',
  ],
  [
    '缓存',
    'embedding_space_id',
    '向量缓存隔离',
    '向量缓存键包含模型空间和输入哈希，切换模型或标题上下文变化要生成新向量，不能混用。',
    '换了模型以后旧向量为什么不能继续用？',
    'engineering',
  ],
  [
    '归档',
    'recoverable_archive',
    '笔记可恢复归档',
    '归档进入可恢复回收流程，停用公开分享，并在当前搜索中排除，普通 MCP 不提供永久删除。',
    '不需要的笔记怎样移走又保留恢复机会？',
    'operations',
  ],
] as const;
export function syntheticFixture(seed = 20261014) {
  const documents: BenchmarkDocument[] = [],
    questions: BenchmarkQuestion[] = [];
  for (const [
    index,
    [short, identifier, title, description, paraphrase, directory],
  ] of topics.entries()) {
    const path = `00-Inbox/benchmark/${directory}/${String(index).padStart(2, '0')}-${identifier}.md`;
    documents.push({ path, title, content: `# ${title}\n\n${identifier}\n\n${description}\n` });
    for (const [kind, query] of [
      ['chinese-short', short],
      ['identifier', identifier],
      ['paraphrase', paraphrase],
    ] as const)
      questions.push({ id: `${index}-${kind}`, kind, query, expectedPaths: [path] });
    if (index < 6)
      questions.push({
        id: `${index}-directory`,
        kind: 'directory',
        query: paraphrase,
        expectedPaths: [path],
        directory: `00-Inbox/benchmark/${directory}`,
      });
  }
  for (const [index, query] of [
    '长颈鹿如何在月球做瑜伽',
    '火星企鹅烹饪酸奶',
    '量子芒果购买银河保险',
    'nonsense_quokka_zz9911',
    '维多利亚花园的门票是多少',
    '红海珊瑚如何繁殖',
  ].entries())
    questions.push({ id: `negative-${index}`, kind: 'unrelated', query, expectedPaths: [] });
  return {
    seed,
    labelProvenance: 'AI-authored synthetic labels; not a human gold standard',
    documents,
    questions,
  };
}
