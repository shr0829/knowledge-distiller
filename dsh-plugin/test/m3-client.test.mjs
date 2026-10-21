// test/m3-client.test.mjs — 浏览器半的自检（不真渲染，只验协议形状与纯函数）。
//
// 浏览器半是宿主模块加载器的 CJS 工厂：window.__ModuleLoader__.load({id, factory})。
// 这里用假的 window / require('react') 把工厂跑一遍，确认：
//   · id 是包名、导出 name/inject/apply；
//   · apply 惰性注册两个槽（sidebar.panellist + main），key 与侧栏 id 一致；
//   · 纯函数（键盘映射、夹取、字节格式化、越界夹回）行为正确。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

function loadClient() {
  let loaded = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => { loaded = definition },
    },
  }
  // client.js 是脚本而不是模块：用 Function 求值，模拟宿主加载器的求值方式
  // eslint-disable-next-line no-new-func
  new Function('window', source)(globalThis.window)
  assert.ok(loaded, '__ModuleLoader__.load 必须被调用')
  const exported = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`客户端不该 require ${name}`)
  })
  return { loaded, exported, React }
}

test('客户端半：id 是包名，导出 name/inject/apply', () => {
  const { loaded, exported } = loadClient()
  assert.equal(loaded.id, 'dsh-llm-wiki')
  assert.equal(exported.name, 'llm-wiki')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('客户端半：UI 入口只有 slot，且主视图 key 与侧栏 id 相同', () => {
  const { exported } = loadClient()
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(key, factory) { injected.push(key); factory() },
      register(options, component) {
        assert.equal(typeof component, 'function', '注册项必须是组件函数')
        registered.push(options)
        return () => {}
      },
    },
  }
  exported.apply(ctx)
  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  const sidebar = registered.find((item) => item.name === 'sidebar.panellist')
  const main = registered.find((item) => item.name === 'main')
  assert.ok(sidebar && main)
  assert.equal(sidebar.id, 'llm-wiki')
  assert.equal(main.key, sidebar.id, 'main 的 key 必须等于 sidebar.panellist 的 id')
})

test('客户端半：键盘映射符合 spec §12.3', () => {
  const { exported } = loadClient()
  const { keyToAction } = exported.__internals
  assert.equal(keyToAction({ key: 'j' }), 'next')
  assert.equal(keyToAction({ key: 'K' }), 'prev')
  assert.equal(keyToAction({ key: 'a' }), 'accept')
  assert.equal(keyToAction({ key: 'D' }), 'discard')
  assert.equal(keyToAction({ key: 's' }), 'defer')
  assert.equal(keyToAction({ key: 'e' }), 'edit')
  assert.equal(keyToAction({ key: 'w' }), 'write')
  assert.equal(keyToAction({ key: 'Enter' }), 'expand')
  assert.equal(keyToAction({ key: 'Escape' }), 'back')
  assert.equal(keyToAction({ key: 'a', ctrlKey: true }), null, '带修饰键不抢')
  assert.equal(keyToAction({ key: 'x' }), null)
})

test('客户端半：文本截断/字节格式化/索引夹取', () => {
  const { exported } = loadClient()
  const { clampText, formatBytes, nextIndex } = exported.__internals
  assert.equal(clampText('abc', 5).clipped, false)
  const clipped = clampText('abcdefgh', 4)
  assert.equal(clipped.clipped, true)
  assert.ok(clipped.text.endsWith('…'))
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB')
  assert.equal(nextIndex(0, 3, 'next'), 0, 'next 由调用方先自增，这里只夹取')
  assert.equal(nextIndex(2, 3, 'next'), 2)
  assert.equal(nextIndex(0, 3, 'prev'), 0)
  assert.equal(nextIndex(5, 3, 'next'), 2)
})

test('客户端半：样式只用 --dsw-* token，且无 iframe / shadow DOM', () => {
  assert.ok(!/<iframe/i.test(source), '不允许 iframe 元素')
  assert.ok(!/createElement\(\s*['"]iframe['"]/.test(source), '不允许渲染 iframe')
  assert.ok(!/attachShadow/.test(source), '不允许 shadow DOM')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), '不允许硬编码色值（一律走 --dsw-* token）')
  assert.ok(!/rgba?\(/.test(source), '不允许硬编码 rgba 色值')
  const colors = source.match(/(?:color|background|border-color)\s*:\s*[^;]+/g) || []
  for (const decl of colors) {
    const inline = decl.replace(/^[^:]+:\s*/, '')
    if (/^(transparent|inherit|none)$/.test(inline)) continue
    assert.match(inline, /var\(--dsw-[\w-]+/, `颜色必须走宿主 token：${decl}`)
  }
})
