export type AuthField = 'user' | 'password' | 'confirmPassword'
export type AuthFieldErrors = Partial<Record<AuthField, string>>

export interface AuthPageOptions {
  readonly returnTo: string
  readonly initialized: boolean
  readonly username: string
  readonly error?: string
  readonly fieldErrors?: AuthFieldErrors
}

/** Validate form input before hashing or counting a failed sign-in attempt. */
export function validateAuthInput(
  body: Readonly<Record<string, unknown>>,
  initialized: boolean,
): AuthFieldErrors {
  const errors: AuthFieldErrors = {}
  const username = typeof body.user === 'string' ? body.user.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/iu.test(username)) {
    errors.user = '用户名须为 3–64 位英文字母、数字、点、短横线或下划线，并以字母或数字开头。'
  }
  if (Array.from(password).length < 8 || password.length > 1_024) {
    errors.password = '密码须为 8–1024 个字符，请重新输入。'
  }
  if (
    !initialized &&
    (typeof body.confirmPassword !== 'string' ||
      body.confirmPassword !== password ||
      password === '')
  ) {
    errors.confirmPassword = '两次输入的密码不一致，请重新输入密码并确认。'
  }
  return errors
}

/** Escape all user-controlled content before inserting it into an HTML attribute or text. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Render a complete, script-free form so errors and retries work without JavaScript. */
export function renderLoginPage(options: AuthPageOptions): string {
  const setup = !options.initialized
  const errors = options.fieldErrors ?? {}
  const firstError = (['user', 'password', 'confirmPassword'] as const).find(
    (key) => errors[key] !== undefined,
  )
  const field = (name: AuthField, label: string, hint: string): string => {
    const error = errors[name]
    const username = name === 'user'
    return `<div class="field"><label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="${username ? 'text' : 'password'}"${username ? ` value="${escapeHtml(options.username)}" autocapitalize="none" spellcheck="false"` : ''}
        autocomplete="${username ? 'username' : setup ? 'new-password' : 'current-password'}" required
        aria-describedby="${name}-hint${error === undefined ? '' : ` ${name}-error`}"${error === undefined ? '' : ' aria-invalid="true"'}${firstError === name || (firstError === undefined && name === (options.error === undefined ? 'user' : 'password')) ? ' autofocus' : ''}>
      <p id="${name}-hint" class="hint">${hint}</p>${error === undefined ? '' : `<p id="${name}-error" class="error">${escapeHtml(error)}</p>`}</div>`
  }
  const title = setup ? '创建管理员账号' : '登录 Luban'
  const hasErrors = Object.keys(errors).length > 0
  const notice =
    options.error ??
    (hasErrors ? '请修正下面标出的内容，然后重新提交。密码需要重新输入。' : undefined)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{box-sizing:border-box}body{font:16px/1.6 system-ui,sans-serif;background:#10151d;color:#edf3fa;display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px 16px}
main{width:min(100%,440px);background:#18222e;padding:clamp(20px,5vw,36px);border:1px solid #334155;border-radius:16px;box-shadow:0 16px 48px #0005}
.brand{color:#9fc9ff;font-weight:700;letter-spacing:.08em;font-size:14px}h1{font-size:26px;line-height:1.3;margin:12px 0}.intro{color:#c2cddb;margin:0 0 24px}.field{margin:20px 0}label{display:block;font-weight:600;margin-bottom:6px}
input,button{font:inherit;border-radius:8px;padding:11px 12px;width:100%}input{background:#101923;color:#edf3fa;border:1px solid #65758b}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #8dbdff;outline-offset:3px}input[aria-invalid=true]{border-color:#ffaaa5}
button{background:#8bbdff;color:#07111e;border:0;font-weight:700;cursor:pointer;margin-top:8px}button:hover{background:#b1d3ff}.error{color:#ffb6b0;font-size:14px;margin:6px 0}.summary{padding:12px;border:1px solid #af645f;background:#3a2429;border-radius:8px}.hint{color:#aebdce;font-size:13px;margin:6px 0}.footer{margin-top:22px;border-top:1px solid #334155;padding-top:16px}a{color:#9fc9ff}
</style></head><body><main><div class="brand">LUBAN · 鲁班</div><h1>${title}</h1>
<p class="intro">${setup ? '首次使用，请在这里设置用户名和密码。创建成功后会自动登录，无需配置环境变量。' : '使用这台主机上的 Luban 账号继续。'}</p>
${notice === undefined ? '' : `<div class="error summary" role="alert">${escapeHtml(notice)}</div><a href="/luban-auth/login">重新打开登录页</a>`}
<form method="post" action="/luban-auth/login" novalidate>
<input type="hidden" name="returnTo" value="${escapeHtml(options.returnTo)}">
<input type="hidden" name="intent" value="${setup ? 'setup' : 'login'}">
${field('user', '用户名', '3–64 位英文字母、数字、点（.）、短横线（-）或下划线（_）；以字母或数字开头，不区分大小写。')}
${field('password', '密码', '8–1024 个字符，可以使用空格和中文；区分大小写。')}
${setup ? field('confirmPassword', '确认密码', '再次输入相同的密码。') : ''}
<button type="submit">${setup ? '创建账号并登录' : '登录'}</button></form>
<p class="hint footer">${setup ? '此账号将成为这台主机的管理员。请妥善保存账号密码，并在可信网络中完成设置。' : '没有账号或忘记密码？请联系这台主机的管理员。已有账号的主机不开放匿名注册。'}</p>
</main></body></html>`
}
