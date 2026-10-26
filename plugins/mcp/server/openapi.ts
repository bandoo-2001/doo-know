import { z } from "zod";
import { createOperations } from "./operations.js";
import { bridgeErrorSchema } from "./errors.js";
export function buildOpenApi(
  operations: ReturnType<typeof createOperations>["operations"],
  resource = "https://bridge.example.invalid/mcp",
) {
  const paths: Record<string, unknown> = {};
  for (const op of operations) {
    const input = z.toJSONSchema(op.input, { target: "draft-2020-12", io: "input" }),
      output = z.toJSONSchema(
        op.research ? z.object({ data: op.output }).strict() : op.output,
        { target: "draft-2020-12" },
      );
    paths["/api/v1/tools/" + op.name] = {
      post: {
        operationId: op.name,
        summary: op.description,
        tags: [op.readOnly ? "读取" : "修改"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: input } },
        },
        responses: {
          "200": {
            description: "有界完整业务结果；接受后台操作不表示任务已完成",
            content: { "application/json": { schema: output } },
          },
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 413, 429, 502, 503, 504].map((status) => [
              status,
              {
                description: "标准业务错误；未知写入结果保留原requestId",
                content: { "application/json": { schema: bridgeErrorSchema } },
              },
            ]),
          ),
        },
        "x-required-scope": op.scope,
        "x-required-scopes": [op.scope, ...(op.additionalScopes || [])],
        "x-mcp-tool": op.name,
        "x-read-only": op.readOnly,
        "x-request-max-bytes": 131072,
        "x-jsonrpc-response-max-bytes": 65536,
        "x-inline-write-max-utf8-bytes": 32768,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "DooKnow MCP",
      version: "1.1.1",
      description:
        "同源MCP与REST契约。完整请求128KiB、MCP JSONRPC完整响应64KiB；外部OAuth与独立Bearer均不转交后端。",
    },
    servers: [{ url: new URL(resource).origin }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "外部发行者OAuth访问令牌或可撤销独立访问令牌",
        },
      },
    },
  };
}
