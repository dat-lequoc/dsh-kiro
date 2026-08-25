/**
 * Lifecycle contract for the settings-nav icon replacement.
 *
 * The settings shell chooses nav glyphs from a fixed table keyed by section id
 * and offers registrants no icon seat, so the plugin has to patch the DOM. What
 * it must not do is scan forever or outlive its own plugin: this suite pins the
 * scoped-observer, no-polling, and disposal behavior with a minimal DOM double.
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeNode {
  tagName: string
  textContent: string
  attributes: Record<string, string>
  children: FakeNode[]
  parent?: FakeNode
  innerHTML: string
  closest: (selector: string) => FakeNode | undefined
  querySelector: (selector: string) => FakeNode | undefined
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
}

interface ObserveCall {
  target: FakeNode
  options: { childList?: boolean; subtree?: boolean }
}

/** Build one element of the fake tree. */
function node(tagName: string, textContent = ''): FakeNode {
  const element: FakeNode = {
    tagName,
    textContent,
    attributes: {},
    children: [],
    innerHTML: '',
    closest(selector) {
      let current: FakeNode | undefined = element
      while (current !== undefined) {
        if (current.tagName === selector) return current
        current = current.parent
      }
      return undefined
    },
    querySelector(selector) {
      const stack = [...element.children]
      while (stack.length > 0) {
        const candidate = stack.shift()
        if (candidate === undefined) continue
        if (candidate.tagName === selector) return candidate
        stack.push(...candidate.children)
      }
      return undefined
    },
    getAttribute: name => element.attributes[name] ?? null,
    setAttribute: (name, value) => {
      element.attributes[name] = value
    },
  }
  return element
}

function append(parent: FakeNode, child: FakeNode): FakeNode {
  child.parent = parent
  parent.children.push(child)
  return child
}

/** Collect every node of a tree, so `document.querySelectorAll` can filter it. */
function flatten(root: FakeNode): FakeNode[] {
  const all: FakeNode[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.shift()
    if (current === undefined) continue
    all.push(current)
    stack.push(...current.children)
  }
  return all
}

/** Mount the settings panel structure the shell renders for this plugin. */
function mountPanel(root: FakeNode): { nav: FakeNode; svg: FakeNode } {
  const nav = append(root, node('nav'))
  const button = append(nav, node('button'))
  const svg = append(button, node('svg'))
  svg.setAttribute('viewBox', '0 0 16 16')
  append(svg, node('path')).setAttribute('d', 'M0 0h16v16H0z')
  append(button, node('span', 'Kiro'))
  return { nav, svg }
}

const intervals: unknown[] = []
const observers: {
  options: ObserveCall['options']
  targets: FakeNode[]
  disconnected: boolean
  /** Deliver one mutation, as the browser would after a DOM insertion. */
  fire: () => void
}[] = []
let root: FakeNode
let apply: (ctx: Record<string, unknown>) => void

beforeEach(async () => {
  intervals.length = 0
  observers.length = 0
  root = node('body')
  const documentRoot = root

  class FakeMutationObserver {
    private readonly entry: (typeof observers)[number]

    constructor(callback: () => void) {
      this.entry = { options: {}, targets: [], disconnected: false, fire: callback }
      observers.push(this.entry)
    }

    observe(target: FakeNode, options: ObserveCall['options']): void {
      this.entry.options = options
      this.entry.targets.push(target)
    }

    disconnect(): void {
      this.entry.disconnected = true
    }
  }

  const globals = globalThis as Record<string, unknown>
  globals.MutationObserver = FakeMutationObserver
  globals.document = {
    getElementById: () => undefined,
    body: documentRoot,
    documentElement: documentRoot,
    head: { appendChild: () => undefined },
    createElement: (tag: string) => node(tag),
    querySelectorAll: (selector: string) =>
      flatten(documentRoot).filter(candidate => candidate.tagName === selector),
  }
  globals.window = {
    setInterval: (...args: unknown[]) => {
      intervals.push(args)
      return 1
    },
    clearInterval: () => undefined,
    // Deliberately synchronous: the plugin coalesces work into one frame, and
    // the test wants that work to have happened by the time it asserts.
    requestAnimationFrame: (callback: () => void) => {
      callback()
      return 1
    },
    addEventListener: () => undefined,
    __ModuleLoader__: {
      load: (module: { factory: (require: (id: string) => unknown) => { apply: typeof apply } }) => {
        const instance = module.factory(() => ({
          createElement: () => undefined,
          useCallback: (fn: unknown) => fn,
          useEffect: () => undefined,
          useMemo: (fn: () => unknown) => fn(),
          useState: (initial: unknown) => [initial, () => undefined],
        }))
        apply = instance.apply
      },
    },
  }
  globals.navigator ??= { language: 'en' }
  vi.resetModules()
  await import('../client/index.cjs')
})

/** Register the plugin against a context that captures its disposer. */
function start(): () => void {
  let dispose = (): void => undefined
  apply({
    effect: (body: () => () => void) => {
      dispose = body()
    },
    locale: { register: () => undefined },
    slots: { inject: () => undefined, register: () => undefined },
  })
  return dispose
}

describe('settings nav icon lifecycle', () => {
  it('never installs a polling timer', () => {
    mountPanel(root)
    start()
    expect(intervals).toEqual([])
  })

  it('watches the app root until the nav exists, then narrows to that nav', () => {
    start()
    // No panel yet: the wide scope is the only way to notice it mount.
    expect(observers).toHaveLength(1)
    expect(observers[0]?.targets).toEqual([root])
    expect(observers[0]?.options).toEqual({ childList: true, subtree: true })

    const { nav } = mountPanel(root)
    observers[0]?.fire()
    // Icon installed, so observation narrows to the nav and the wide observer stops.
    expect(observers[0]?.disconnected).toBe(true)
    expect(observers[1]?.targets).toEqual([nav])
  })

  it('installs the official Kiro mark on the nav glyph', () => {
    const { svg } = mountPanel(root)
    start()
    expect(svg.getAttribute('viewBox')).toBe('0 0 1200 1200')
    expect(svg.innerHTML).toContain('fill="#9046FF"')
  })

  it('offers a managed sign-in for every credential source but its own', () => {
    // A Kiro IDE/CLI credential cannot be deleted by this plugin, so hiding the
    // sign-in button whenever something is authenticated leaves that state with
    // no action at all — the reported "I can't even log out".
    const source = readFileSync(new URL('../client/index.cjs', import.meta.url), 'utf8')
    expect(source).toContain("status?.credentialSource !== 'dsh' && React.createElement('button'")
    expect(source).toContain("status?.authenticated ? t('connectManaged') : t('connectKiro')")
    // Sign out stays scoped to plugin-owned credentials, and the card says why.
    expect(source).toContain("status?.credentialSource === 'dsh' && React.createElement('button'")
    expect(source).toContain("status?.credentialSource === 'kiro' && React.createElement('div'")
  })

  it('stops observing when the plugin is disposed', () => {
    mountPanel(root)
    const dispose = start()
    dispose()
    expect(observers.every(entry => entry.disconnected)).toBe(true)
  })
})
