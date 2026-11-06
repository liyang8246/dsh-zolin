/** Settings copy for the default locale. */
export const en = {
  title: 'CodeTime',
  subtitle: 'Upload Harness coding activity to codetime.dev.',
  connected: 'Connected',
  notConnected: 'No token yet',
  unavailable: 'Unable to read connection status',
  tokenLabel: 'Upload token',
  tokenPlaceholder: 'Paste the token from codetime.dev/dashboard/settings',
  tokenHint: 'Create an upload token on the codetime.dev dashboard, then paste it here. The Harness sends turns, tool calls, models and token usage for this machine only.',
  autoUpload: 'Upload automatically',
  save: 'Save',
  syncNow: 'Upload now',
  disconnect: 'Disconnect',
  saved: 'Token saved',
  cleared: 'Token removed',
  loading: 'Loading…',
  failed: 'CodeTime request failed',
  pending: 'to upload',
  sessions: 'sessions',
  uploaded: 'Uploaded',
  lastUpload: 'Last upload',
  never: 'never',
  machine: 'Machine',
}

/** Settings copy for Chinese. */
export const zh: Record<keyof typeof en, string> = {
  title: 'CodeTime',
  subtitle: '把 Harness 的 AI 编码数据上报到 codetime.dev。',
  connected: '已连接',
  notConnected: '未填写 token',
  unavailable: '无法读取连接状态',
  tokenLabel: '上报 Token',
  tokenPlaceholder: '粘贴 codetime.dev/dashboard/settings 里的 token',
  tokenHint: '在 codetime.dev 后台创建一个上报 token 后粘贴到这里。只会把本机的轮次、工具调用、模型与 token 用量发出去。',
  autoUpload: '自动上报',
  save: '保存',
  syncNow: '立即上报',
  disconnect: '断开连接',
  saved: 'Token 已保存',
  cleared: 'Token 已清除',
  loading: '加载中…',
  failed: '编码统计请求失败',
  pending: '待上报',
  sessions: '个会话',
  uploaded: '已上报',
  lastUpload: '上次上报',
  never: '从未',
  machine: '机器',
}

export const css = `
.ct-settings{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ct-settings h2,.ct-settings h3,.ct-settings p{margin:0}
.ct-settings h2{font-size:16px;font-weight:600}
.ct-settings .ct-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.ct-settings .ct-card{padding:16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:12px}
.ct-settings .ct-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600}
.ct-settings .ct-badge{font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.8;letter-spacing:.4px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ct-settings .ct-muted{color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}
.ct-settings .ct-form{display:flex;flex-direction:column;gap:10px}
.ct-settings label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.ct-settings .ct-inline{display:flex;align-items:flex-end;gap:8px}
.ct-settings .ct-grow{flex:1 1 auto;min-width:0}
.ct-settings .ct-spacer{margin-left:auto}
.ct-settings input[type=password],.ct-settings input[type=text]{font:inherit;box-sizing:border-box;min-height:32px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:0;width:100%}
.ct-settings input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ct-settings .ct-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.ct-settings button{font:inherit;min-height:30px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.ct-settings button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ct-settings button:disabled{opacity:.5;cursor:default}
.ct-settings button[data-primary=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ct-settings button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ct-settings .ct-switch{display:flex;flex-direction:row;align-items:center;gap:8px;cursor:pointer;font-size:12px}
.ct-settings .ct-switch input{appearance:none;-webkit-appearance:none;position:relative;width:36px;height:20px;min-height:0;padding:0;border:0;border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s;flex:none}
.ct-settings .ct-switch input::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.ct-settings .ct-switch input:checked{background:var(--dsw-alias-label-primary)}
.ct-settings .ct-switch input:checked::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.ct-settings .ct-switch input:disabled{opacity:.5;cursor:default}
.ct-settings .ct-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.ct-settings .ct-error{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.ct-settings .ct-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
`
