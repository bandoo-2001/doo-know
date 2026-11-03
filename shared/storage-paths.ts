/** Disk namespaces only. Public /api/assets URLs and app-local assets retain their names. */
export const DOO_DATA_DIRECTORY = '_doo-data';
export const LEGACY_DATA_DIRECTORY = '_data';
export const DOO_ASSETS_DIRECTORY = '_doo-assets';
export function isKnowledgeDataPath(path: string) {
  const first = path.split('/')[0];
  return first === DOO_DATA_DIRECTORY || first === LEGACY_DATA_DIRECTORY;
}
export function isDooAssetPath(path: string) {
  return path.split('/').includes(DOO_ASSETS_DIRECTORY);
}
/** Legacy resources remain readable while an upgrade is planned/applied. */
export function isCompatibleAssetPath(path: string) {
  return isDooAssetPath(path) || path.split('/').includes('assets');
}
