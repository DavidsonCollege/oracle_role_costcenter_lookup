const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcmAPI', {
  lookup       : (params) => ipcRenderer.invoke('hcm:lookup',        params),
  autoProvRules: (params) => ipcRenderer.invoke('hcm:autoProvRules', params),
  ccReport    : (params) => ipcRenderer.invoke('hcm:ccreport',     params),
  ccHierarchy : (params) => ipcRenderer.invoke('hcm:ccHierarchy',  params),
  appVersion    : ()      => ipcRenderer.invoke('app:version'),
  appRelaunch   : ()      => ipcRenderer.invoke('app:relaunch'),
  buildDate     : ()      => ipcRenderer.invoke('app:buildDate'),
  openExternal  : (url)   => ipcRenderer.invoke('shell:openExternal', url),
  getSettings  : ()       => ipcRenderer.invoke('hcm:getSettings'),
  saveSettings : (params) => ipcRenderer.invoke('hcm:saveSettings', params),
  manageCCRole : (params) => ipcRenderer.invoke('hcm:manageCCRole', params),

  // Search index (OSCS) rebuild
  oscsConfig        : (params) => ipcRenderer.invoke('oscs:config',          params),
  oscsOpenConfig    : ()       => ipcRenderer.invoke('oscs:openConfig'),
  oscsOpenRunsFolder: ()       => ipcRenderer.invoke('oscs:openRunsFolder'),
  oscsListRuns      : ()       => ipcRenderer.invoke('oscs:listRuns'),
  oscsStart         : (params) => ipcRenderer.invoke('oscs:start',           params),
  oscsStop          : ()       => ipcRenderer.invoke('oscs:stop'),
  oscsInspect       : (params) => ipcRenderer.invoke('oscs:inspect',         params),
  oscsSetSlack      : (params) => ipcRenderer.invoke('oscs:setSlackWebhook', params),
  oscsTestSlack     : ()       => ipcRenderer.invoke('oscs:testSlack'),
  onOscsProgress    : (cb)     => ipcRenderer.on('oscs:progress', (_event, run) => cb(run)),
});
