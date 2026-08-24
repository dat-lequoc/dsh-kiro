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
      description: 'Connect a Kiro account, keep its token refreshed, and discover the models available to it.',
      account: 'Account',
      signedOut: 'Not signed in',
      managed: 'Managed by dsh-kiro',
      external: 'Using Kiro IDE / CLI sign-in',
      method: 'Login method',
      builderId: 'AWS Builder ID',
      idc: 'IAM Identity Center',
      google: 'Google',
      github: 'GitHub',
      refreshToken: 'Refresh token',
      apiKey: 'Kiro API key',
      externalIdp: 'Microsoft external IdP JSON',
      startUrl: 'Identity Center start URL',
      region: 'AWS region (optional)',
      profileArn: 'Profile ARN (optional)',
      clientId: 'OIDC client ID (optional)',
      clientSecret: 'OIDC client secret (optional)',
      credentialJson: 'CLIProxyAPI-compatible credential JSON',
      callbackUrl: 'Paste the kiro:// callback URL',
      login: 'Continue',
      import: 'Import credentials',
      complete: 'Complete login',
      signingIn: 'Working…',
      logout: 'Sign out',
      models: 'Available models',
      refresh: 'Discover models',
      refreshing: 'Discovering…',
      configured: 'Configured fallback catalog',
      live: 'Live account catalog',
      noModels: 'No models are available yet.',
      code: 'Device code',
      pending: 'Complete authorization in the browser. This page will update automatically.',
      socialPending: 'After the browser redirects to kiro://, copy the full URL and paste it below.',
      authMethod: 'Method',
      profile: 'Profile',
      reasoning: 'Reasoning',
      context: 'Context',
      output: 'Max output',
    }
    const zh = {
      title: 'Kiro',
      description: '连接 Kiro 账号、自动刷新令牌，并发现此账号可用的模型。',
      account: '账号',
      signedOut: '未登录',
      managed: '由 dsh-kiro 管理',
      external: '正在使用 Kiro IDE / CLI 登录',
      method: '登录方式',
      builderId: 'AWS Builder ID',
      idc: 'IAM Identity Center',
      google: 'Google',
      github: 'GitHub',
      refreshToken: '刷新令牌',
      apiKey: 'Kiro API 密钥',
      externalIdp: 'Microsoft 外部 IdP JSON',
      startUrl: 'Identity Center 起始 URL',
      region: 'AWS 区域（可选）',
      profileArn: 'Profile ARN（可选）',
      clientId: 'OIDC 客户端 ID（可选）',
      clientSecret: 'OIDC 客户端密钥（可选）',
      credentialJson: '兼容 CLIProxyAPI 的凭据 JSON',
      callbackUrl: '粘贴完整的 kiro:// 回调 URL',
      login: '继续',
      import: '导入凭据',
      complete: '完成登录',
      signingIn: '处理中…',
      logout: '退出',
      models: '可用模型',
      refresh: '发现模型',
      refreshing: '发现中…',
      configured: '配置的后备模型目录',
      live: '账号实时模型目录',
      noModels: '尚无可用模型。',
      code: '设备验证码',
      pending: '请在浏览器中完成授权，本页面会自动更新。',
      socialPending: '浏览器跳转到 kiro:// 后，请复制完整 URL 并粘贴到下方。',
      authMethod: '方式',
      profile: 'Profile',
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
.dshk-logo{display:block;width:28px;height:28px;flex:none}
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
.dshk-form{display:grid;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid #eef0f3}.dshk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dshk-field{display:grid;gap:5px;color:#4b5563;font-size:12px}.dshk-field-wide{grid-column:1/-1}
.dshk-input{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#111827;font:inherit;font-size:13px}
textarea.dshk-input{min-height:78px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dshk-details{overflow-wrap:anywhere}.dshk-callback{display:grid;gap:8px;margin-top:10px}
.dshk-list{display:grid;gap:8px}.dshk-model{padding:11px 12px;border:1px solid #eef0f3;border-radius:10px;background:#fcfcfd}
.dshk-model-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.dshk-model-name{font-size:14px;font-weight:650}.dshk-model-id{color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dshk-model-desc{margin-top:4px;color:#6b7280;font-size:12px;line-height:18px}.dshk-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dshk-pill{padding:3px 7px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px}.dshk-pill-reason{background:#ede9fe;color:#6d28d9}
.dshk-error{margin-top:10px;padding:9px 11px;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:12px;white-space:pre-wrap}
.dshk-empty{padding:18px;text-align:center;color:#9ca3af;font-size:13px}
@media(max-width:620px){.dshk-grid{grid-template-columns:1fr}.dshk-field-wide{grid-column:auto}}
@media(prefers-color-scheme:dark){.dshk-wrap{color:#f3f4f6}.dshk-card{border-color:#303642;background:#171a21}.dshk-status,.dshk-model{background:#1d2129;border-color:#303642;color:#d1d5db}.dshk-btn,.dshk-input{border-color:#434b59;background:#20242d;color:#f3f4f6}.dshk-form{border-color:#303642}.dshk-field{color:#d1d5db}.dshk-code{border-color:#4338ca;background:#272447;color:#c7d2fe}.dshk-pill{background:#2a303a;color:#cbd5e1}.dshk-pill-reason{background:#332a52;color:#c4b5fd}}
`
      document.head.appendChild(style)
    }

    function formatTokens(value) {
      if (!Number.isFinite(value)) return undefined
      if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`
      if (value >= 1000) return `${Math.round(value / 1000)}K`
      return String(value)
    }

    function KiroLogo() {
      return React.createElement('svg', {
        className: 'dshk-logo',
        viewBox: '0 0 1200 1200',
        fill: 'none',
        focusable: 'false',
        'aria-hidden': 'true',
      },
      React.createElement('rect', { width: 1200, height: 1200, rx: 260, fill: '#9046FF' }),
      React.createElement('path', {
        d: 'M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z',
        fill: 'white',
      }),
      React.createElement('path', {
        d: 'M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z',
        fill: 'black',
      }),
      React.createElement('path', {
        d: 'M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z',
        fill: 'black',
      }))
    }

    function KiroSettings({ ctx }) {
      const t = useMemo(() => translator(ctx), [ctx])
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [method, setMethod] = useState('builder-id')
      const [fields, setFields] = useState({})

      const updateField = useCallback((name, value) => {
        setFields((current) => ({ ...current, [name]: value }))
      }, [])

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
        const imported = method === 'refresh-token' || method === 'api-key' || method === 'external-idp'
        const popup = imported ? null : window.open('about:blank', '_blank')
        if (popup) popup.opener = null
        try {
          if (imported) {
            const payload = method === 'refresh-token'
              ? {
                  method,
                  refreshToken: fields.refreshToken,
                  region: fields.region,
                  profileArn: fields.profileArn,
                  clientId: fields.clientId,
                  clientSecret: fields.clientSecret,
                  startUrl: fields.startUrl,
                }
              : method === 'api-key'
                ? { method, apiKey: fields.apiKey, region: fields.region }
                : { method, credentials: fields.credentials }
            setStatus(await api('/credentials/import', { method: 'POST', body: JSON.stringify(payload) }))
            return
          }
          const flow = await api('/login', {
            method: 'POST',
            body: JSON.stringify({ method, region: fields.region, startUrl: fields.startUrl }),
          })
          if (flow.authUrl && popup) popup.location.replace(flow.authUrl)
          else if (flow.authUrl) window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
          await load()
        } catch (cause) { popup?.close(); setError(cause.message) } finally { setBusy('') }
      }, [fields, load, method])

      const completeSocial = useCallback(async () => {
        setBusy('callback'); setError('')
        try {
          await api('/login/social/complete', {
            method: 'POST',
            body: JSON.stringify({ callbackUrl: fields.callbackUrl }),
          })
          await load()
        } catch (cause) { setError(cause.message) } finally { setBusy('') }
      }, [fields.callbackUrl, load])

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
      const importMethod = method === 'refresh-token' || method === 'api-key' || method === 'external-idp'
      const loginLabel = importMethod ? t('import') : t('login')
      const field = (name, label, options = {}) => React.createElement('label', {
        className: `dshk-field${options.wide ? ' dshk-field-wide' : ''}`,
      },
      React.createElement('span', null, label),
      options.textarea
        ? React.createElement('textarea', {
            className: 'dshk-input',
            value: fields[name] || '',
            placeholder: options.placeholder,
            onChange: (event) => updateField(name, event.target.value),
          })
        : React.createElement('input', {
            className: 'dshk-input',
            type: options.secret ? 'password' : 'text',
            value: fields[name] || '',
            placeholder: options.placeholder,
            autoComplete: options.secret ? 'off' : undefined,
            onChange: (event) => updateField(name, event.target.value),
          }))

      const loginFields = method === 'idc'
        ? [
            field('startUrl', t('startUrl'), { wide: true, placeholder: 'https://example.awsapps.com/start' }),
            field('region', t('region'), { placeholder: 'us-east-1' }),
          ]
        : method === 'builder-id'
          ? [field('region', t('region'), { placeholder: 'us-east-1' })]
          : method === 'refresh-token'
            ? [
                field('refreshToken', t('refreshToken'), { wide: true, textarea: true, secret: true }),
                field('profileArn', t('profileArn'), { wide: true, placeholder: 'arn:aws:codewhisperer:…:profile/…' }),
                field('region', t('region'), { placeholder: 'us-east-1' }),
                field('startUrl', t('startUrl'), { placeholder: 'https://example.awsapps.com/start' }),
                field('clientId', t('clientId'), { secret: true }),
                field('clientSecret', t('clientSecret'), { secret: true }),
              ]
            : method === 'api-key'
              ? [
                  field('apiKey', t('apiKey'), { wide: true, secret: true }),
                  field('region', t('region'), { placeholder: 'us-east-1' }),
                ]
              : method === 'external-idp'
                ? [field('credentials', t('credentialJson'), { wide: true, textarea: true, secret: true })]
                : []

      return React.createElement('div', { className: 'dshk-wrap' },
        React.createElement('h2', { className: 'dshk-title' },
          React.createElement(KiroLogo),
          t('title')),
        React.createElement('p', { className: 'dshk-desc' }, t('description')),
        React.createElement('section', { className: 'dshk-card' },
          React.createElement('div', { className: 'dshk-head' },
            React.createElement('div', { className: 'dshk-heading' }, t('account')),
            React.createElement('div', { className: 'dshk-actions' },
              status?.credentialSource === 'dsh' && React.createElement('button', { className: 'dshk-btn', disabled: !!busy, onClick: logout }, t('logout')))),
          React.createElement('div', { className: 'dshk-status' },
            React.createElement('span', { className: `dshk-dot${status?.authenticated ? ' dshk-dot-on' : ''}` }),
            React.createElement('span', null, accountLabel),
            status?.region && React.createElement('span', null, `· ${status.region}`)),
          status?.authenticated && React.createElement('div', { className: 'dshk-meta dshk-details' },
            status.authMethod && `${t('authMethod')}: ${status.authMethod}`,
            status.authMethod && status.profileArn && ' · ',
            status.profileArn && `${t('profile')}: ${status.profileArn}`),
          !status?.authenticated && React.createElement('div', { className: 'dshk-form' },
            React.createElement('label', { className: 'dshk-field' },
              React.createElement('span', null, t('method')),
              React.createElement('select', {
                className: 'dshk-input',
                value: method,
                disabled: !!busy,
                onChange: (event) => { setMethod(event.target.value); setError('') },
              },
              React.createElement('option', { value: 'builder-id' }, t('builderId')),
              React.createElement('option', { value: 'idc' }, t('idc')),
              React.createElement('option', { value: 'google' }, t('google')),
              React.createElement('option', { value: 'github' }, t('github')),
              React.createElement('option', { value: 'refresh-token' }, t('refreshToken')),
              React.createElement('option', { value: 'api-key' }, t('apiKey')),
              React.createElement('option', { value: 'external-idp' }, t('externalIdp')))),
            loginFields.length > 0 && React.createElement('div', { className: 'dshk-grid' }, loginFields),
            React.createElement('div', { className: 'dshk-actions' },
              React.createElement('button', {
                className: 'dshk-btn dshk-primary', disabled: !!busy, onClick: login,
              }, busy === 'login' ? t('signingIn') : loginLabel))),
          flow?.status === 'pending' && flow.kind === 'device' && React.createElement('div', { className: 'dshk-code' },
            t('code'), React.createElement('strong', null, flow.userCode),
            React.createElement('div', { className: 'dshk-meta' }, t('pending'))),
          flow?.status === 'pending' && flow.kind === 'social' && React.createElement('div', { className: 'dshk-code' },
            React.createElement('div', null, t('socialPending')),
            React.createElement('div', { className: 'dshk-callback' },
              React.createElement('input', {
                className: 'dshk-input', value: fields.callbackUrl || '', placeholder: 'kiro://kiro.kiroAgent/authenticate-success?…',
                onChange: (event) => updateField('callbackUrl', event.target.value),
              }),
              React.createElement('button', {
                className: 'dshk-btn dshk-primary', disabled: !!busy, onClick: completeSocial,
              }, busy === 'callback' ? t('signingIn') : t('complete')))),
          flow?.status === 'error' && React.createElement('div', { className: 'dshk-error' }, flow.error),
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
