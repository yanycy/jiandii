const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 只读状态
  state: () => ipcRenderer.invoke('app:state'),
  saveCfg: cfg => ipcRenderer.invoke('cfg:save', cfg),

  // 主题
  setTheme: t => ipcRenderer.send('theme:set', t),

  // 任务
  start: opts => ipcRenderer.send('run:start', opts),
  stop: () => ipcRenderer.send('run:stop'),
  closeBrowser: () => ipcRenderer.invoke('browser:close'),
  quit: () => ipcRenderer.send('app:quit'),

  // 文件
  openDir: () => ipcRenderer.invoke('app:openDir'),
  openPath: p => ipcRenderer.invoke('app:openPath', p),
  readReport: f => ipcRenderer.invoke('report:read', f),

  // 历史任务
  tasks: () => ipcRenderer.invoke('task:list'),
  getTask: id => ipcRenderer.invoke('task:get', id),
  deleteTask: id => ipcRenderer.invoke('task:delete', id),

  // 智能体（知识库 / AI 自动回复）
  agentState: () => ipcRenderer.invoke('agent:state'),
  agentKb: () => ipcRenderer.invoke('agent:kb'),
  agentKbSave: p => ipcRenderer.invoke('agent:kbSave', p),
  agentKbReset: k => ipcRenderer.invoke('agent:kbReset', k),
  agentCfgSave: p => ipcRenderer.invoke('agent:cfgSave', p),
  agentTest: () => ipcRenderer.invoke('agent:test'),
  agentTry: t => ipcRenderer.invoke('agent:try', t),
  agentStart: () => ipcRenderer.invoke('agent:start'),
  agentStop: () => ipcRenderer.invoke('agent:stop'),
  agentScan: () => ipcRenderer.invoke('agent:scan'),
  agentDiag: () => ipcRenderer.invoke('agent:diag'),
  agentUpload: () => ipcRenderer.invoke('agent:upload'),
  agentUploadBuffer: (name, data) => ipcRenderer.invoke('agent:uploadBuffer', { name, data }),
  agentGenerateKeywords: () => ipcRenderer.invoke('agent:generateKeywords'),
  agentBatchConvs: () => ipcRenderer.invoke('agent:batchConvs'),
  agentBatchSend: p => ipcRenderer.invoke('agent:batchSend', p),
  agentBatchStop: () => ipcRenderer.invoke('agent:batchStop'),
  agentOpenKbDir: () => ipcRenderer.invoke('agent:openKbDir'),

  // 版本更新
  checkUpdate: () => ipcRenderer.invoke('update:check'),  downloadUpdate: v => ipcRenderer.invoke('update:download', v),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  showUpdateFile: () => ipcRenderer.invoke('update:openFile'),
  setForcing: on => ipcRenderer.send('update:forcing', !!on),

  // 事件订阅
  on: (channel, cb) => {
    const allow = ['log', 'log:append', 'state', 'run:done', 'run:error', 'update:available', 'update:progress', 'update:noclose'];
    if (!allow.includes(channel)) return () => {};
    const fn = (e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
