export function renderInstaller(template, helper, { source, version, nodeSha256 }) {
  // Function replacements preserve Bash's $'...', $& and other dollar syntax.
  return template
    .replace('# __DOOKNOW_GITHUB_FETCH_FUNCTION__', () => helper)
    .replace('__DOOKNOW_RELEASE_SOURCE__', () => source.replace(/\/$/, ''))
    .replaceAll('__DOOKNOW_RELEASE_VERSION__', version)
    .replace('__DOOKNOW_NODE_BINARY_SHA__', nodeSha256);
}
