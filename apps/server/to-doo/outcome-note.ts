import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import type { ToDooService, ToDooEntityMap } from '../../../shared/to-doo-contracts.js';
import { toDooId } from '../../../shared/to-doo-contracts.js';
import { mutationCore, webPrincipal } from '../../../packages/core/knowledge/core.js';
import { safePath, validateRelative } from '../../../packages/core/files.js';
import { HttpError } from '../../../packages/core/errors.js';
import { workspaceWriteSync } from '../../../packages/core/workspace/gate.js';
import { KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { authorizePath, requireScope } from '../../../packages/core/agent/auth.js';

export const outcomeNoteInput = z
  .object({
    requestId: toDooId,
    operationId: toDooId.optional(),
    occurrenceId: toDooId,
    expectedRevision: toDooId,
    title: z.string().min(1).max(256),
    folderPath: z.string().max(1024).optional(),
    content: z
      .string()
      .max(65536)
      .refine((value) => Buffer.byteLength(value) <= 65536),
    verification: z
      .enum(['self_assessed', 'practice', 'reviewed', 'delivered'])
      .default('self_assessed'),
    complete: z.boolean().default(false),
    criteriaResults: z
      .array(z.object({ label: z.string().max(1000), passed: z.boolean() }).strict())
      .max(100)
      .default([]),
  })
  .strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function createOutcomeNoteService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  todo: ToDooService,
  caller?: {
    authorize(occurrenceId: string, relativePath?: string, noteId?: string | null): Principal;
  },
) {
  function create(raw: z.input<typeof outcomeNoteInput>) {
    const input = outcomeNoteInput.parse(raw);
    const admitted = caller?.authorize(input.occurrenceId);
    const callerIdentity = admitted ? JSON.stringify([admitted.id, admitted.clientId]) : '';
    const operationId =
      input.operationId ??
      'out_' +
        hash(
          admitted
            ? JSON.stringify([admitted.id, admitted.clientId, input.requestId])
            : input.requestId,
        ).slice(0, 40);
    const finishRequest = 'finish_' + hash(operationId).slice(0, 40);
    return workspaceWriteSync(db, { kind: 'to-doo.outcome-note' }, () => {
      let operation = todo.getEntity('operation', operationId) as
        | ToDooEntityMap['operation']
        | undefined;
      let noteId = operation?.noteId ?? null;
      if (caller && operation && operation.callerIdentity !== hash(callerIdentity))
        throw new HttpError(403, '成果操作不属于当前调用者');
      let folderPath = input.folderPath ?? operation?.folderPath;
      if (folderPath === undefined)
        folderPath = existsSync(config.knowledgeRoot + '/00-Inbox') ? '00-Inbox' : '';
      if (folderPath) validateRelative(folderPath, 'folder');
      function authorized(relativePath?: string) {
        const principal =
          caller?.authorize(input.occurrenceId, relativePath, noteId) ?? webPrincipal;
        if (caller) {
          requireScope(principal, 'knowledge:read');
          requireScope(principal, 'knowledge:write');
          if (relativePath) {
            authorizePath(principal, relativePath, 'knowledge:read');
            authorizePath(principal, relativePath, 'knowledge:write');
          }
        }
        return principal;
      }
      authorized(
        operation
          ? (operation.folderPath ? operation.folderPath + '/' : '') + operation.fileName
          : undefined,
      );
      const fingerprint = hash(
        JSON.stringify({
          version: 1,
          occurrenceId: input.occurrenceId,
          title: input.title,
          folderPath,
          content: input.content,
          verification: input.verification,
          complete: input.complete,
          criteriaResults: input.criteriaResults,
        }),
      );
      if (operation && operation.fingerprint !== fingerprint)
        throw new HttpError(409, '此操作已有不同的成果内容，请核对已保存笔记后发起新的操作', {
          code: 'OUTCOME_INTENT_CHANGED',
          operationId,
          noteId,
          needsReconciliation: true,
        });
      if (input.operationId && !operation) throw new HttpError(404, '成果操作不存在或尚未同步');
      if (operation?.state === 'completed') {
        const receipt = todo.getReceipt(finishRequest);
        if (!noteId || !receipt)
          throw new HttpError(409, '成果操作的回执尚未完整同步', {
            operationId,
            noteId,
            needsReconciliation: true,
          });
        return {
          noteId,
          operationId,
          snapshot: todo.snapshot({
            taskIds: [
              (todo.getEntity('occurrence', input.occurrenceId) as ToDooEntityMap['occurrence'])
                ?.taskId,
            ].filter(Boolean),
          }),
          result: { ...receipt, replayed: true },
        };
      }
      const occurrence = todo.getEntity('occurrence', input.occurrenceId) as
        | ToDooEntityMap['occurrence']
        | undefined;
      if (!occurrence || occurrence.deletedAt) throw new HttpError(404, '任务实例不存在或已删除');
      if (occurrence.revision !== input.expectedRevision)
        throw new HttpError(409, '任务版本已变化，请核对后继续', {
          operationId: operation?.id ?? null,
          noteId,
          needsReconciliation: !!operation,
        });
      const task = todo.getEntity('task', occurrence.taskId) as ToDooEntityMap['task'] | undefined;
      if (!task || task.deletedAt) throw new HttpError(404, '任务不存在或已删除');
      if (input.complete) {
        const state = todo.snapshot({ taskIds: [task.id], includeTree: true, limit: 1000 });
        if (
          state.occurrences.some(
            (item) =>
              item.parentOccurrenceId === occurrence.id &&
              !item.deletedAt &&
              !['done', 'cancelled', 'skipped'].includes(item.status),
          )
        )
          throw new HttpError(409, '仍有未完成子任务，请先处理子项，或取消“同时完成任务”', {
            operationId: operation?.id ?? null,
            noteId,
            needsReconciliation: !!operation,
          });
      }
      try {
        if (!operation) {
          const stem =
            Array.from(
              input.title
                .normalize('NFC')
                .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
                .replace(/^\.+/, '')
                .trim(),
            )
              .slice(0, 40)
              .join('') || '成果';
          const fileName = stem + '-' + hash(operationId).slice(0, 24) + '.md';
          authorized(folderPath ? folderPath + '/' + fileName : fileName);
          todo.command({
            requestId: 'prepare_' + hash(operationId).slice(0, 40),
            action: 'save_entity',
            payload: {
              kind: 'operation',
              entity: {
                id: operationId,
                kind: 'outcome_note',
                ...(caller ? { callerIdentity: hash(callerIdentity) } : {}),
                requestId: input.requestId,
                fingerprint,
                occurrenceId: input.occurrenceId,
                expectedRevision: input.expectedRevision,
                title: input.title,
                folderPath,
                fileName,
                content: input.content,
                verification: input.verification,
                complete: input.complete,
                criteriaResults: input.criteriaResults,
                noteId: null,
                state: 'prepared',
              },
            },
          });
          operation = todo.getEntity('operation', operationId) as ToDooEntityMap['operation'];
        }
        if (input.operationId && operation.expectedRevision !== input.expectedRevision) {
          todo.command({
            requestId: 'resume_' + hash(operationId + input.expectedRevision).slice(0, 40),
            action: 'save_entity',
            payload: {
              kind: 'operation',
              entity: { ...operation, expectedRevision: input.expectedRevision },
              expectedRevision: operation.revision,
            },
          });
          operation = todo.getEntity('operation', operationId) as ToDooEntityMap['operation'];
        }
        if (!noteId) {
          const relativePath = operation.folderPath
            ? operation.folderPath + '/' + operation.fileName
            : operation.fileName;
          authorized(relativePath);
          const file = safePath(config.knowledgeRoot, relativePath, 'note', true);
          if (existsSync(file)) {
            if (hash(readFileSync(file, 'utf8')) !== hash(operation.content))
              throw new HttpError(409, '预定成果文件已有不同内容，请核对，原文件未被覆盖');
            const pending = db
              .prepare(
                "SELECT note_id FROM write_intents WHERE path=? AND status IN ('prepared','conflicted')",
              )
              .get(relativePath) as { note_id: string } | undefined;
            if (pending) {
              noteId = pending.note_id;
              throw new HttpError(409, '笔记写入仍需核对，请先完成知识库恢复步骤');
            }
            notes.scan();
            const row = db.prepare('SELECT id,active FROM notes WHERE path=?').get(relativePath) as
              | { id: string; active: number }
              | undefined;
            if (!row?.active) throw new HttpError(409, '成果笔记身份尚未恢复，请刷新知识库后重试');
            noteId = row.id;
          } else {
            const previous = db.prepare('SELECT id FROM notes WHERE path=?').get(relativePath) as
              | { id: string }
              | undefined;
            if (previous)
              throw new HttpError(409, '成果笔记已被移动或删除，请核对原笔记，不会重新创建');
            const result = mutationCore(config, db).create(
              caller
                ? authorized(relativePath)
                : { ...webPrincipal, allowedPrefixes: [relativePath] },
              operation.folderPath,
              operation.fileName,
              operation.content,
              'note_' + hash(operationId).slice(0, 40),
            );
            noteId = result.id;
          }
          authorized(relativePath);
          todo.command({
            requestId: 'link_' + hash(operationId).slice(0, 40),
            action: 'save_entity',
            payload: {
              kind: 'operation',
              entity: { ...operation, noteId, state: 'note_saved' },
              expectedRevision: operation.revision,
            },
          });
          operation = todo.getEntity('operation', operationId) as ToDooEntityMap['operation'];
        }
        // Preserve later edits to an already saved note; never overwrite them to finish a task.
        if (!noteId) throw new HttpError(409, '成果笔记身份尚待核对');
        authorized((operation.folderPath ? operation.folderPath + '/' : '') + operation.fileName);
        const note = notes.getNote(noteId);
        if (hash(note.content) !== hash(input.content))
          throw new HttpError(409, '成果笔记已发生后续修改，请打开核对后再关联');
        authorized(note.relativePath);
        const result = todo.command({
          requestId: finishRequest,
          action: 'save_outcome',
          payload: {
            occurrenceId: input.occurrenceId,
            expectedRevision: input.expectedRevision,
            outcome: {
              id: 'result_' + hash(operationId).slice(0, 40),
              summary: input.title,
              verification: input.verification,
              criteriaResults: input.criteriaResults,
              evidenceRefs: [{ noteId, role: 'output' }],
            },
            complete: input.complete,
            operationId,
          },
        });
        return { noteId, operationId, snapshot: result.snapshot, result };
      } catch (cause) {
        const status = (cause as { statusCode?: number }).statusCode;
        throw new HttpError(
          status && status >= 400 && status < 500 ? status : 409,
          cause instanceof HttpError || cause instanceof KnowledgeError
            ? cause.message
            : noteId
              ? '成果笔记已保存，后续操作尚待核对，请保留输入后重试'
              : '成果操作尚未完成，请保留输入后重试',
          { code: 'OUTCOME_NEEDS_RECONCILIATION', operationId, noteId, needsReconciliation: true },
        );
      }
    });
  }
  return { create };
}
