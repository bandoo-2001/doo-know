/** Disk namespaces only. Public /api/assets URLs and app-local assets retain their names. */
export const DOO_DATA_DIRECTORY = '_doo-data';
export const DOO_ASSETS_DIRECTORY = '_doo-assets';
export function isKnowledgeDataPath(path: string) {
  return path.split('/')[0] === DOO_DATA_DIRECTORY;
}
export function isDooAssetPath(path: string) {
  return path.split('/').includes(DOO_ASSETS_DIRECTORY);
}
