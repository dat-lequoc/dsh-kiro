import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A render harness for the shipped settings page.
 *
 * `client/index.cjs` is registered into the host's module loader and builds its
 * tree with `React.createElement`. The contract tests read its source; this one
 * runs it, so a page that throws, drops the account list, or wires a button to
 * the wrong endpoint fails here rather than in the browser.
 */

interface Element {
  type: unknown
  props: Record<string, any>
}

/** React subset the page uses: elements, hooks, and Fragment. */
function createReact(): Record<string, any> {
  const state: { slots: any[]; index: number; effects: (() => void)[] } = { slots: [], index: 0, effects: [] }
  const same = (a: unknown, b: unknown): boolean =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])

  const React: Record<string, any> = {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
      const flattened = children.length === 1 ? children[0] : children
      return { type, props: { ...props, ...children.length === 0 ? {} : { children: flattened } } }
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const index = state.index++
      if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [state.slots[index], (next: unknown) => { state.slots[index] = next }]
    },
    useMemo(factory: () => unknown, deps: unknown[]): unknown {
      const index = state.index++
      const previous = state.slots[index] as { value: unknown; deps: unknown[] } | undefined
      if (previous === undefined || !same(previous.deps, deps)) state.slots[index] = { value: factory(), deps }
      return (state.slots[index] as { value: unknown }).value
    },
    useCallback(callback: unknown, deps: unknown[]): unknown {
      return React['useMemo'](() => callback, deps)
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown {
      return getSnapshot()
    },
    useEffect(effect: () => void, deps: unknown[]): void {
      const index = state.index++
      const previous = state.slots[index] as { deps: unknown[] } | undefined
      if (previous === undefined || !same(previous.deps, deps)) {
        state.slots[index] = { deps }
        state.effects.push(effect)
      }
    },
  }
  return {
    React,
    /** Render one pass of a component, running the effects it newly scheduled. */
    render(component: (props: any) => unknown, props: unknown): Element {
      state.index = 0
      state.effects = []
      const tree = component(props) as Element
      const scheduled = state.effects
      state.effects = []
      for (const effect of scheduled) effect()
      return tree
    },
  }
}

/** Depth-first list of every element in a tree. */
function findAll(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found
  const element = node as Element
  if (!('type' in element) || !('props' in element)) return found
  found.push(element)
  findAll(element.props['children'], found)
  return found
}

/** Concatenated text of one element subtree. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || node === null) return ''
  return textOf((node as Element).props?.['children'])
}

/** Whether one element carries a class token. */
function hasClass(element: Element, name: string): boolean {
  return String(element.props?.['className'] ?? '').split(/\s+/u).includes(name)
}

/** The first button whose whole label is one string. */
function findButton(tree: Element, label: string): Element | undefined {
  return findAll(tree).find(element => element.type === 'button' && textOf(element) === label)
}

/** One status payload shaped exactly like the running server's. */
function statusPayload(
  accounts: unknown[],
  activeAccountId: string | null,
  contextWindowCap?: number,
): Record<string, unknown> {
  return {
    authenticated: accounts.length > 0,
    credentialSource: accounts.length > 0 ? 'dsh' : 'none',
    authMethod: 'builder-id',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST',
    accounts: { revision: 3, activeAccountId, accounts, migrated: false },
    activeAccountId,
    login: { status: 'idle' },
    models: { source: 'live', models: [], enabledModelIds: [] },
    usage: undefined,
    ...contextWindowCap === undefined ? {} : { contextWindowCap },
  }
}

let restore: (() => void)[] = []

beforeEach(() => {
  restore = []
})

afterEach(() => {
  for (const undo of restore.reverse()) undo()
  vi.restoreAllMocks()
})

describe('the shipped settings page and composer chip', () => {
  /** Load the shipped page and render it against one status payload. */
  async function renderPage(
    payload: Record<string, unknown>,
    usage?: Record<string, unknown>,
    only: 'settings' | 'quota' | 'credits' = 'settings',
    selected: { provider: string; model: string } = { provider: 'kiro', model: 'claude-opus-5' },
    credits?: Record<string, unknown>,
    creditProps: Record<string, unknown> = {},
  ): Promise<{
    tree: Element | null
    rerender: () => Element | null
    calls: { path: string; method: string | undefined; body: unknown }[]
  }> {
    const calls: { path: string; method: string | undefined; body: unknown }[] = []
    const source = readFileSync(new URL('../client/index.cjs', import.meta.url), 'utf8')

    const original = {
      window: (globalThis as any).window,
      document: (globalThis as any).document,
      fetch: (globalThis as any).fetch,
    }
    restore.push(() => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete (globalThis as any)[key]
        else (globalThis as any)[key] = value
      }
    })

    let registration: any
    const win: any = {
      __ModuleLoader__: { load: (definition: unknown) => { registration = definition } },
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: (callback: () => void) => { callback(); return 0 },
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      requestAnimationFrame: (callback: () => void) => { callback(); return 0 },
      confirm: () => true,
      location: { href: 'http://localhost/' },
      localStorage: (() => {
        const items = new Map<string, string>()
        return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } }
      })(),
    }
    ;(globalThis as any).window = win
    ;(globalThis as any).document = {
      getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: () => undefined }),
      head: { appendChild: () => undefined },
      body: { appendChild: () => undefined },
      documentElement: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    ;(globalThis as any).fetch = async (url: string, options?: { method?: string; body?: string }) => {
      const path = String(url).replace('/kiro/api', '')
      calls.push({
        path,
        method: options?.method,
        body: options?.body === undefined ? undefined : JSON.parse(options.body),
      })
      const value = path.startsWith('/usage') ? usage : path.startsWith('/turn-credits') ? credits : payload
      if (value === undefined) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: 'no ' + path }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    }

    // eslint-disable-next-line no-eval
    ;(0, eval)(source)
    expect(registration?.id).toBe('dsh-kiro')

    const hooks = createReact()
    const module = registration.factory((name: string) => {
      if (name === 'react') return hooks.React
      throw new Error('unexpected module ' + name)
    })

    let renderSettings: ((props: unknown) => unknown) | undefined
    let renderQuota: ((props: unknown) => unknown) | undefined
    let renderCredits: ((props: unknown) => unknown) | undefined
    const directory = {
      getSnapshot: () => ({ status: 'ready', current: selected, routable: true }),
      subscribe: () => () => undefined,
    }
    const scope: any = {
      effect: () => undefined,
      slots: {
        inject: (_name: string, use: () => void) => use(),
        register: (options: { name?: string }, render: (props: unknown) => unknown) => {
          if (options.name === 'conversation.input.right') renderQuota = render
          else if (options.name === 'conversation.chat.assistant-actions') renderCredits = render
          else renderSettings = render
        },
      },
      modelDirectories: { directoryFor: () => ({ store: directory }) },
    }
    module.apply({
      ...scope,
      inject: (_names: string[], use: (injected: unknown) => void) => use(scope),
      locale: {
        register: () => undefined,
        bind: () => (key: string) => key,
        getLocale: () => ({ active: 'en' }),
      },
    })
    expect(renderSettings).toBeDefined()
    expect(renderQuota).toBeDefined()
    expect(renderCredits).toBeDefined()

    // One component per load: the hooks store belongs to the component that
    // first consumes it, so the settings page and the chip are never mixed.
    const mounted = (only === 'quota'
      ? renderQuota!({ directory })
      : only === 'credits'
        ? renderCredits!(creditProps)
        : renderSettings!({})) as Element
    const component = mounted.type as (props: unknown) => unknown
    const rerender = (): Element | null => hooks.render(component, mounted.props) as Element | null
    let tree = rerender()
    // The status read is a promise, and an effect that reacts to it runs after
    // the pass that saw it: two turns settle the page the user ends up looking at.
    await new Promise(resolve => setTimeout(resolve, 0))
    tree = rerender()
    await new Promise(resolve => setTimeout(resolve, 0))
    tree = rerender()
    return { tree, rerender, calls }
  }

  it('lists every account, marks the active one, and offers the others', async () => {
    const { tree } = await renderPage(statusPayload([
      {
        id: 'one', label: 'Work', authMethod: 'builder-id', region: 'us-east-1',
        active: true, createdAt: 1, updatedAt: 1, credentialRevision: 0, state: 'ready',
      },
      {
        id: 'two', label: 'Personal', authMethod: 'google', region: 'eu-central-1',
        active: false, createdAt: 2, updatedAt: 2, credentialRevision: 1, state: 'refresh-required',
      },
    ], 'one'))

    const rows = findAll(tree).filter(element => hasClass(element, 'dshk-account'))
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0])).toContain('Work')
    expect(textOf(rows[0])).toContain('Active')
    expect(textOf(rows[1])).toContain('Personal')
    expect(textOf(rows[1])).toContain('Refreshes on next use')
    // Only the inactive account offers to be switched to.
    const switchedTo = rows.map(row => findAll(row).some(element => element.type === 'button' && textOf(element) === 'Use'))
    expect(switchedTo).toEqual([false, true])
    expect(textOf(tree)).toContain('Sign out all')
  })

  it('switches accounts through the account API when Use is pressed', async () => {
    const { tree, calls } = await renderPage(statusPayload([
      {
        id: 'one', label: 'Work', authMethod: 'builder-id', region: 'us-east-1',
        active: true, createdAt: 1, updatedAt: 1, credentialRevision: 0, state: 'ready',
      },
      {
        id: 'two', label: 'Personal', authMethod: 'google', region: 'eu-central-1',
        active: false, createdAt: 2, updatedAt: 2, credentialRevision: 1, state: 'ready',
      },
    ], 'one'))

    const use = findButton(tree, 'Use')
    expect(use).toBeDefined()
    await (use!.props['onClick'] as () => Promise<void>)()

    expect(calls).toContainEqual({ path: '/accounts/activate', method: 'POST', body: { accountId: 'two' } })
  })

  it('removes the active account by naming a replacement', async () => {
    const { tree, calls } = await renderPage(statusPayload([
      {
        id: 'one', label: 'Work', authMethod: 'builder-id', region: 'us-east-1',
        active: true, createdAt: 1, updatedAt: 1, credentialRevision: 0, state: 'ready',
      },
      {
        id: 'two', label: 'Personal', authMethod: 'google', region: 'eu-central-1',
        active: false, createdAt: 2, updatedAt: 2, credentialRevision: 1, state: 'ready',
      },
    ], 'one'))

    const remove = findButton(tree, 'Remove')
    expect(remove).toBeDefined()
    await (remove!.props['onClick'] as () => Promise<void>)()

    expect(calls).toContainEqual({
      path: '/accounts/remove',
      method: 'POST',
      body: { accountId: 'one', replacementId: 'two' },
    })
  })

  it('renders a signed-out page with no account rows and an add action', async () => {
    const { tree, rerender, calls } = await renderPage(statusPayload([], null))
    expect(findAll(tree).filter(element => hasClass(element, 'dshk-account'))).toHaveLength(0)
    expect(textOf(tree)).toContain('Not signed in')

    // With no account stored the action is the sign-in entry point, and it opens
    // the connect dialog on a page that holds no account.
    const add = findButton(tree, 'Sign in')
    expect(add).toBeDefined()
    await (add!.props['onClick'] as () => void)()
    const opened = rerender()
    expect(textOf(opened)).toContain('Connect Kiro')
    expect(textOf(opened)).toContain('AWS Builder ID')
    expect(textOf(opened)).toContain('IAM Identity Center')
    expect(findAll(opened).some(element => element.type === 'button' && textOf(element).length > 0)).toBe(true)
    expect(calls.every(call => call.method === undefined || call.method === 'GET' || call.method === 'POST')).toBe(true)
  })
  /** One usage payload shaped like the Host's. */
  function usagePayload(remainingPercent: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      plan: 'KIRO PRO+',
      fetchedAt: Date.parse('2026-10-11T02:00:00Z'),
      resetAt: '2026-11-01T00:00:00.000Z',
      rows: [{
        id: 'credit', label: 'Credits', used: 1938.7, limit: 2000, remaining: 61.3,
        usedPercent: 100 - remainingPercent, remainingPercent,
        resetAt: '2026-11-01T00:00:00.000Z', kind: 'subscription', ...extra,
      }],
    }
  }

  it('shows the tightest quota beside the composer', async () => {
    const { tree, calls } = await renderPage(statusPayload([], null), usagePayload(3.1), 'quota')
    const chip = tree as Element
    expect(chip.type).toBe('button')
    expect(hasClass(chip, 'dshk-quota')).toBe(true)
    expect(textOf(chip)).toBe('3.1% left')
    // Nothing before 5% left is a detail: it changes what the next turn costs.
    expect(hasClass(chip, 'dshk-quota-critical')).toBe(true)
    expect(String(chip.props['title'])).toContain('KIRO PRO+')
    expect(String(chip.props['title'])).toContain('Credits')
    expect(String(chip.props['title'])).toContain('Resets')
    expect(calls.some(call => call.path === '/usage')).toBe(true)
  })

  it('marks a low quota without calling it critical', async () => {
    const { tree } = await renderPage(statusPayload([], null), usagePayload(12), 'quota')
    const chip = tree as Element
    expect(textOf(chip)).toBe('12% left')
    expect(hasClass(chip, 'dshk-quota-low')).toBe(true)
    expect(hasClass(chip, 'dshk-quota-critical')).toBe(false)
  })

  it('leaves a healthy quota unmarked', async () => {
    const { tree } = await renderPage(statusPayload([], null), usagePayload(62), 'quota')
    const chip = tree as Element
    expect(textOf(chip)).toBe('62% left')
    expect(hasClass(chip, 'dshk-quota-low')).toBe(false)
    expect(hasClass(chip, 'dshk-quota-critical')).toBe(false)
  })

  it('reports an unlimited row without inventing a percentage', async () => {
    const { tree } = await renderPage(
      statusPayload([], null),
      usagePayload(0, { unlimited: true }),
      'quota',
    )
    expect(textOf(tree as Element)).toBe('no limit')
  })

  it('renders nothing when the quota cannot be read', async () => {
    // A figure that only decorates the composer must not become an error box.
    const { tree } = await renderPage(statusPayload([], null), undefined, 'quota')
    expect(tree).toBeNull()
  })

  it('stays hidden while the session is routed to another provider', async () => {
    const { tree, calls } = await renderPage(
      statusPayload([], null),
      usagePayload(3.1),
      'quota',
      { provider: 'deepseek-official', model: 'deepseek-flash' },
    )
    expect(tree).toBeNull()
    // Not merely hidden: a session that cannot spend the quota must not poll it.
    expect(calls).toEqual([])
  })

  it('appears only when Kiro is the selected model', async () => {
    const { tree, calls } = await renderPage(
      statusPayload([], null),
      usagePayload(3.1),
      'quota',
      { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    )
    expect(tree).toBeNull()
    expect(calls).toEqual([])

    const kiro = await renderPage(statusPayload([], null), usagePayload(3.1), 'quota',
      { provider: 'kiro', model: 'claude-opus-5' })
    expect(textOf(kiro.tree as Element)).toBe('3.1% left')
    expect(kiro.calls.some(call => call.path === '/usage')).toBe(true)
  })
  it('shows the context ceiling and writes a change back to the Host', async () => {
    const { tree, rerender, calls } = await renderPage(statusPayload([], null, 600000))
    const input = findAll(tree!).find(element => element.type === 'input' && element.props['aria-label'] === 'Max context')
    expect(input).toBeDefined()
    expect(String(input!.props['value'])).toBe('600000')

    const apply = findButton(tree!, 'Apply')
    expect(apply).toBeDefined()
    ;(apply!.props['onClick'] as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toContainEqual({ path: '/context', method: 'POST', body: { maxContextWindow: 600000 } })

    // Clearing the field hands the decision back to each model.
    ;(input!.props['onChange'] as (event: unknown) => void)({ target: { value: '' } })
    const cleared = findButton(rerender()!, 'Apply')
    expect(cleared).toBeDefined()
    ;(cleared!.props['onClick'] as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toContainEqual({ path: '/context', method: 'POST', body: { maxContextWindow: null } })
  })

  it('refuses a ceiling that is not a whole number without calling the Host', async () => {
    const { tree, rerender, calls } = await renderPage(statusPayload([], null, 600000))
    const input = findAll(tree!).find(element => element.type === 'input' && element.props['aria-label'] === 'Max context')
    ;(input!.props['onChange'] as (event: unknown) => void)({ target: { value: '12.5' } })
    const apply = findButton(rerender()!, 'Apply')
    expect(apply).toBeDefined()
    ;(apply!.props['onClick'] as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.some(call => call.path === '/context')).toBe(false)
  })

  /** A Chat snapshot holding one closed Turn whose closing reply is `message-1`. */
  function chatWithTurn(): unknown {
    const tail = { kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'message-1' } } } }
    const snapshot = {
      timeline: { turnOrder: [1], turns: new Map([[1, { start: { time: 1_000 }, end: { time: 2_000 } }]]) },
      locations: { getTurn: () => ['tail'] },
      nodes: { get: (key: string) => (key === 'tail' ? tail : undefined) },
    }
    return (select: (value: unknown) => unknown) => select(snapshot)
  }

  it('shows what one Turn cost in its reply action row', async () => {
    const { tree, calls } = await renderPage(statusPayload([], null), undefined, 'credits', undefined,
      { credits: 1.234, calls: 3 },
      { sessionId: 'session-1', messageId: 'message-1', useChat: chatWithTurn() })
    expect(calls).toContainEqual({ path: '/turn-credits?sessionId=session-1&from=1000&to=2500', method: undefined, body: undefined })
    expect(tree).not.toBeNull()
    expect(hasClass(tree!, 'dshk-turn-credits')).toBe(true)
    expect(textOf(tree)).toBe('1.23 credits')
  })

  it('renders nothing for a Turn without Kiro charges', async () => {
    const { tree } = await renderPage(statusPayload([], null), undefined, 'credits', undefined,
      { credits: 0, calls: 0 },
      { sessionId: 'session-1', messageId: 'message-1', useChat: chatWithTurn() })
    expect(tree).toBeNull()
  })

  it('offers a settings toggle that turns the label off', async () => {
    const page = await renderPage(statusPayload([], null))
    // The fake renderer is shallow, so the toggle is still a component element.
    const element = findAll(page.tree!).find(candidate => typeof candidate.type === 'function'
      && (candidate.type as { name?: string }).name === 'TurnCreditsToggle')
    expect(element).toBeDefined()
    const toggle = (element!.type as (props: unknown) => Element)(element!.props)
    const input = findAll(toggle).find(candidate => candidate.type === 'input')
    expect(input?.props['checked']).toBe(true)
    ;(input!.props['onChange'] as (event: unknown) => void)({ target: { checked: false } })
    expect((globalThis as any).window.localStorage.getItem('dsh-kiro.showTurnCredits')).toBe('false')
    expect(findAll((element!.type as (props: unknown) => Element)(element!.props))
      .find(candidate => candidate.type === 'input')?.props['checked']).toBe(false)
  })
})
