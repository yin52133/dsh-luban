import { describe, expect, it } from 'vitest'
import { renderLoginPage, validateAuthInput } from '../src/auth-page.js'

describe('account form validation', () => {
  it('explains local administrator recovery without exposing a reset endpoint', () => {
    const html = renderLoginPage({ returnTo: '/', initialized: true, username: '' })
    expect(html).toContain('管理员忘记密码怎么办')
    expect(html).toContain('sudo')
    expect(html).not.toContain('action="/luban-auth/reset')
  })
  it('identifies each invalid field and accepts normalized usernames and Unicode passwords', () => {
    expect(
      Object.keys(
        validateAuthInput({ user: '/ab', password: 'short', confirmPassword: 'other' }, false),
      ),
    ).toEqual(['user', 'password', 'confirmPassword'])
    expect(
      validateAuthInput(
        {
          user: ' Admin_1 ',
          password: '中文密码可以使用空格 ',
          confirmPassword: '中文密码可以使用空格 ',
        },
        false,
      ),
    ).toEqual({})
    expect(validateAuthInput({}, true)).toHaveProperty('user')
    expect(validateAuthInput({ user: 'admin', password: '🔑'.repeat(7) }, true)).toHaveProperty(
      'password',
    )
  })

  it('renders escaped fields, visible rules, and accessible errors without password values', () => {
    const html = renderLoginPage({
      returnTo: '/?x="<tag>',
      initialized: false,
      username: '"><script>',
      fieldErrors: { user: '错误 <name>' },
    })
    expect(html).toContain('aria-invalid="true" autofocus')
    expect(html).toContain('user-hint user-error')
    expect(html).toContain('role="alert"')
    expect(html).toContain('novalidate')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).toContain('错误 &lt;name&gt;')
    expect(html).not.toMatch(/name="(?:password|confirmPassword)"[^>]*value=/u)
  })
})
