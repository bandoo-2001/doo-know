import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// Exercise the page and networking code emitted by Xiaomi's compiler.
// Only the two device APIs (network and local storage) are substituted.
const bundle = (await readFile(new URL('../build/pages/home/index.js', import.meta.url), 'utf8'))
  .replace(/^export default function/, '(function') + ')'

function startWatch(data, respond) {
  const api = {
    '@app-module/system.storage': {
      get({ key, success }) { success(data.get(key) || '') },
      set({ key, value, success }) { data.set(key, value); success() },
    },
    '@app-module/system.fetch': {
      fetch(options) {
        const url = new URL(options.url)
        const body = options.data && JSON.parse(options.data)
        const [status, result] = respond(url.pathname.split('/v1/')[1], body, options.header, url.searchParams)
        if (!status) options.fail()
        else options.success({ code: status, data: JSON.stringify(result) })
      },
    },
  }
  const device = { setTimeout, clearTimeout, setInterval, clearInterval, $app_require$: key => api[key] }
  const load = runInNewContext(bundle, { $app_require$: device.$app_require$ })
  const entry = {}
  const exports = {}
  load(device, device, device, entry)
  entry.entry(exports)
  const page = Object.assign({}, exports.default, exports.default.data)
  page.onInit()
  return page
}

function snapshot() {
  return {
    date: '2026-11-16', focusMinutes: 25, focus: null, lists: [{ id: 'inbox', name: '收集箱' }],
    tasks: [{ id: 'o1', title: '准备材料', revision: 'r1', listId: 'inbox' }],
    habits: [{ id: 'drink', name: '喝水', mode: 'quantity', checked: true, date: '2026-11-16', amount: 2, target: 6, unit: '杯' }],
    hasMore: { lists: false, tasks: false, habits: false },
  }
}

test('pair, filter tasks, complete one, and control the shared focus session', async () => {
  const storage = new Map()
  const state = snapshot()
  const commands = []
  let claimCount = 0
  let today
  const page = startWatch(storage, (path, body, header, query) => {
    if (path === 'pair/start') return [200, { userCode: 'ABCDE234', deviceCode: 'claim', expiresIn: 300 }]
    if (path === 'pair/claim') {
      assert.equal(body.deviceCode, 'claim')
      return [200, ++claimCount < 2 ? { status: 'pending' } : { status: 'paired', token: 'test-device' }]
    }
    assert.equal(header.Authorization, 'Bearer test-device')
    if (path === 'state') { today = query.get('today'); return [200, state] }
    commands.push(body)
    if (body.action === 'set_occurrence_status') state.tasks = []
    if (body.action === 'start_focus') {
      state.focus = { id: 'f1', revision: 'f1', mode: 'pomodoro', title: '专注', targetMinutes: 25, elapsedSeconds: 0, status: 'running' }
    }
    if (body.action === 'control_focus') {
      if (body.payload.operation === 'finish') state.focus = null
      else state.focus = { ...state.focus, status: body.payload.operation === 'pause' ? 'paused' : 'running', revision: state.focus.revision + 'x' }
    }
    return [200, { ok: true }]
  })
  await page.refresh()
  assert.equal(page.pairCode, 'ABCDE234')
  await page.refresh()
  assert.equal(page.ready, true)
  await page.choose('lists')
  await page.choose('today')
  assert.equal(today, '1')
  await page.choose('task:o1')
  await page.choose('complete')
  assert.equal(page.rows[0].label, '没有未完成任务')
  assert.deepEqual(commands[0].payload, { id: 'o1', status: 'done', expectedRevision: 'r1' })
  page.goBack()
  page.goBack()
  await page.choose('focus')
  await page.choose('pomodoro')
  assert.equal(page.rows[0].label, '25:00')
  await page.choose('pause')
  assert.ok(page.rows.some(row => row.key === 'resume'))
  await page.choose('resume')
  await page.choose('finish')
  assert.ok(page.rows.some(row => row.key === 'pomodoro'))
  assert.deepEqual(commands.slice(2).map(command => command.payload.expectedRevision), ['f1', 'f1x', 'f1xx'])
})

test('a lost habit acknowledgement survives closing the app and retries the same increment once', async () => {
  const storage = new Map()
  const state = snapshot()
  const sent = []
  const respond = (path, body) => {
    if (path === 'pair/start') return [200, { userCode: '1234ABC', deviceCode: 'claim', expiresIn: 300 }]
    if (path === 'pair/claim') return [200, { status: 'paired', token: 'test-device' }]
    if (path === 'state') return [200, state]
    sent.push(body)
    if (sent.length === 1) { state.habits[0].amount += body.payload.amount; return [0] }
    return [200, { ok: true, replayed: true }]
  }
  const first = startWatch(storage, respond)
  await first.refresh()
  await first.choose('habits')
  await first.choose('habit:drink')
  await Promise.all([first.choose('remaining'), first.choose('remaining')])
  assert.equal(sent.length, 1)
  assert.equal(first.pending, true)
  assert.equal(sent[0].payload.amount, 4)
  const reopened = startWatch(storage, respond)
  await reopened.refresh()
  assert.equal(reopened.cta, '重试同一操作')
  await reopened.retry()
  assert.deepEqual(sent[1], sent[0])
  assert.equal(reopened.pending, false)
  assert.match(reopened.rows[0].detail, /6 \/ 6/)
})

test('a revoked watch drops its old session and asks for a new pairing code', async () => {
  const storage = new Map()
  let revoked = false
  const page = startWatch(storage, path => {
    if (path === 'pair/start') return [200, { userCode: '1234', deviceCode: 'claim', expiresIn: 300 }]
    if (path === 'pair/claim') return [200, { status: 'paired', token: 'expired' }]
    return revoked ? [401, {}] : [200, snapshot()]
  })
  await page.refresh()
  revoked = true
  await page.refresh()
  assert.equal(page.ready, false)
  assert.equal(page.cta, '获取配对码')
  assert.equal(page.session.token, undefined)
})
