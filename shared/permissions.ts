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
    ],
  },
  {
    id: 'blog',
    title: '博客',
    implemented: true,
    resourceKinds: ['site', 'post'],
    actions: [
      action('read', '查看', '查看博客发布状态'),
      action('publish', '公开发布', '显式公开发布及撤下文章，需原文和附件读取权'),
    ],
  },
  {
    id: 'todo',
    title: '待办',
    implemented: false,
    resourceKinds: ['list', 'task'],
    actions: [
      action('read', '读取', '读取待办', false),
      action('write', '编辑', '编辑待办', false),
      action('organize', '整理', '整理待办', false),
      action('archive', '归档', '归档待办', false),
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
