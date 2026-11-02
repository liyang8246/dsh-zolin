import type { ChannelId } from '../shared/types.js'

export const en = {
  title: 'Model Accounts',
  refresh: 'Refresh quota',
  refreshAll: 'Refresh all quotas',
  add: 'Add account',
  label: 'Account label',
  key: 'API key',
  save: 'Save API key',
  login: 'Sign in with browser',
  empty: 'No accounts yet',
  remove: 'Remove',
  confirmRemove: 'Remove this saved login and its local credentials?',
  cancel: 'Cancel',
  open: 'Open authorization page',
  code: 'Authorization code',
  reply: 'Continue',
  pending: 'Waiting for browser authorization…',
  paste: 'Callback blocked? Paste the redirect URL',
  loading: 'Loading…',
  unavailable: 'Unavailable',
  notFetched: 'Not fetched',
  failed: 'Account operation failed',
  used: 'used',
  left: 'left',
  week: 'Week',
  month: 'Month',
  other: 'Other window',
}

export const zh: Record<keyof typeof en, string> = {
  title: '模型账号',
  refresh: '刷新额度',
  refreshAll: '刷新全部额度',
  add: '添加账号',
  label: '账号名称',
  key: 'API Key',
  save: '保存 API Key',
  login: '浏览器登录',
  empty: '暂无账号',
  remove: '删除',
  confirmRemove: '删除此登录账号及其本地凭据？',
  cancel: '取消',
  open: '打开授权页面',
  code: '授权码',
  reply: '继续',
  pending: '等待浏览器授权…',
  paste: '无法自动回调？粘贴跳转地址',
  loading: '加载中…',
  unavailable: '不可用',
  notFetched: '未查询',
  failed: '账号操作失败',
  used: '已用',
  left: '剩余',
  week: '周',
  month: '月',
  other: '其他窗口',
}

export const quotaPeriods = ['5h', 'week', 'month'] as const

export const authorizationHosts: Record<ChannelId, readonly string[]> = {
  'openai-codex': ['auth.openai.com', 'chatgpt.com'],
  'opencode-go': ['opencode.ai'],
  'commandcode-go': [],
}

export const css = `
.zph-accounts{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.zph-accounts h2,.zph-accounts h3,.zph-accounts p{margin:0}.zph-accounts h2{font-size:16px;font-weight:600}.zph-accounts h3{font-size:14px;font-weight:600}
.zph-accounts .zph-muted{color:var(--dsw-alias-label-secondary);font-size:11px}.zph-accounts .zph-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.zph-accounts .zph-between{justify-content:space-between}
.zph-accounts .zph-channel{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}.zph-accounts .zph-head{padding:16px;background:var(--dsw-alias-bg-layer-1)}
.zph-accounts .zph-account{padding:16px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}.zph-accounts .zph-account label{display:flex;align-items:center;gap:8px;cursor:pointer;overflow-wrap:anywhere}
.zph-accounts button,.zph-accounts input{font:inherit;box-sizing:border-box;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 10px}
.zph-accounts button{cursor:pointer}.zph-accounts button:hover{background:var(--dsw-alias-bg-layer-2)}.zph-accounts button:disabled{opacity:.5;cursor:default}.zph-accounts button.zph-link{border:0;background:none;min-height:0;padding:0;color:var(--dsw-alias-brand-primary);text-decoration:underline}.zph-accounts input{max-width:100%;min-width:0}.zph-accounts input[type=radio]{accent-color:var(--dsw-alias-brand-primary);min-height:0;padding:0}
.zph-accounts button:focus-visible,.zph-accounts input:focus-visible,.zph-accounts a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.zph-accounts a{color:var(--dsw-alias-brand-primary)}
.zph-accounts .zph-quota{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.zph-accounts .zph-window{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11px;overflow-wrap:anywhere}.zph-accounts .zph-window-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.zph-accounts .zph-track{margin:6px 0 0;width:100%}.zph-accounts .zph-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.zph-accounts .zph-quota-unavailable{padding-left:5px}.zph-accounts .zph-quota-unavailable > p{display:inline}.zph-accounts .zph-quota-unavailable > p + p{margin-left:8px}
.zph-accounts .zph-add{padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}.zph-accounts .zph-form{display:flex;flex-direction:column;gap:10px;margin-top:10px}.zph-accounts .zph-form label{display:flex;flex-direction:column;gap:4px}.zph-accounts .zph-grow{flex:1 1 180px;min-width:0}.zph-accounts .zph-align-end{align-items:flex-end}
.zph-accounts .zph-switch{display:flex;align-items:center;cursor:pointer}.zph-accounts .zph-switch input{appearance:none;-webkit-appearance:none;position:relative;width:36px;height:20px;min-height:0;padding:0;border:0;border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s}
.zph-accounts .zph-switch input::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.zph-accounts .zph-switch input:checked{background:var(--dsw-alias-label-primary)}.zph-accounts .zph-switch input:checked::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}.zph-accounts .zph-switch input:disabled{opacity:.5;cursor:default}
.zph-accounts .zph-pill{font-size:10px;line-height:1.4;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.zph-composer-quota{display:flex;flex-direction:column;gap:3px;width:128px;flex:none}.zph-composer-quota[data-count="3"] .zph-track{height:3px}
.zph-track{display:block;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.zph-track b{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.zph-track[data-level=high] b{background:var(--dsw-alias-state-warn-primary)}
.zph-track[data-level=full] b{background:var(--dsw-alias-state-error-primary)}
.zph-accounts .zph-login{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:8px;flex-wrap:wrap;align-self:stretch}.zph-accounts code{font-family:monospace;user-select:all}.zph-accounts .zph-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
@media(max-width:520px){.zph-accounts .zph-actions{margin-left:0}}
`
