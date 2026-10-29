/** Host-owned business permissions. A resource identity is scoped by its domain grant. */
export type ResourceRef = { kind: string; id: string };
export type ResourceSet = { mode: 'all' } | { mode: 'selected'; resources: ResourceRef[] };
export type DomainGrant = {
  enabled: boolean;
  ownerId: string;
  instanceId: string;
  actions: string[];
  resources: ResourceSet;
};
export type PermissionPolicy = { version: 2; domains: Record<string, DomainGrant> };
export type PermissionRequirement = { domain: string; action: string; resources?: ResourceRef[] };
export type PermissionDomainDefinition = {
  id: string;
  title: string;
  implemented: boolean;
  resourceKinds: readonly string[];
  actions: readonly { id: string; title: string; description: string; implemented: boolean }[];
};
const action = (id: string, title: string, description: string, implemented = true) => ({
  id,
  title,
  description,
  implemented,
});
export const permissionDomains: readonly PermissionDomainDefinition[] = [
  {
    id: 'knowledge',
    title: '知识库',
    implemented: true,
    resourceKinds: ['directory', 'note'],
    actions: [
      action('read', '读取', '读取授权笔记和目录'),
      action('write', '内容编辑', '创建和修改笔记内容'),
      action('organize', '自主整理', '创建目录、移动和重命名笔记及目录'),
      action('archive', '归档', '归档及恢复笔记'),
      action('index', '维护索引', '刷新和查看检索索引'),
      action('share', '分享管理', '显式创建、轮换和撤销资料分享'),
      action('manage', '资料维护', '管理回收站和资料维护设置'),
    ],
  },
  {
    id: 'blog',
    title: '博客',
    implemented: true,
    resourceKinds: ['site', 'post'],
    actions: [
      action('read', '查看', '查看博客发布状态'),
      action('write', '编辑草稿', '创建和编辑博客草稿及文章元信息，不公开发布'),
      action('manage', '站点与文章管理', '管理获准站点设置及文章删除，不隐含公开发布'),
      action('publish', '公开发布', '显式公开发布及撤下文章，需原文和附件读取权'),
    ],
  },
  {
    id: 'to-doo',
    title: 'To Doo',
    implemented: true,
    resourceKinds: ['list'],
    actions: [
      action('read', '读取', '读取授权清单与内容类别中的任务及记录'),
      action('write', '编辑', '创建和修改授权清单与内容类别中的任务及记录'),
      action('share', '导出与分享', '导出授权数据并显式管理私有订阅'),
      action('integrations', '外部连接与设备', '管理导入、外部日历及提醒设备'),
    ],
  },
];
export const implementedResourceScopes = permissionDomains.flatMap((domain) =>
  domain.implemented
    ? domain.actions
        .filter((action) => action.implemented)
        .map((action) => `${domain.id}:${action.id}`)
    : [],
);

/** Host tool dependencies; every listed action is checked again at invocation. */
export const v2ToolRequirements: Readonly<Record<string, readonly string[]>> = {
  get_mcp_context: [],
  list_directories: ['knowledge:read'],
  organize_library: ['knowledge:read', 'knowledge:write', 'knowledge:organize'],
  undo_organization: ['knowledge:read', 'knowledge:write', 'knowledge:organize'],
  list_organization_history: ['knowledge:read'],
  get_blog_status: ['knowledge:read', 'blog:read'],
  publish_blog_post: ['knowledge:read', 'blog:publish'],
  unpublish_blog_post: ['knowledge:read', 'blog:publish'],
  archive_note: ['knowledge:write', 'knowledge:archive'],
};
