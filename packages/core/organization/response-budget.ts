import type {
  OrganizationOperation,
  OrganizationResult,
} from '../../../shared/organization-contracts.js';
import { limits, messageSize } from '../knowledge/limits.js';
import { fail } from '../knowledge/errors.js';

// messageSize uses 128 ordinary ID characters. A 128-character ID consisting of
// control characters needs 640 additional JSON escape bytes. Leave another KiB
// for transport metadata rather than budgeting only the internal receipt JSON.
const responseBudget = limits.response - 640 - 1024;
export function organizationResponseFits(data: unknown): boolean {
  return messageSize(data) <= responseBudget;
}
export function assertOrganizationReceiptFits(
  manifest: {
    operationId: string;
    libraryId: string;
    structureRevision: string;
    changes: OrganizationResult['changes'];
  },
  requestId: string,
  kind = 'organization.organize',
): void {
  const operation: OrganizationOperation = {
    operationId: manifest.operationId,
    requestId,
    kind,
    status: 'succeeded',
    result: {
      operationId: manifest.operationId,
      libraryId: manifest.libraryId,
      // A successful commit may advance the revision. Reserve at least 32 digits
      // and a carry digit for an already-long revision without constraining IDs.
      structureRevision: '9'.repeat(Math.max(32, manifest.structureRevision.length + 1)),
      changes: manifest.changes,
      indexState: 'pending',
      undoAvailable: false,
    },
  };
  if (
    !organizationResponseFits(operation) ||
    !organizationResponseFits({ kind: 'accepted', operation })
  ) {
    fail(413, 'RESPONSE_TOO_LARGE');
  }
}
