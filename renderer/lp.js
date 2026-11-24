'use strict';
// Bridge to the native host (replaces the Electron preload)
const toUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
window.lp = {
  pick: () => window.nPick(),
  scan: (paths) => window.nScan(paths),
  readFile: (p) => fetch(toUrl(p)).then((r) => r.arrayBuffer()),
  getState: async () => { let s = {}; try { s = JSON.parse(localStorage.getItem('lp') || '{}'); } catch (_) {} s.launch = await window.nLaunch(); return s; },
  setState: async (patch) => { try { localStorage.setItem('lp', JSON.stringify({ ...JSON.parse(localStorage.getItem('lp') || '{}'), ...patch })); } catch (_) {} },
  pathForFile: () => '',
  onOpenPaths: () => {},
  win: { drag: () => window.nDrag(), min: () => window.nMin(), max: () => window.nMax(), full: () => window.nFull(), close: () => window.nClose() },
};
