export type SharePermission = 'view' | 'edit';
export type ShareState = 'private' | 'active' | 'expired' | 'revoked';

export interface ShareOptions {
  permission?: SharePermission;
  expiresAt?: string | null;
}

export interface ShareStatus {
  enabled: boolean;
  state: ShareState;
  permission: SharePermission;
  expiresAt: string | null;
  token?: string;
  url?: string;
  editSupported: boolean;
  editUnavailableReason?: string;
}

export interface PublicShareAccess {
  permission: SharePermission;
  expiresAt: string | null;
  canEdit: boolean;
  editUnavailableReason?: string;
}

export interface PublicShareSource extends PublicShareAccess {
  title: string;
  content: string;
  modifiedAt: string;
  documentType: 'markdown';
}

export interface ShareSaveInput {
  content: string;
  expectedModifiedAt: string;
  requestId: string;
}

export interface ShareSaveReply {
  saved: true;
  modifiedAt: string;
  updatedAt: string;
}
