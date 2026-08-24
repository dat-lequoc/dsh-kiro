window.__ModuleLoader__.load({
  id: 'dsh-kiro',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const API = '/kiro/api'
    const NS = 'dsh-kiro'
    const STYLE_ID = 'dsh-kiro-settings-style'

    const en = {
      title: 'Kiro',
      description: 'Sign in with AWS Builder ID and discover the Kiro models available to this account.',
      account: 'Account',
      signedOut: 'Not signed in',
      managed: 'Managed by dsh-kiro',
      external: 'Using Kiro IDE / CLI sign-in',
      login: 'Sign in',
      signingIn: 'Starting sign-in…',
      logout: 'Sign out',
      models: 'Available models',
      refresh: 'Discover models',
      refreshing: 'Discovering…',
      configured: 'Configured fallback catalog',
      live: 'Live account catalog',
      noModels: 'No models are available yet.',
      code: 'Builder ID code',
      pending: 'Complete authorization in the browser. This page will update automatically.',
      reasoning: 'Reasoning',
      context: 'Context',
      output: 'Max output',
    }
    const zh = {
      title: 'Kiro',
      description: '使用 AWS Builder ID 登录，并发现此账号可用的 Kiro 模型。',
      account: '账号',
      signedOut: '未登录',
      managed: '由 dsh-kiro 管理',
      external: '正在使用 Kiro IDE / CLI 登录',
      login: '登录',
      signingIn: '正在启动登录…',
      logout: '退出',
      models: '可用模型',
      refresh: '发现模型',
      refreshing: '发现中…',
      configured: '配置的后备模型目录',
      live: '账号实时模型目录',
      noModels: '尚无可用模型。',
      code: 'Builder ID 验证码',
      pending: '请在浏览器中完成授权，本页面会自动更新。',
      reasoning: '推理',
      context: '上下文',
      output: '最大输出',
    }

    function translator(ctx) {
      const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined
      return (key) => {
        if (bound) {
          const value = bound(key)
          if (value && value !== key && value !== `${NS}.${key}`) return value
        }
        const active = ctx.locale && typeof ctx.locale.getLocale === 'function'
          ? ctx.locale.getLocale()?.active
          : navigator.language
        const dictionary = active && active.startsWith('zh') ? zh : en
        return dictionary[key] || en[key] || key
      }
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body.value
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dshk-wrap{box-sizing:border-box;width:100%;max-width:820px;padding:0 0 28px;color:#111827}
.dshk-title{display:flex;align-items:center;gap:10px;margin:0;font-size:21px;font-weight:750}
.dshk-logo{display:grid;width:28px;height:28px;place-items:center;border-radius:8px;background:linear-gradient(145deg,#8b5cf6,#4f46e5);color:white;font-size:16px;font-weight:800}
.dshk-desc{margin:8px 0 18px;color:#6b7280;font-size:13px;line-height:20px}
.dshk-card{margin:0 0 14px;padding:16px;border:1px solid #e5e7eb;border-radius:13px;background:#fff}
.dshk-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.dshk-heading{font-size:15px;font-weight:700}
.dshk-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshk-btn{padding:7px 12px;border:1px solid #d1d5db;border-radius:9px;background:white;color:#111827;font-size:13px;cursor:pointer}
.dshk-btn:hover{background:#f9fafb}.dshk-btn:disabled{cursor:not-allowed;opacity:.55}
.dshk-primary{border-color:#4f46e5;background:#4f46e5;color:white}.dshk-primary:hover{background:#4338ca}
.dshk-status{display:flex;align-items:center;gap:9px;padding:11px 12px;border-radius:10px;background:#f9fafb;color:#4b5563;font-size:13px}
.dshk-dot{width:9px;height:9px;border-radius:50%;background:#9ca3af}.dshk-dot-on{background:#10b981}
.dshk-code{margin-top:10px;padding:11px 12px;border:1px solid #c7d2fe;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:13px}
.dshk-code strong{display:inline-block;margin-left:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.08em}
.dshk-meta{margin-top:8px;color:#6b7280;font-size:12px}
.dshk-list{display:grid;gap:8px}.dshk-model{padding:11px 12px;border:1px solid #eef0f3;border-radius:10px;background:#fcfcfd}
.dshk-model-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.dshk-model-name{font-size:14px;font-weight:650}.dshk-model-id{color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dshk-model-desc{margin-top:4px;color:#6b7280;font-size:12px;line-height:18px}.dshk-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dshk-pill{padding:3px 7px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px}.dshk-pill-reason{background:#ede9fe;color:#6d28d9}
.dshk-error{margin-top:10px;padding:9px 11px;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:12px;white-space:pre-wrap}
.dshk-empty{padding:18px;text-align:center;color:#9ca3af;font-size:13px}
@media(prefers-color-scheme:dark){.dshk-wrap{color:#f3f4f6}.dshk-card{border-color:#303642;background:#171a21}.dshk-status,.dshk-model{background:#1d2129;border-color:#303642;color:#d1d5db}.dshk-btn{border-color:#434b59;background:#20242d;color:#f3f4f6}.dshk-code{border-color:#4338ca;background:#272447;color:#c7d2fe}.dshk-pill{background:#2a303a;color:#cbd5e1}.dshk-pill-reason{background:#332a52;color:#c4b5fd}}
`
      document.head.appendChild(style)
    }

    function formatTokens(value) {
      if (!Number.isFinite(value)) return undefined
      if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`
      if (value >= 1000) return `${Math.round(value / 1000)}K`
      return String(value)
    }

    function KiroSettings({ ctx }) {
      const t = useMemo(() => translator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        const next = await api('/status')
        setStatus(next)
        return next
      }, [])

      useEffect(() => {
        let active = true
        void load().catch((cause) => active && setError(cause.message))
        const timer = window.setInterval(() => {
          if (active && status?.login?.status === 'pending') {
            void load().catch((cause) => setError(cause.message))
          }
        }, 2000)
        return () => { active = false; window.clearInterval(timer) }
      }, [load, status?.login?.status])

      const login = useCallback(async () => {
        setBusy('login'); setError('')
        const popup = window.open('about:blank', '_blank')
        if (popup) popup.opener = null
        try {
          const flow = await api('/login', { method: 'POST' })
          if (flow.authUrl && popup) popup.location.replace(flow.authUrl)
          else if (flow.authUrl) window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
          await load()
        } catch (cause) { popup?.close(); setError(cause.message) } finally { setBusy('') }
      }, [load])

      const logout = useCallback(async () => {
        setBusy('logout'); setError('')
        try { setStatus(await api('/logout', { method: 'POST' })) }
        catch (cause) { setError(cause.message) } finally { setBusy('') }
      }, [])

      const refresh = useCallback(async () => {
        setBusy('models'); setError('')
        try {
          const models = await api('/models/refresh', { method: 'POST' })
          setStatus((current) => ({ ...current, models }))
        } catch (cause) { setError(cause.message) } finally { setBusy('') }
      }, [])

      const flow = status?.login
      const catalog = status?.models
      const models = Array.isArray(catalog?.models) ? catalog.models : []
      const accountLabel = status?.credentialSource === 'dsh'
        ? t('managed')
        : status?.credentialSource === 'kiro' ? t('external') : t('signedOut')

      return React.createElement('div', { className: 'dshk-wrap' },
        React.createElement('h2', { className: 'dshk-title' },
          React.createElement('span', { className: 'dshk-logo', 'aria-hidden': 'true' }, 'K'),
          t('title')),
        React.createElement('p', { className: 'dshk-desc' }, t('description')),
        React.createElement('section', { className: 'dshk-card' },
          React.createElement('div', { className: 'dshk-head' },
            React.createElement('div', { className: 'dshk-heading' }, t('account')),
            React.createElement('div', { className: 'dshk-actions' },
              !status?.authenticated && React.createElement('button', { className: 'dshk-btn dshk-primary', disabled: !!busy, onClick: login }, busy === 'login' ? t('signingIn') : t('login')),
              status?.credentialSource === 'dsh' && React.createElement('button', { className: 'dshk-btn', disabled: !!busy, onClick: logout }, t('logout')))),
          React.createElement('div', { className: 'dshk-status' },
            React.createElement('span', { className: `dshk-dot${status?.authenticated ? ' dshk-dot-on' : ''}` }),
            React.createElement('span', null, accountLabel),
            status?.region && React.createElement('span', null, `· ${status.region}`)),
          flow?.status === 'pending' && React.createElement('div', { className: 'dshk-code' },
            t('code'), React.createElement('strong', null, flow.userCode),
            React.createElement('div', { className: 'dshk-meta' }, t('pending'))),
          error && React.createElement('div', { className: 'dshk-error' }, error)),
        React.createElement('section', { className: 'dshk-card' },
          React.createElement('div', { className: 'dshk-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'dshk-heading' }, t('models')),
              React.createElement('div', { className: 'dshk-meta' }, catalog?.source === 'live' ? t('live') : t('configured'))),
            React.createElement('button', { className: 'dshk-btn dshk-primary', disabled: !!busy || !status?.authenticated, onClick: refresh }, busy === 'models' ? t('refreshing') : t('refresh'))),
          models.length === 0
            ? React.createElement('div', { className: 'dshk-empty' }, t('noModels'))
            : React.createElement('div', { className: 'dshk-list' }, models.map((model) => {
                const context = formatTokens(model.contextWindow)
                const output = formatTokens(model.maxTokens)
                return React.createElement('div', { className: 'dshk-model', key: model.id },
                  React.createElement('div', { className: 'dshk-model-head' },
                    React.createElement('span', { className: 'dshk-model-name' }, model.name),
                    React.createElement('span', { className: 'dshk-model-id' }, model.id)),
                  model.description && React.createElement('div', { className: 'dshk-model-desc' }, model.description),
                  React.createElement('div', { className: 'dshk-pills' },
                    context && React.createElement('span', { className: 'dshk-pill' }, `${t('context')} ${context}`),
                    output && React.createElement('span', { className: 'dshk-pill' }, `${t('output')} ${output}`),
                    React.createElement('span', { className: `dshk-pill${model.thinking ? ' dshk-pill-reason' : ''}` },
                      `${t('reasoning')}: ${(model.reasoningEfforts || ['off']).join(' · ')}`)))
              }))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyle()
        if (ctx.locale && typeof ctx.locale.register === 'function') ctx.locale.register(NS, { en, zh })
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'kiro',
          order: 12,
          label: () => 'Kiro',
        }, () => React.createElement(KiroSettings, { ctx })))
      },
    }
  },
})
