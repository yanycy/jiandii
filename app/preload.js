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

  // 版本更新
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: v => ipcRenderer.invoke('update:download', v),
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
