import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../client/index.cjs', import.meta.url), 'utf8')

describe("settings page: several accounts", () => {
  it("lists the accounts the status API reports", () => {
    expect(source).toContain('const accountList = Array.isArray(status?.accounts?.accounts)')
    expect(source).toContain('accountList.length > 0 && React.createElement')
  })

  it("marks the active account and offers to switch to the others", () => {
    expect(source).toContain('dshk-account-active')
    expect(source).toContain("account.active && React.createElement('span', { className: 'dshk-badge' }, t('activeAccount'))")
    expect(source).toContain('!account.active && React.createElement')
  })

  it("switches accounts through the account API and re-reads usage", () => {
    expect(source).toContain("await api('/accounts/activate'")
    expect(source).toContain('if (next?.authenticated) await refreshUsage()')
  })

  it("names a replacement when the removed account is the active one", () => {
    expect(source).toContain('...account.active && remaining.length > 0 ? { replacementId: remaining[0].id } : {}')
    expect(source).toContain("await api('/accounts/remove'")
    expect(source).toContain("window.confirm(t('removeAccountConfirm'))")
  })

  it("re-authenticates one named account instead of replacing the selection", () => {
    expect(source).toContain("const [targetAccountId, setTargetAccountId] = useState('')")
    expect(source).toContain('onClick: () => openAuth(account.id)')
    expect(source).toContain('accountId: targetAccountId,')
  })

  it("labels signing out of every account as such", () => {
    expect(source).toContain("accountList.length > 1 ? t('signOutAll') : t('logout')")
  })
})
