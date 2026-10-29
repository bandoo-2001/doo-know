import type { Buffer } from 'node:buffer';
import type { Principal } from './knowledge-contracts.js';
import type { ServiceCallOptions } from '../packages/plugin-sdk/index.js';

export type McpBusinessDomain = 'knowledge' | 'blog' | 'to-doo';
export type McpTransferBinding = {
  domain: McpBusinessDomain;
  kind: string;
  id: string;
  revision?: string;
  metadata?: Record<string, string | number | boolean | null>;
};
export type McpTransferInfo = {
  transferId: string;
  direction: 'upload' | 'download';
  state: 'uploading' | 'ready' | 'completed' | 'cancelled';
  name: string;
  mime: string;
  totalBytes: number;
  receivedBytes: number;
  sha256: string | null;
  expiresAt: string;
  requestId: string;
  binding: McpTransferBinding;
  result?: Record<string, unknown>;
};
export type McpUploadInput = {
  requestId: string;
  binding: McpTransferBinding;
  name: string;
  mime: string;
  totalBytes: number;
  sha256?: string;
};
export type McpDownloadInput = Omit<McpUploadInput, 'totalBytes' | 'sha256'> & { bytes: Buffer };
export interface McpTransferStore {
  beginUpload(principal: Principal, input: McpUploadInput): McpTransferInfo;
  createDownload(principal: Principal, input: McpDownloadInput): McpTransferInfo;
  info(principal: Principal, transferId: string): McpTransferInfo;
  append(principal: Principal, input: { transferId: string; offset: number; base64: string }): McpTransferInfo;
  read(principal: Principal, input: { transferId: string; offset: number; maxBytes?: number }): {
    transferId: string; offset: number; nextOffset: number; totalBytes: number; base64: string; done: boolean; sha256: string;
  };
  readUpload(principal: Principal, transferId: string, expectedBinding?: McpTransferBinding, completionRequestId?: string): {
    bytes: Buffer; binding: McpTransferBinding; name: string; mime: string; sha256: string;
  };
  complete(principal: Principal, transferId: string, requestId: string, result: Record<string, unknown>): McpTransferInfo;
  cancel(principal: Principal, transferId: string): { transferId: string; cancelled: boolean; state: McpTransferInfo['state'] };
  cleanup(): void;
}
export interface McpDomainToolPort {
  call(tool: string, input: unknown, options?: ServiceCallOptions): Promise<Record<string, unknown>>;
}
export interface McpManagedDomainPort extends McpDomainToolPort {
  authorizeTransfer(binding: McpTransferBinding, write: boolean, options?: ServiceCallOptions, state?: McpTransferInfo['state']): Principal;
}
