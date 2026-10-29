import { z } from 'zod';
import type { Operation } from './operations.js';
import type { KnowledgeClient } from './service.js';
import { toDooCommandSchema } from '../../../shared/to-doo-contracts.js';
import {
  toDooMcpQuery,
  toDooMcpQueryResult,
  toDooMcpReceipt,
  toDooMcpContextResult,
} from '../../../shared/to-doo-mcp-contracts.js';

const command = (action: string) =>
  toDooCommandSchema.options.find((schema) => schema.shape.action.value === action)!;
const payload = (action: string) => command(action).shape.payload;
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const data = (schema: z.ZodType) => z.object({ data: schema }).strict();

export function createToDooOperations(client: KnowledgeClient): Operation[] {
  return [
    {
      name: 'query_to_doos',
      description:
        '按领域、清单、条件和日期窗口分页查询 To Doo。大批提交可用 receiptRequestId 和 nextCursor 分页核对完整回执。长文本指定单个 ids、field、offset、maxBytes、expectedRevision，按 fieldRange.nextByte 续读。资料原文仍需知识权限。',
      scope: 'to-doo:read',
      readOnly: true,
      input: toDooMcpQuery,
      output: data(toDooMcpQueryResult),
      run: (p, a, o) => client.toDooQuery(p, a, o),
    },
    {
      name: 'get_to_doo_context',
      description:
        '读取获准目标或任务的行动、资料关联与进展上下文；只含当前授权范围，不自动安排任务。',
      scope: 'to-doo:read',
      readOnly: true,
      input: z
        .object({
          listId: z.string().max(128).optional(),
          taskId: z.string().max(128).optional(),
          limit: z.number().int().min(1).max(30).default(10),
        })
        .strict(),
      output: data(toDooMcpContextResult),
      run: (p, a, o) => client.toDooContext(p, a, o),
    },
    {
      name: 'create_to_doo_task',
      description:
        '按用户要求创建任务，可附清单、日期、重复和资料引用。以 requestId 重试核对原结果，不重复创建。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      input: (payload('create_task') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'create_task', payload: a }, o),
    },
    {
      name: 'update_to_doo_task',
      description:
        '按稳定任务 ID 和 expectedRevision 修改任务定义；版本冲突先复核，不覆盖后来的编辑。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      input: (payload('update_task') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'update_task', payload: a }, o),
    },
    {
      name: 'set_to_doo_status',
      description:
        '完成、重开、跳过或取消具体执行实例。重复任务须先查实例 ID；cascade 会影响后代，必须符合用户授权。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      input: (payload('set_occurrence_status') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'set_occurrence_status', payload: a }, o),
    },
    {
      name: 'batch_to_doos',
      description:
        '按明确选择范围原子批量修改、完成、复制、移动或删除任务。提交前核对全部预期版本和连带后代；不得扩大用户范围。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      destructive: true,
      input: (payload('batch_tasks') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'batch_tasks', payload: a }, o),
    },
    {
      name: 'preview_to_doo_plan',
      description:
        '验证时间安排建议，返回冲突及基准版本；纯预览不保存或安排任务，只有用户授权后才能调用 apply_to_doo_plan。',
      scope: 'to-doo:read',
      readOnly: true,
      input: (payload('preview_plan') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'preview_plan', payload: a }, o),
    },
    {
      name: 'apply_to_doo_plan',
      description:
        '用户已经明确授权后，核对建议中所有实例的当前版本并原子应用；过期建议必须重新预览，不自动改成新版本覆盖。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      input: (payload('apply_plan') as z.ZodObject).extend({ requestId }).strict(),
      output: data(toDooMcpReceipt),
      run: (p, { requestId, ...a }, o) =>
        client.toDooCommand(p, { requestId, action: 'apply_plan', payload: a }, o),
    },
    {
      name: 'manage_to_doo',
      description:
        '管理已授权领域的清单、资料成果、重复、专注、习惯、纪念日、模板或记录。command 使用 To Doo 判别命令，后端严格校验字段/版本/范围；不能传文件路径、SQL或权限。',
      scope: 'to-doo:write',
      additionalScopes: ['to-doo:read'],
      readOnly: false,
      input: z
        .object({
          requestId,
          action: z.enum([
            'save_entity',
            'save_outcome',
            'delete_entity',
            'materialize_occurrences',
            'change_recurrence',
            'start_focus',
            'control_focus',
            'checkin_habit',
            'apply_template',
          ]),
          payload: z.record(z.string(), z.unknown()),
        })
        .strict(),
      output: data(toDooMcpReceipt),
      run: (p, a, o) => client.toDooCommand(p, a, o),
    },
  ];
}
