import { portableResourceLimits } from './portable-resource-limits.js';
export const MEDIA_MIMES: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
});
export const mediaMime = (path: string) =>
  MEDIA_MIMES[path.slice(path.lastIndexOf('.')).toLowerCase()];
export const assetByteLimit = (path: string) =>
  mediaMime(path) ? portableResourceLimits.mediaBytes : portableResourceLimits.attachmentBytes;
export const attachmentAccept =
  'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf,video/mp4,video/webm,audio/mpeg,audio/wav';
