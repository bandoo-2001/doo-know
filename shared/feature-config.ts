export const featureIds = ['git', 'mcp'] as const;
export type FeatureId = (typeof featureIds)[number];

export const featureConfig = {
  git: {
    type: 'object',
    additionalProperties: false,
    properties: {
      authorName: {
        type: 'string',
        title: '提交作者',
        default: '',
        maxLength: 100,
        description: '用于本地版本记录的署名，不要求关联 GitHub 账号。',
      },
      authorEmail: {
        type: 'string',
        title: '作者邮箱',
        default: '',
        maxLength: 254,
        description: '用于版本记录的署名邮箱，不会发送邮件；不是登录凭据。',
      },
    },
  },
  mcp: {
    type: 'object',
    additionalProperties: false,
    properties: {
      oauthEnabled: {
        type: 'boolean',
        title: '启用 OAuth 连接',
        default: true,
      },
      apiKeyEnabled: {
        type: 'boolean',
        title: '启用 API Key 连接',
        default: true,
      },
      readOnly: {
        type: 'boolean',
        title: '只读访问',
        default: true,
      },
      allowIndex: {
        type: 'boolean',
        title: '允许维护检索索引',
        default: false,
      },
      allowPublish: {
        type: 'boolean',
        title: '允许公开发布博客',
        description:
          '默认关闭。开启后仍须关闭只读访问，并单独授予客户端博客公开发布权限；普通笔记写入授权不会公开资料。',
        default: false,
      },
      allowToDoo: {
        type: 'boolean',
        title: '允许连接 To Doo',
        description: '默认关闭。允许客户端单独申请任务读取权限；不会自动扩大已有连接的授权。',
        default: false,
      },
      allowToDooWrite: {
        type: 'boolean',
        title: '允许修改 To Doo',
        description: '还需要关闭只读访问，并为客户端单独授予 To Doo 写权限。',
        default: false,
      },
      toDooListIds: {
        type: 'array',
        title: '允许访问的 To Doo 清单',
        description:
          '留空表示全部清单，也可以只选择部分清单和收集箱。修改后作用于所有 To Doo 连接。',
        items: {
          type: 'string',
          maxLength: 128,
        },
        maxItems: 100,
        default: [],
      },
      toDooDomains: {
        type: 'array',
        title: '允许的 To Doo 内容',
        description:
          '选择连接可以读取和维护哪些内容，未选中的类别不会开放。修改后作用于所有 To Doo 连接。',
        items: {
          type: 'string',
          enum: [
            'tasks',
            'records',
            'focus',
            'habits',
            'anniversaries',
            'calendar',
            'statistics',
            'settings',
          ],
        },
        maxItems: 8,
        default: ['tasks'],
      },
      allowedPrefixes: {
        type: 'array',
        title: '允许访问的目录',
        items: {
          type: 'string',
        },
        minItems: 1,
        maxItems: 64,
        default: [
          'README.md',
          '00-Inbox',
          '10-Projects',
          '20-Areas',
          '30-Knowledge',
          '40-Resources',
          '50-Journal',
          '90-Archive',
          '99-System',
        ],
      },
      externalWebOrigin: {
        type: 'string',
        title: '外部网页地址',
        description: '可选的 HTTPS 网页地址，用于返回可访问的资料链接。留空不返回网页链接。',
        default: '',
        maxLength: 2048,
      },
      permissionPolicy: {
        type: 'object',
        title: '分域权限',
        description: '按业务域设置操作和稳定资源范围；扩大上限后，已有客户端仍需重新授权。',
        additionalProperties: false,
        required: ['version', 'domains'],
        properties: {
          version: {
            const: 2,
          },
          domains: {
            type: 'object',
          },
        },
      },
    },
  },
};

export const featureCapabilities: Record<FeatureId, string[]> = {
  git: ['knowledge:read', 'knowledge:write', 'workspace:git'],
  mcp: [
    'knowledge:read',
    'knowledge:write',
    'knowledge:organize',
    'knowledge:archive',
    'knowledge:index',
    'blog:read',
    'blog:publish',
    'to-doo:read',
    'to-doo:write',
    'knowledge:share',
    'knowledge:manage',
    'blog:write',
    'blog:manage',
    'to-doo:share',
    'to-doo:integrations',
    'protocol:mcp',
  ],
};
