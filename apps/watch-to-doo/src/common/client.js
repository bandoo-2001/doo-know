import fetch from '@system.fetch'
import storage from '@system.storage'
import origin from './origin'

const prefix = origin + '/api/to-doo/watch/v1/'
const storageKey = 'to_doo_session_v1'

export function request(path, token, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ status: 0 }), 18000)
    const header = { Accept: 'application/json' }
    if (token) header.Authorization = 'Bearer ' + token
    const options = {
      url: prefix + path,
      method: body ? 'POST' : 'GET',
      header,
      responseType: 'text',
      success(response) {
        clearTimeout(timer)
        if (response.code < 200 || response.code >= 300) {
          reject({ status: response.code })
          return
        }
        try {
          resolve(typeof response.data === 'string' ? JSON.parse(response.data) : response.data)
        } catch (error) {
          reject({ status: 0 })
        }
      },
      fail() {
        clearTimeout(timer)
        reject({ status: 0 })
      }
    }
    if (body) {
      header['Content-Type'] = 'application/json'
      options.data = JSON.stringify(body)
    }
    fetch.fetch(options)
  })
}

export function loadSession() {
  return new Promise((resolve, reject) => storage.get({
    key: storageKey,
    success(value) {
      try {
        const saved = value && JSON.parse(value)
        resolve(saved && saved.origin === origin ? saved.session : {})
      } catch (error) {
        reject({ storage: true })
      }
    },
    fail() { reject({ storage: true }) }
  }))
}

export function saveSession(session) {
  return new Promise((resolve, reject) => storage.set({
    key: storageKey,
    value: JSON.stringify({ origin, session }),
    success: resolve,
    fail() { reject({ storage: true }) }
  }))
}
