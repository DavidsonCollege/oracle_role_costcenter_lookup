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
});
