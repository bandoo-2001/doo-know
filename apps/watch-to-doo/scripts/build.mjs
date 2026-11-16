import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const project = fileURLToPath(new URL('../', import.meta.url))
const endpoint = process.env.TODOO_ORIGIN
if (!endpoint) throw new Error('设置 TODOO_ORIGIN 为手表可以访问的 Doo-Know HTTPS 站点地址。')
const url = new URL(endpoint)
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('TODOO_ORIGIN 必须是没有路径、账号和密码的 HTTPS 站点地址。')
}
writeFileSync(path.join(project, 'src/common/origin.js'), 'export default ' + JSON.stringify(url.origin) + '\n')
const mode = process.argv.includes('--release') ? 'release' : 'build'
const result = spawnSync(process.execPath, [path.join(project, 'node_modules/aiot-toolkit/lib/bin.js'), mode], {
  cwd: project, stdio: 'inherit'
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
