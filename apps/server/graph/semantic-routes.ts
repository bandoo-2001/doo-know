import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { createKnowledgeGraph } from '../../../packages/core/graph/knowledge-service.js';
import type {
  GraphExploreQuery,
  GraphModelPort,
  GraphModelUpdate,
  GraphQuestionInput,
  GraphUserCommand,
  GraphReviewQuery,
} from '../../../shared/graph-semantic-contracts.js';
import { graphEntityKinds } from '../../../shared/graph-semantic-contracts.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

type KnowledgeGraph = ReturnType<typeof createKnowledgeGraph>;
const modelMessages: Record<string, string> = {
  not_configured: '请先在模型设置中连接本地模型或模型 API',
  conflict: '模型设置已变化，请重新打开设置后重试',
  invalid_settings: '模型配置格式不正确，请检查地址、模型名称和高级参数',
  remote_content_disabled: '向此地址发送资料前，请在模型设置中明确允许',
  input_too_large: '本次分析内容超过模型输入范围，请缩小范围',
  busy: '模型正在处理其他请求，请稍后重试',
  aborted: '模型请求已取消',
  timeout: '模型响应超时，请检查连接或调整高级设置',
  network_error: '无法连接模型服务，请检查地址和运行状态',
  http_error: '模型服务拒绝了请求，请检查凭据、模型名称和协议模式',
  response_too_large: '模型返回内容过大，请缩小分析范围',
  invalid_response: '模型返回格式或证据不符合要求，请检查模型和输出模式',
  secret_unavailable: '模型凭据暂时无法读取，请重新保存凭据',
};
async function modelCall<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error && error.message.match(/^graph_model_([a-z_]+)$/)?.[1];
    if (!code) throw error;
    const status =
      code === 'conflict'
        ? 409
        : code === 'remote_content_disabled'
          ? 403
          : code === 'not_configured' || code === 'secret_unavailable'
            ? 503
            : code === 'busy'
              ? 429
              : code === 'timeout'
                ? 504
                : code === 'invalid_settings'
                  ? 400
                  : code === 'input_too_large'
                    ? 413
                    : code === 'aborted'
                      ? 409
                      : 502;
    return fail(
      status,
      'GRAPH_MODEL_' + code.toUpperCase(),
      modelMessages[code] || '模型请求未完成，请检查设置后重试',
      status >= 500 || status === 429,
    );
  }
}

function parseQuery(raw: Record<string, unknown>): GraphExploreQuery {
  const strings = ['folder', 'q', 'focus', 'target', 'view', 'mode'];
  const numbers = ['depth', 'limit', 'minConfidence', 'similarityThreshold'];
  const booleans = ['includeSuggested', 'includeSimilarity'];
  const arrays = ['nodeKinds', 'edgeKinds'];
  const keys = [...strings, ...numbers, ...booleans, ...arrays];
  if (Object.keys(raw).some((key) => !keys.includes(key)))
    fail(400, 'INVALID_INPUT', '包含不支持的图谱筛选参数');
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length > 2048)
      fail(400, 'INVALID_INPUT', '图谱筛选参数格式不正确');
    if (numbers.includes(key)) {
      if (!/^\d+(?:\.\d+)?$/.test(value)) fail(400, 'INVALID_INPUT', '图谱范围必须是有效数字');
      input[key] = Number(value);
    } else if (booleans.includes(key)) {
      if (!['true', 'false'].includes(value)) fail(400, 'INVALID_INPUT', '图谱筛选开关格式不正确');
      input[key] = value === 'true';
    } else if (arrays.includes(key)) input[key] = value ? value.split(',') : [];
    else input[key] = value;
  }
  if (
    (input.view !== undefined && !['notes', 'knowledge'].includes(String(input.view))) ||
    (input.mode !== undefined && !['all', 'orphans'].includes(String(input.mode))) ||
    (input.depth !== undefined && input.depth !== 1 && input.depth !== 2) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 1000)) ||
    (input.minConfidence !== undefined &&
      (!Number.isFinite(input.minConfidence) ||
        Number(input.minConfidence) < 0 ||
        Number(input.minConfidence) > 1)) ||
    (input.similarityThreshold !== undefined &&
      (!Number.isFinite(input.similarityThreshold) ||
        Number(input.similarityThreshold) < 0 ||
        Number(input.similarityThreshold) > 1)) ||
    (Array.isArray(input.nodeKinds) &&
      input.nodeKinds.some(
        (value) => !['note', ...graphEntityKinds].includes(String(value) as 'note'),
      )) ||
    (Array.isArray(input.edgeKinds) &&
      input.edgeKinds.some(
        (value) =>
          !['reference', 'mentions', 'cooccurs', 'similarity', 'semantic', 'manual'].includes(
            String(value),
          ),
      ))
  )
    fail(400, 'INVALID_INPUT', '图谱筛选值超出允许范围');
  return input as GraphExploreQuery;
}

export function registerSemanticGraphRoutes(
  app: FastifyInstance,
  getGraph: () => KnowledgeGraph,
  getModel: () => GraphModelPort,
) {
  const principal = (request: FastifyRequest) => {
    const ownerId = (request as unknown as { ownerId: string }).ownerId;
    return { ...webPrincipal, ownerId };
  };
  app.get(
    '/api/graph/explore',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    (request) =>
      getGraph().explore(principal(request), parseQuery(request.query as Record<string, unknown>)),
  );
  app.get('/api/graph/status', (request) => getGraph().status(principal(request)));
  app.get('/api/graph/settings', () => modelCall(() => getModel().settings()));
  app.put('/api/graph/settings', { bodyLimit: 32768 }, (request) =>
    modelCall(() => getModel().update(request.body as GraphModelUpdate)),
  );
  app.post(
    '/api/graph/settings/test',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async () => {
      const result = await modelCall(() => getModel().test());
      const code = result.message.match(/^graph_model_([a-z_]+)$/)?.[1];
      return {
        ok: result.ok,
        message: code
          ? modelMessages[code] || '模型连接未完成，请检查设置'
          : result.ok
            ? '模型连接正常'
            : '模型连接未完成，请检查设置',
      };
    },
  );
  app.post('/api/graph/jobs', (request) => {
    const body = request.body as { action?: unknown } | undefined;
    if (
      !body ||
      Object.keys(body).some((key) => key !== 'action') ||
      !['pause', 'resume', 'retry', 'rebuild', 'cancel'].includes(String(body.action))
    )
      fail(400, 'INVALID_INPUT', '图谱任务操作不正确');
    return getGraph().control(
      principal(request),
      body as { action: 'pause' | 'resume' | 'retry' | 'rebuild' | 'cancel' },
    );
  });
  app.get('/api/graph/review', (request) => {
    const raw = request.query as Record<string, unknown>;
    if (
      Object.keys(raw).some((key) => !['status', 'limit', 'offset', 'q'].includes(key)) ||
      (raw.status !== undefined &&
        !['suggested', 'accepted', 'ignored', 'manual'].includes(String(raw.status))) ||
      (raw.limit !== undefined &&
        (typeof raw.limit !== 'string' ||
          !/^\d+$/.test(raw.limit) ||
          Number(raw.limit) < 1 ||
          Number(raw.limit) > 100)) ||
      (raw.offset !== undefined &&
        (typeof raw.offset !== 'string' ||
          !/^\d+$/.test(raw.offset) ||
          Number(raw.offset) > 100000)) ||
      (raw.q !== undefined && (typeof raw.q !== 'string' || raw.q.length > 256))
    )
      fail(400, 'INVALID_INPUT', '审核筛选参数不正确');
    const input: GraphReviewQuery = {
      ...(raw.status ? { status: String(raw.status) as GraphReviewQuery['status'] } : {}),
      ...(raw.limit ? { limit: Number(raw.limit) } : {}),
      ...(raw.offset ? { offset: Number(raw.offset) } : {}),
      ...(raw.q ? { q: String(raw.q) } : {}),
    };
    return getGraph().review(principal(request), input);
  });
  app.get('/api/graph/state', (request) => getGraph().userState(principal(request)));
  app.post('/api/graph/commands', { bodyLimit: 128 * 1024 }, (request) =>
    getGraph().command(principal(request), request.body as GraphUserCommand),
  );
  app.post(
    '/api/graph/ask',
    { bodyLimit: 16384, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = request.body as GraphQuestionInput | undefined;
      if (
        !input ||
        Object.keys(input).some((key) => !['question', 'nodeId'].includes(key)) ||
        typeof input.question !== 'string' ||
        !input.question.trim() ||
        input.question.length > 2000 ||
        (input.nodeId !== undefined &&
          (typeof input.nodeId !== 'string' || input.nodeId.length > 256))
      )
        fail(400, 'INVALID_INPUT', '请输入有效的问题');
      const model = getModel();
      if (model.settings().provider === 'none')
        fail(503, 'GRAPH_MODEL_NOT_CONFIGURED', modelMessages.not_configured, true);
      const p = principal(request),
        graph = getGraph();
      const available = await graph.questionContext(p, input);
      const evidence: typeof available = [];
      const context: { id: string; text: string; title: string }[] = [];
      for (const item of available) {
        const next = { id: item.id, text: item.quote, title: item.title };
        if (
          JSON.stringify({ question: input.question, context: [...context, next] }).length >
          model.settings().maxInputCharacters
        )
          continue;
        context.push(next);
        evidence.push(item);
      }
      if (available.length && !evidence.length)
        fail(
          413,
          'GRAPH_MODEL_INPUT_TOO_LARGE',
          '问题与证据超过模型输入范围，请缩短问题或调整高级设置',
        );
      if (!evidence.length)
        return {
          answer: '当前范围内没有可引用的原文证据，请先选择相关笔记或完成资料分析。',
          citations: [],
          evidence: [],
        };
      const controller = new AbortController();
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', disconnect);
      try {
        const answer = await modelCall(() =>
          model.answer(input.question, context, controller.signal),
        );
        const fresh = new Map(
          (await graph.questionContext(p, input)).map((item) => [item.id, item]),
        );
        const cited = answer.citations.map((id) => evidence.find((item) => item.id === id));
        if (cited.some((item) => !item || fresh.get(item.id)?.sourceHash !== item.sourceHash))
          fail(409, 'GRAPH_CHANGED', '原文已变化，请重新提问', true);
        return {
          ...answer,
          evidence: cited.filter((item): item is NonNullable<typeof item> => !!item),
        };
      } finally {
        reply.raw.removeListener('close', disconnect);
      }
    },
  );
}
