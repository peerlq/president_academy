let nodes = {};
let adj = {};
let contentBBoxCache = null;
const snapCache = new Map();
let DEBUG_NAV = false;
const VALID_CONN = new Set([
  'room-door', 'door-room',
  'door-corridor', 'corridor-door',
  'corridor-corridor',
  'corridor-exit', 'exit-corridor',
  'room-exit', 'exit-room',
  'door-exit', 'exit-door',
  'stair-corridor', 'corridor-stair',
  'room-stair', 'stair-room',
  'door-stair', 'stair-door',
  'door-door'
]);

function clearCaches() {
  contentBBoxCache = null;
  snapCache.clear();
}

function getCenter(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'rect') {
    const x = parseFloat(el.getAttribute('x') || '0');
    const y = parseFloat(el.getAttribute('y') || '0');
    const w = parseFloat(el.getAttribute('width') || '0');
    const h = parseFloat(el.getAttribute('height') || '0');
    return { x: x + w / 2, y: y + h / 2 };
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseFloat(el.getAttribute('cx') || '0');
    const cy = parseFloat(el.getAttribute('cy') || '0');
    return { x: cx, y: cy };
  }
  const bb = typeof el.getBBox === 'function' ? el.getBBox() : { x: 0, y: 0, width: 0, height: 0 };
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}

function inferType(el) {
  const c = el.classList || { contains: () => false };
  if (c.contains('room')) return 'room';
  if (c.contains('exit')) return 'exit';
  if (c.contains('door')) return 'door';
  if (c.contains('corridor')) return 'corridor';
  if (c.contains('anchor')) return 'anchor';
  const t = el.getAttribute('data-type');
  if (t) return t;
  return 'corridor';
}

function resolveName(el, id) {
  const dn = el.getAttribute('data-name');
  if (dn) return dn;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  return id;
}

function getNodeLabel(node, idOverride) {
  if (!node) return idOverride || '';
  const type = node.type || 'room';
  const rawName = (node.name == null ? '' : String(node.name)).trim();
  const nodeId = idOverride != null ? String(idOverride) : (node.id != null ? String(node.id) : '');
  if (type === 'door' || type === 'exit' || type === 'stair') {
    if (rawName && rawName !== nodeId) return rawName;
    if (type === 'door') return 'дверь';
    if (type === 'exit') return 'выход';
    if (type === 'stair') return 'лестница';
  }
  return rawName || nodeId;
}

function dist(a, b) {
  let A = nodes[a];
  let B = nodes[b];
  if (!A && typeof ensureNodeFromOverlay === 'function') A = ensureNodeFromOverlay(a);
  if (!B && typeof ensureNodeFromOverlay === 'function') B = ensureNodeFromOverlay(b);
  if (!A || !B) return Infinity;
  const dx = A.x - B.x;
  const dy = A.y - B.y;
  return Math.hypot(dx, dy);
}

function addEdge(a, b, w) {
  if (!adj[a]) adj[a] = [];
  if (!adj[b]) adj[b] = [];
  if (!(adj[a].some(e => e.to === b))) adj[a].push({ to: b, w });
  if (!(adj[b].some(e => e.to === a))) adj[b].push({ to: a, w });
}

function canConnectTypes(t1, t2) {
  return VALID_CONN.has(t1 + '-' + t2);
}

function addEdgeConstrained(a, b, w) {
  const ta = nodes[a]?.type, tb = nodes[b]?.type;
  if (!ta || !tb) return;
  if (!canConnectTypes(ta, tb)) return;
  addEdge(a, b, w);
}

function buildGraph() {
  clearCaches();
  nodes = {};
  adj = {};
  const idCounts = {};
  const scope = document.getElementById('viewport') || document;
  const els = scope.querySelectorAll('[data-node], .room[id], .corridor[id], .exit[id], .door[id], .anchor[id]');
  els.forEach(el => {
    const raw = el.getAttribute('data-node') || el.getAttribute('id');
    if (!raw) return;
    const base = String(raw).replace(/(?:_\d+)+$/, '');
    let id = base;
    let occ = idCounts[base] || 0;
    if (occ > 0 || nodes[id]) {
      while (nodes[id]) { occ += 1; id = `${base}_${occ}`; }
      try { el.setAttribute('data-node', id); } catch (_) {}
    }
    idCounts[base] = occ;
    const p = getCenter(el);
    nodes[id] = { x: p.x, y: p.y, floor: '1', type: inferType(el), name: resolveName(el, id) };
    if (!adj[id]) adj[id] = [];
    const conn = (el.getAttribute('data-connect') || '').trim();
    if (conn) {
      conn.split(/[\s,;]+/).filter(Boolean).forEach(to => {
        if (!to || to === id) return;
        if (!nodes[to]) return;
        addEdgeConstrained(id, to, dist(id, to));
      });
    }
  });
  const edgeEls = scope.querySelectorAll('[data-from][data-to]');
  edgeEls.forEach(el => {
    const a = el.getAttribute('data-from');
    const b = el.getAttribute('data-to');
    if (!a || !b || !nodes[a] || !nodes[b]) return;
    const wAttr = el.getAttribute('data-weight');
    const w = wAttr ? parseFloat(wAttr) : dist(a, b);
    addEdgeConstrained(a, b, isFinite(w) && w > 0 ? w : dist(a, b));
  });

  mergeOverlayNodesToGraph();
  mergeCorridorLinesToGraph();
  connectCorridorCrossings();
  connectCorridorEndpoints();
  bridgeCorridorEndpointsToSegments();
  bridgeCorridorPointsToSegments();

  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const corridors = Object.keys(nodes).filter(id => nodes[id].type === 'corridor' || nodes[id].type === 'exit');
  mergeOverlayEdgesToGraph();

  const doors = Object.keys(nodes).filter(id => nodes[id].type === 'door');
  const exits = Object.keys(nodes).filter(id => nodes[id].type === 'exit');
  const stairs = Object.keys(nodes).filter(id => nodes[id].type === 'stair');

  Object.keys(nodes).forEach(id => {
    if (nodes[id].type !== 'door') return;
    const neighbors = adj[id] || [];
    const hasCorr = neighbors.some(e => {
      const t = nodes[e.to]?.type;
      return t === 'corridor' || t === 'exit';
    });
    if (hasCorr) return;
    let best = null, bestD = Infinity;
    for (const cid of corridors) {
      const d = dist(id, cid);
      if (d < bestD) { bestD = d; best = cid; }
    }
    const doorCorrThreshold = Math.max(36, 0.05 * Math.max(bb.width, bb.height));
    if (best && bestD <= doorCorrThreshold) {
      const dup = overlayEdges.some(e => (e.a === id && e.b === best) || (e.a === best && e.b === id));
      if (!dup) addOverlayEdge(id, best, true);
    }
  });

  doors.forEach(did => {
    const sid = snapDoorToCorridor(did);
    const overlaySetLocal = new Set(overlayNodes.map(n => n.id));
    if (sid && overlaySetLocal.has(did)) {
      const dup = overlayEdges.some(e => (e.a === did && e.b === sid) || (e.a === sid && e.b === did));
      if (!dup) addOverlayEdge(did, sid, true);
      consolidateAutoAccessLinks();
    }
  });

  doors.forEach(did => {
    const neighbors = adj[did] || [];
    const hasCorr = neighbors.some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return;
    let best = null, bestD = Infinity;
    for (const cid of corridors) {
      const d = dist(did, cid);
      if (d < bestD) { bestD = d; best = cid; }
    }
    const thresh = Math.max(36, 0.05 * Math.max(bb.width, bb.height));
    if (best && isFinite(bestD) && bestD <= thresh) {
      const dup = overlayEdges.some(e => (e.a === did && e.b === best) || (e.a === best && e.b === did));
      if (!dup) addOverlayEdge(did, best, true);
    }
  });

  exits.forEach(eid => {
    const overlaySetLocal = new Set(overlayNodes.map(n => n.id));
    if (overlaySetLocal.has(eid)) {
      const exitDoorThreshold = Math.max(48, 0.08 * Math.max(bb.width, bb.height));
      const candidates = [];
      for (const did of doors) {
        if (!nodes[did] || nodes[did].type !== 'door') continue;
        if (hasEdge(eid, did)) continue;
        if (!isDoorConnectedToCorridor(did)) continue;
        const d = dist(eid, did);
        if (d <= exitDoorThreshold) candidates.push({ did, d, base: baseId(did) });
      }
      const byBase = new Map();
      candidates.forEach(c => { const ex = byBase.get(c.base); if (!ex || c.d < ex.d) byBase.set(c.base, c); });
      const bestDoor = [...byBase.values()].sort((a, b) => a.d - b.d)[0];
      if (bestDoor) addOverlayEdge(eid, bestDoor.did, true);
    }
    const sid = snapExitToCorridor(eid);
    if (sid && overlaySetLocal.has(eid)) {
      const dup = overlayEdges.some(e => (e.a === eid && e.b === sid) || (e.a === sid && e.b === eid));
      if (!dup) addOverlayEdge(eid, sid, true);
      consolidateAutoAccessLinks();
    }
  });
  exits.forEach(eid => {
    const neighbors = adj[eid] || [];
    const hasCorr = neighbors.some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return;
    let best = null, bestD = Infinity;
    for (const cid of corridors) { const d = dist(eid, cid); if (d < bestD) { bestD = d; best = cid; } }
    const thresh = Math.max(36, 0.05 * Math.max(bb.width, bb.height));
    if (best && isFinite(bestD) && bestD <= thresh) {
      const dup = overlayEdges.some(e => (e.a === eid && e.b === best) || (e.a === best && e.b === eid));
      if (!dup) addOverlayEdge(eid, best, true);
    }
  });
  stairs.forEach(sid => {
    const snapId = snapExitToCorridor(sid);
    const overlaySetLocal = new Set(overlayNodes.map(n => n.id));
    if (snapId && overlaySetLocal.has(sid)) {
      const dup = overlayEdges.some(e => (e.a === sid && e.b === snapId) || (e.a === snapId && e.b === sid));
      if (!dup) addOverlayEdge(sid, snapId, true);
      consolidateAutoAccessLinks();
    }
  });
  stairs.forEach(sid => {
    const neighbors = adj[sid] || [];
    const hasCorr = neighbors.some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return;
    let best = null, bestD = Infinity;
    for (const cid of corridors) {
      const d = dist(sid, cid);
      if (d < bestD) { bestD = d; best = cid; }
    }
    const thresh = Math.max(36, 0.05 * Math.max(bb.width, bb.height));
    if (best && isFinite(bestD) && bestD <= thresh) {
      const dup = overlayEdges.some(e => (e.a === sid && e.b === best) || (e.a === best && e.b === sid));
      if (!dup) addOverlayEdge(sid, best, true);
    }
  });
  const overlaySet = new Set(overlayNodes.map(n => n.id));
  const overlayDoors = doors.filter(did => overlaySet.has(did));
  const overlayExits = exits.filter(eid => overlaySet.has(eid));
  const accessIds = overlayDoors; // комнаты автосвязываем только с дверями
  Object.keys(nodes).forEach(id => {
    if (nodes[id].type !== 'room') return;
    if (!overlaySet.has(id)) return; // автосвязи рисуем только для overlay-комнат
    const roomDoorThreshold = Math.max(48, 0.08 * Math.max(bb.width, bb.height));
    const candidates = [];
    for (const aid of accessIds) {
      const d = dist(id, aid);
      if (d <= roomDoorThreshold && !hasEdge(id, aid)) candidates.push({ aid, d, base: baseId(aid) });
    }
    const byBase = new Map();
    candidates.forEach(c => { const ex = byBase.get(c.base); if (!ex || c.d < ex.d) byBase.set(c.base, c); });
    const best = [...byBase.values()].sort((a, b) => a.d - b.d)[0];
    if (best) addOverlayEdge(id, best.aid, true);
  });

  consolidateAutoAccessLinks();
  mergeOverlayEdgesToGraph();
  renderOverlay();

  preprocessCorridorLines();

  if (nodeList) {
    refreshDatalist();
  }

}

function preprocessCorridorLines() {
  const scope = document.getElementById('viewport') || document;
  const lines = scope.querySelectorAll('.corridor-line');
  lines.forEach(lineEl => {
    const id = lineEl.getAttribute('data-corr-line');
    if (!id) return;
    const pts = (lineEl.getAttribute('points') || '')
      .trim().split(/\s+/)
      .map(p => {
        const [x, y] = p.split(',').map(Number);
        return { x, y };
      }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return;

    const markers = [];
    Object.keys(nodes || {}).forEach(nid => {
      const n = nodes[nid];
      if (!n || n.type !== 'corridor') return;
      if (typeof n.name === 'string' && !n.name.toLowerCase().includes('коридор')) return;
      markers.push({ id: nid, x: n.x, y: n.y });
    });
    if (!markers.length) return;

    function distPointToSeg(px, py, ax, ay, bx, by) {
      const vx = bx - ax, vy = by - ay;
      const wx = px - ax, wy = py - ay;
      const c1 = vx * wx + vy * wy;
      if (c1 <= 0) return Math.hypot(px - ax, py - ay);
      const c2 = vx * vx + vy * vy;
      if (c2 <= c1) return Math.hypot(px - bx, py - by);
      const t = c1 / c2;
      const projx = ax + t * vx;
      const projy = ay + t * vy;
      return Math.hypot(px - projx, py - projy);
    }

    const splitIndices = [];
    const tol = 2;
    markers.forEach(m => {
      let bestSeg = -1, bestD = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const A = pts[i], B = pts[i + 1];
        const d = distPointToSeg(m.x, m.y, A.x, A.y, B.x, B.y);
        if (d < bestD) {
          bestD = d;
          bestSeg = i;
        }
      }
      if (bestSeg >= 0 && bestD <= tol) {
        splitIndices.push(bestSeg + 1);
      }
    });

    if (!splitIndices.length) return;
    const unique = Array.from(new Set(splitIndices.filter(i => i > 0 && i < pts.length)))
      .sort((a, b) => a - b);

    const segments = [];
    let start = 0;
    unique.forEach(idx => {
      segments.push(pts.slice(start, idx + 1));
      start = idx;
    });
    segments.push(pts.slice(start));
    const parent = lineEl.parentNode;
    if (!parent) return;
    parent.removeChild(lineEl);
    segments.forEach((segPts, i) => {
      if (segPts.length < 2) return;
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('class', 'corridor-line');
      pl.setAttribute('data-corr-line', `${id}_s${i}`);
      pl.setAttribute('points', segPts.map(p => `${p.x},${p.y}`).join(' '));
      parent.appendChild(pl);
    });
  });
}


function ensureNodeFromElement(el) {
  if (!el) return null;
  const raw = el.getAttribute('data-node') || el.getAttribute('id');
  if (!raw) return null;
  const isOverlay = !!(el.closest && el.closest('#overlay'));
  if (isOverlay) {
    const id = String(raw).replace(/(?:_\d+)+$/, '');
    const overlayId = raw;
    if (nodes[overlayId]) return overlayId;
    const ov = overlayNodes.find(n => n.id === overlayId);
    if (ov) {
      nodes[overlayId] = { x: ov.x, y: ov.y, floor: '1', type: ov.type || 'room', name: ov.name || overlayId };
      if (!adj[overlayId]) adj[overlayId] = [];
      return overlayId;
    }
    return raw;
  }
  const base = String(raw).replace(/(?:_\d+)+$/, '');
  let id = base;
  if (nodes[id]) {
    let k = 1;
    while (nodes[`${base}_${k}`]) k++;
    id = `${base}_${k}`;
    try { el.setAttribute('data-node', id); } catch (_) {}
  }
  if (!nodes[id]) {
    const p = getCenter(el);
    const t = inferType(el);
    nodes[id] = { x: p.x, y: p.y, floor: '1', type: t, name: resolveName(el, id) };
    if (!adj[id]) adj[id] = [];
    const conn = (el.getAttribute('data-connect') || '').trim();
    if (conn) {
      conn.split(/[\s,;]+/).filter(Boolean).forEach(to => {
        if (!to || to === id || !nodes[to]) return;
        addEdgeConstrained(id, to, dist(id, to));
      });
    }
  }
  return id;
}

function heuristic(a, b) {
  return dist(a, b);
}

function doorIsBridge(id) {
  if (!nodes[id] || nodes[id].type !== 'door') return false;
  const neighbors = adj[id] || [];
  const lines = new Set();
  for (const e of neighbors) {
    const t = nodes[e.to]?.type;
    if (t !== 'corridor') continue;
    const nid = e.to;
    const m = String(nid).match(/^(.*)_\d+$/);
    const lineId = m ? m[1] : nid;
    lines.add(lineId);
  }
  return lines.size >= 2;
}

function doorIsRoomBridge(id) {
  if (!nodes[id] || nodes[id].type !== 'door') return false;
  const neighbors = adj[id] || [];
  let hasRoom = false, hasCorr = false;
  for (const e of neighbors) {
    const t = nodes[e.to]?.type;
    if (t === 'room') hasRoom = true;
    else if (t === 'corridor') hasCorr = true;
    if (hasRoom && hasCorr) return true;
  }
  return false;
}

function isDoorConnectedToCorridor(doorId, seen) {
  const door = nodes[doorId];
  if (!door || door.type !== 'door') return false;
  const visited = seen || new Set();
  if (visited.has(doorId)) return false;
  visited.add(doorId);
  const neighbors = adj[doorId] || [];
  const hasCorr = neighbors.some(e => nodes[e.to]?.type === 'corridor');
  if (hasCorr) return true;
  if (doorIsBridge(doorId) || doorIsRoomBridge(doorId)) return true;
  if (visited.size > 4) return false;
  for (const e of neighbors) {
    const t = nodes[e.to]?.type;
    if (t === 'door') {
      if (isDoorConnectedToCorridor(e.to, visited)) return true;
    }
  }
  return false;
}

function isRoomNavigable(roomId) {
  const room = nodes[roomId];
  if (!room || room.type !== 'room') return false;
  const neighbors = adj[roomId] || [];
  if (DEBUG_NAV) console.log('🧭 isRoomNavigable check', {
    roomId,
    neighbors: neighbors.map(e => ({ to: e.to, type: nodes[e.to]?.type }))
  });
  for (const e of neighbors) {
    const t = nodes[e.to]?.type;
    if (t === 'corridor') return true;
    if (t === 'door' && isDoorConnectedToCorridor(e.to)) return true;
    if (t === 'exit') {
      const nb = adj[e.to] || [];
      if (nb.some(ne => nodes[ne.to]?.type === 'corridor')) return true;
    }
    if (t === 'stair') {
      const nb = adj[e.to] || [];
      if (nb.some(ne => nodes[ne.to]?.type === 'corridor')) return true;
    }
  }
  if (DEBUG_NAV) console.log('🧭 isRoomNavigable: no valid edges for room', { roomId });
  return false;
}

function astar(start, goal, allowDoors, onlyTypes) {
  const open = new Set([start]);
  const came = {};
  const g = {};
  const f = {};
  Object.keys(nodes).forEach(k => { g[k] = Infinity; f[k] = Infinity; });
  g[start] = 0;
  f[start] = heuristic(start, goal);

  while (open.size) {
    let current = null, best = Infinity;
    for (const n of open) {
      if (f[n] < best) { best = f[n]; current = n; }
    }
    if (current === goal) return reconstruct(came, current);
    open.delete(current);
    for (const { to, w } of adj[current] || []) {
      const tNext = nodes[to]?.type;
      if (onlyTypes && !onlyTypes.has(tNext)) continue;
      if (tNext === 'door') {
        if (!isDoorConnectedToCorridor(to)) continue;
        if (allowDoors && allowDoors.size && !allowDoors.has(to)) continue;
      }
      const tentative = g[current] + adjustedEdgeWeight(current, to, edgeWeight(current, to), goal);
      if (tentative < g[to]) {
        came[to] = current;
        g[to] = tentative;
        f[to] = tentative + heuristic(to, goal);
        open.add(to);
      }
    }
  }
  return null;
}

function reconstruct(came, current) {
  const path = [current];
  while (current in came) {
    current = came[current];
    path.push(current);
  }
  return path.reverse();
}

var mode;
var startId;
var goalId;
const svg = document.getElementById('map');
const viewport = document.getElementById('viewport');
let route = document.getElementById('route');
const startLabel = document.getElementById('start-label');
const goalLabel = document.getElementById('goal-label');
const stepsEl = document.getElementById('steps');
const whereBtn = document.getElementById('btn-where');
const hintEl = document.getElementById('mode-hint');
const turnsEl = document.getElementById('turns');
const startInput = document.getElementById('start-input');
const goalInput = document.getElementById('goal-input');
const nodeList = document.getElementById('node-list');
const startArrow = document.getElementById('start-arrow');
const goalArrow = document.getElementById('goal-arrow');
const nodeDropdown = document.createElement('div');
nodeDropdown.id = 'node-dropdown';
nodeDropdown.className = 'node-dropdown';
document.body.appendChild(nodeDropdown);
let searchItems = [];
let dropdownActiveInput = null;
const menuToggle = document.getElementById('menu-toggle');
const uiPanel = document.getElementById('ui');
const scrim = document.getElementById('scrim');
const markupPanel = document.getElementById('markup-ui');
const markupMenuToggle = document.getElementById('markup-menu-toggle');
const markupMenuToggleMobile = document.getElementById('markup-menu-toggle-mobile');
const mapWrap = document.getElementById('map-wrap');
const zoomSlider = document.getElementById('zoom-slider');
const tabsEl = document.getElementById('nav-tabs');
const tab2dBtn = tabsEl ? tabsEl.querySelector('[data-tab="2d"]') : null;
const tab3dBtn = tabsEl ? tabsEl.querySelector('[data-tab="3d"]') : null;
const nav3dWrap = document.getElementById('nav-3d-wrap');
const btnMark = document.getElementById('btn-mark');
const btnLink = document.getElementById('btn-link');
const btnDelete = document.getElementById('btn-delete');
const btnEditNode = document.getElementById('btn-edit-node');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const importFile = document.getElementById('import-file');
const btnHideNonRooms = document.getElementById('btn-hide-nonrooms');
const btnClearMark = document.getElementById('btn-clear-mark');
const btnCorrLine = document.getElementById('btn-corr-line');
const btnCorrFinish = document.getElementById('btn-corr-finish');
const btnDeleteEdge = document.getElementById('btn-delete-edge');
const btnDeleteLine = document.getElementById('btn-delete-line');
const markNameEl = document.getElementById('mark-name');
const markTypeEl = document.getElementById('mark-type');
const markIdEl = document.getElementById('mark-id');
const btnDebugToggle = document.getElementById('btn-debug-toggle');
const markAutoEl = document.getElementById('mark-autolink');
const editNodeModal = document.getElementById('edit-node-modal');
const editNodeNameInput = document.getElementById('edit-node-name');
const editNodeIdInput = document.getElementById('edit-node-id');
const editNodeTypeSelect = document.getElementById('edit-node-type');
const editNodeSaveBtn = document.getElementById('edit-node-save');
const editNodeCancelBtn = document.getElementById('edit-node-cancel');

let scale = 1, minScale = 0.8, maxScale = 3;
let offsetX = 0, offsetY = 0;
const pinchGain = 1;
const panMargin = 24;
const pinchTapSuppressMs = 300;
viewport.style.transformOrigin = '0 0';
let suppressClickOnce = false;
let draggingCandidate = false;
let startDownX = 0, startDownY = 0;
let wasDragging = false;


function fitSvgToContent(pad = 24) {
  const bb = getContentBBox();
  if (!bb || bb.width <= 0 || bb.height <= 0) return;
  const zoomOutFactor = 1.25;
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  const targetW = bb.width * zoomOutFactor + 2 * pad;
  const targetH = bb.height * zoomOutFactor + 2 * pad;
  const x = Math.floor(cx - targetW / 2);
  const y = Math.floor(cy - targetH / 2);
  const w = Math.ceil(targetW);
  const h = Math.ceil(targetH);
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  scale = 1; offsetX = 0; offsetY = 0; applyTransform();
  minScale = 1; maxScale = 4;
  if (zoomSlider) { zoomSlider.min = String(minScale); zoomSlider.max = String(maxScale); zoomSlider.value = String(scale); }
}

function centerOn(id, targetScale = null) {
  if (!nodes[id]) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const cx = nodes[id].x;
  const cy = nodes[id].y;
  const desired = targetScale && isFinite(targetScale) ? clamp(targetScale, minScale, maxScale) : scale;
  const ux = vb.x + vb.width / 2;
  const uy = vb.y + vb.height / 2;
  offsetX = ux - desired * cx;
  offsetY = uy - desired * cy;
  scale = desired;
  clampPan();
  applyTransform();
  syncZoomSlider();
}

let markMode = false;
let linkMode = false;
let deleteMode = false;
let deleteTargetId = null;
let linkA = null;
let corrLineMode = false;
let currentCorrLineId = null;
let deleteLineMode = false;
let linkHighlightSeg = null;
let deleteEdgeMode = false;
let hoverOverlayId = null;
const overlay = (() => {
  let g = document.getElementById('overlay');
  if (!g && viewport) { g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('id', 'overlay'); viewport.appendChild(g); }
  return g;
})();
if (!route && viewport) {
  route = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  route.setAttribute('id', 'route');
  route.setAttribute('points', '');
  viewport.appendChild(route);
}

function persistRead(key, def) {
  if (typeof localStorage === 'undefined') return def;
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : def;
  } catch (_) {
    return def;
  }
}
function persistWrite(key, val) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (_) {}
}
var overlayNodes = persistRead('navOverlayNodes', []);
var overlayEdges = persistRead('navOverlayEdges', []);
var overlayCorrLines = persistRead('navOverlayCorrLines', []);
var onlyRoomsMode = persistRead('onlyRoomsMode', true);
var autoEdgeBlocks = persistRead('navAutoEdgeBlocks', []);
DEBUG_NAV = persistRead('navDebugMode', false);

function ensureNodeFromOverlay(id) {
  if (nodes[id]) return nodes[id];
  if (!Array.isArray(overlayNodes)) return null;
  const ov = overlayNodes.find(n => n.id === id);
  if (!ov) return null;
  const t = ov.type || 'room';
  nodes[id] = { x: ov.x, y: ov.y, floor: '1', type: t, name: ov.name || id };
  if (!adj[id]) adj[id] = [];
  return nodes[id];
}
function getNodeTypeSafe(id) {
  const n = nodes[id] || ensureNodeFromOverlay(id);
  return n ? n.type : null;
}
function getNodeCoordsSafe(id) {
  const n = nodes[id] || ensureNodeFromOverlay(id);
  if (!n) return null;
  return { x: n.x, y: n.y };
}

async function initOverlayFromJsonIfEmpty() {
  let data = null;

  const inlineEl = document.getElementById('nav-overlay-data');
  if (inlineEl && inlineEl.textContent) {
    try {
      data = JSON.parse(inlineEl.textContent);
    } catch (_) {}
  }

  if (!data && typeof fetch === 'function') {
    try {
      const res = await fetch('nav_overlay.json', { cache: 'no-cache' });
      if (res.ok) {
        data = await res.json();
      }
    } catch (_) {}
  }

  if (!data) return;

  overlayNodes = Array.isArray(data.nodes) ? data.nodes : [];
  overlayEdges = Array.isArray(data.edges) ? data.edges.filter(e => !e.auto) : [];
  overlayCorrLines = Array.isArray(data.corridorLines) ? data.corridorLines : [];
  if (Array.isArray(data.autoEdgeBlocks)) {
    autoEdgeBlocks = data.autoEdgeBlocks.slice();
    persistWrite('navAutoEdgeBlocks', autoEdgeBlocks);
  }
  persistWrite('navOverlayNodes', overlayNodes);
  persistWrite('navOverlayEdges', overlayEdges);
  persistWrite('navOverlayCorrLines', overlayCorrLines);
  renderOverlay();
  buildGraph();
}

function renderOverlay() {
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!onlyRoomsMode) overlayCorrLines.forEach(line => {
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('class', 'corridor-line');
    const pts = (line.points || []).map(p => `${p.x},${p.y}`).join(' ');
    pl.setAttribute('points', pts);
    pl.setAttribute('data-corr-line', line.id);
    if (deleteLineMode) pl.classList.add('deleting');
    overlay.appendChild(pl);
  });
  if (!onlyRoomsMode) {
    const seen = new Set();
    overlayEdges.forEach(e => {
      const A = nodes[e.a];
      const B = nodes[e.b];
      if (!A || !B) return;
      const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
      if (seen.has(k)) return;
      seen.add(k);
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', String(A.x));
      ln.setAttribute('y1', String(A.y));
      ln.setAttribute('x2', String(B.x));
      ln.setAttribute('y2', String(B.y));
      ln.setAttribute('class', e && e.auto ? 'overlay-auto-link' : 'overlay-link');
      if (deleteEdgeMode) ln.classList.add('deleting');
      ln.setAttribute('data-edge', k);
      overlay.appendChild(ln);
    });
  }
  overlayNodes.forEach(n => {
    const t = n.type || 'room';
    if (onlyRoomsMode && !(t === 'room' || t === 'exit' || t === 'stair')) return;
    const label = getNodeLabel(n);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const isRoomsOnly = !!onlyRoomsMode && (t === 'room' || t === 'exit' || t === 'stair');
    g.setAttribute('data-node', n.id);
    g.setAttribute('data-name', label || n.id);
    g.setAttribute('data-type', n.type || 'room');
    let nodeClass = `overlay-node ${n.type || 'room'}${isRoomsOnly ? ' rooms-only' : ''}`;
    if (startId && n.id === startId) nodeClass += ' selected-start-node';
    if (goalId && n.id === goalId) nodeClass += ' selected-goal-node';
    g.setAttribute('class', nodeClass);
    overlay.appendChild(g);
    const baseR = isRoomsOnly ? 10 : 8;
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('cx', String(n.x));
    hit.setAttribute('cy', String(n.y));
    hit.setAttribute('r', String(baseR * 3.0));
    hit.setAttribute('class', 'overlay-hit');
    hit.setAttribute('pointer-events', 'visibleFill');
    hit.setAttribute('fill', '#000000');
    hit.setAttribute('fill-opacity', '0');
    g.appendChild(hit);
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(n.x));
    c.setAttribute('cy', String(n.y));
    c.setAttribute('r', String(baseR));
    let markerClass = `${n.type || 'room'} overlay-marker`;
    if (startId && n.id === startId) markerClass += ' selected-start';
    if (goalId && n.id === goalId) markerClass += ' selected-goal';
    if (isRoomsOnly) markerClass += ' rooms-only';
    c.setAttribute('class', markerClass);
    if (linkMode && linkA && linkA === n.id) c.classList.add('selected-link');
    c.setAttribute('pointer-events', 'auto');
    g.appendChild(c);
    if (label) {
      const tEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tEl.setAttribute('x', String(n.x));
      tEl.setAttribute('y', String(n.y - 40));
      tEl.setAttribute('class', 'label');
      tEl.setAttribute('text-anchor', 'middle');
      tEl.textContent = label;
      g.appendChild(tEl);
    }
  });
  const hasRoute = !!(startId && goalId);
  if (typeof startId !== 'undefined' && startId && nodes[startId]) {
    const cs = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cs.setAttribute('cx', String(nodes[startId].x));
    cs.setAttribute('cy', String(nodes[startId].y));
    cs.setAttribute('r', '10');
    cs.setAttribute('class', 'overlay-selection selected-start');
    if (hasRoute) cs.classList.add('enlarged');
    overlay.appendChild(cs);
  }
  if (typeof goalId !== 'undefined' && goalId && nodes[goalId]) {
    const cg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cg.setAttribute('cx', String(nodes[goalId].x));
    cg.setAttribute('cy', String(nodes[goalId].y));
    cg.setAttribute('r', '10');
    cg.setAttribute('class', 'overlay-selection selected-goal');
    if (hasRoute) cg.classList.add('enlarged');
    overlay.appendChild(cg);
  }
  if (overlay && overlay.parentNode === viewport) {
    try { viewport.appendChild(overlay); } catch (_) {}
  }
}
renderOverlay();

buildGraph();

initOverlayFromJsonIfEmpty();

function selectDelete(id) {
  deleteTargetId = id;
  if (btnDelete) btnDelete.classList.add('btn-primary');
  hintEl.textContent = `Выбран узел для удаления: ${getNodeLabel(nodes[id], id)}`;
}

function safeAttrSelector(id) {
  try { return CSS && typeof CSS.escape === 'function' ? CSS.escape(id) : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); } catch (_) { return String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
}
function highlightDeleteSelection(id) {
  const prev = overlay.querySelector('.selected-delete');
  if (prev) prev.classList.remove('selected-delete');
  const marker = overlay.querySelector(`[data-node="${safeAttrSelector(id)}"]`);
  const circle = marker ? marker.querySelector('circle') : null;
  if (circle) circle.classList.add('selected-delete');
}

function setOverlayHover(id) {
  if (!overlay) return;
  if (hoverOverlayId === id) return;
  if (hoverOverlayId) {
    const prev = overlay.querySelector(`[data-node="${safeAttrSelector(hoverOverlayId)}"]`);
    if (prev) prev.classList.remove('js-hover');
  }
  hoverOverlayId = id || null;
  if (id) {
    const cur = overlay.querySelector(`[data-node="${safeAttrSelector(id)}"]`);
    if (cur) cur.classList.add('js-hover');
  }
}

if (overlay) {
  overlay.addEventListener('click', (ev) => {
    if (deleteLineMode) {
      const hitLine = ev.target && ev.target.closest('[data-corr-line]');
      let id = hitLine ? hitLine.getAttribute('data-corr-line') : null;
      if (!id) {
        const nearest = nearestCorrLine(ev.clientX, ev.clientY);
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const threshold = Math.max(12, 0.02 * Math.max(bb.width, bb.height));
        if (nearest && nearest.d <= threshold) id = nearest.id;
      }
      if (id) { deleteCorrLine(id); return; }
    }
    if (deleteEdgeMode) {
      const hitEdge = ev.target && ev.target.closest('[data-edge]');
      let key = hitEdge ? hitEdge.getAttribute('data-edge') : null;
      if (!key) {
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const threshold = Math.max(18, 0.03 * Math.max(bb.width, bb.height));
        const cand = nearestOverlayEdge(ev.clientX, ev.clientY);
        if (cand && cand.d <= threshold) key = cand.key;
      }
      if (key) { deleteOverlayEdgeByKey(key); return; }
    }
    const hit = ev.target && ev.target.closest('[data-node]');
    let id = hit ? (hit.getAttribute('data-node') || hit.getAttribute('id')) : null;
    if (!id) {
      // Fallback: pick nearest overlay node within threshold
      const rect = svg.getBoundingClientRect();
      const x = ev.clientX, y = ev.clientY;
      const { wx, wy } = worldFromClient(x, y);
      let best = null, bestD = Infinity;
      overlayNodes.forEach(n => {
        const d = Math.hypot(n.x - wx, n.y - wy);
        if (d < bestD) { bestD = d; best = n.id; }
      });
      const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
      const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
      const threshold = Math.max(24, 0.05 * Math.max(bb.width, bb.height));
      if (best && bestD <= threshold) id = best;
    }
    if (!id) return;
    if (deleteMode) {
      deleteNode(id);
      return;
    }
    deleteTargetId = id;
    highlightDeleteSelection(id);
  });
  overlay.addEventListener('mousemove', (ev) => {
    // Hover highlight for deletion modes
    if (deleteLineMode) {
      overlay.querySelectorAll('.selected-delete-line').forEach(el => el.classList.remove('selected-delete-line'));
      let target = ev.target && ev.target.closest('[data-corr-line]');
      if (!target) {
        const nearest = nearestCorrLine(ev.clientX, ev.clientY);
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const threshold = Math.max(12, 0.02 * Math.max(bb.width, bb.height));
        if (nearest && nearest.d <= threshold) {
          target = overlay.querySelector(`[data-corr-line="${nearest.id}"]`);
        }
      }
      if (target) target.classList.add('selected-delete-line');
      return;
    }
    if (deleteMode) {
      const hit = ev.target && ev.target.closest('[data-node]');
      if (!hit) return;
      const id = hit.getAttribute('data-node') || hit.getAttribute('id');
      if (!id) return;
      highlightDeleteSelection(id);
    }
  }, { passive: true });
}

function addOverlayNode(p, type, name, id) {
  const t = type || 'room';
  const rawName = (name || '').trim();
  const nid = id || `N${Date.now()}`;
  let displayName = rawName;
  if (!displayName) {
    if (t === 'door') displayName = 'дверь';
    else if (t === 'exit') displayName = 'выход';
    else if (t === 'stair') displayName = 'лестница';
    else displayName = nid;
  }
  const n = { id: nid, x: Math.round(p.x), y: Math.round(p.y), type: t, name: displayName };
  overlayNodes.push(n);
  persistWrite('navOverlayNodes', overlayNodes);
  renderOverlay();
  return n.id;
}

function hasOverlayEdge(a, b) {
  return Array.isArray(overlayEdges) && overlayEdges.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}
function baseId(id) { return String(id).replace(/(?:_\d+)+$/, ''); }
function isAutoEdgeBlocked(a, b) {
  const ka = baseId(a), kb = baseId(b);
  const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  return Array.isArray(autoEdgeBlocks) && autoEdgeBlocks.includes(k);
}
function edgeScore(e) {
  const overlaySet = new Set(overlayNodes.map(n => n.id));
  let score = 0;
  if (!e.auto) score += 100; // ручная связь приоритетнее
  if (overlaySet.has(e.a)) score += 10;
  if (overlaySet.has(e.b)) score += 10;
  const A = nodes[e.a], B = nodes[e.b];
  const d = (A && B) ? Math.hypot(A.x - B.x, A.y - B.y) : Infinity;
  score += Math.max(0, 10000 - Math.round(d)); // ближе — лучше
  return score;
}
function dedupeOverlayEdges() {
  const grouped = new Map();
  overlayEdges.forEach(e => {
    const a = e.a, b = e.b;
    if (!a || !b) return;
    const ka = baseId(a), kb = baseId(b);
    const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const ex = grouped.get(k);
    if (!ex || edgeScore(e) > edgeScore(ex)) grouped.set(k, e);
  });
  overlayEdges = Array.from(grouped.values());
  persistWrite('navOverlayEdges', overlayEdges);
}
function prepareOverlayExport() {
  const used = new Set();
  const idMap = new Map();
  const cleanId = id => {
    const base = baseId(id);
    let out = base;
    let i = 2;
    while (used.has(out)) { out = `${base}-${i}`; i++; }
    used.add(out);
    idMap.set(id, out);
    return out;
  };
  const nodesOut = (overlayNodes || []).map(n => ({
    id: cleanId(n.id),
    name: n.name || baseId(n.id),
    type: n.type || 'room',
    x: n.x, y: n.y
  })).sort((a, b) => {
    const t = (a.type || '').localeCompare(b.type || '');
    if (t) return t;
    return (a.name || '').localeCompare(b.name || '');
  });
  const mapIdForExport = id => idMap.get(id) || id;
  const edgesOut = (overlayEdges || []).filter(e => !e.auto).map(e => ({
    a: mapIdForExport(e.a),
    b: mapIdForExport(e.b),
    auto: !!e.auto
  })).sort((e1, e2) => {
    const s1 = `${e1.a}|${e1.b}`, s2 = `${e2.a}|${e2.b}`;
    return s1.localeCompare(s2);
  });
  const linesOut = (overlayCorrLines || []).map(l => ({
    id: l.id,
    name: l.name || 'Коридор',
    points: (l.points || []).map(p => ({ x: p.x, y: p.y }))
  })).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  const blocksOut = Array.isArray(autoEdgeBlocks) ? [...autoEdgeBlocks] : [];
  return { nodes: nodesOut, edges: edgesOut, corridorLines: linesOut, autoEdgeBlocks: blocksOut };
}

function consolidateAutoAccessLinks() {
  if (!Array.isArray(overlayEdges)) return;
  const keep = new Map();
  const manualDoor = new Set();
  const manualExit = new Set();
  overlayEdges.forEach(e => {
    if (e.auto) return;
    const ta = nodes[e.a]?.type, tb = nodes[e.b]?.type;
    if ((ta === 'door' && tb === 'corridor')) manualDoor.add(baseId(e.a));
    else if ((ta === 'corridor' && tb === 'door')) manualDoor.add(baseId(e.b));
    else if ((ta === 'exit' && tb === 'corridor')) manualExit.add(baseId(e.a));
    else if ((ta === 'corridor' && tb === 'exit')) manualExit.add(baseId(e.b));
  });
  overlayEdges.forEach(e => {
    if (!e.auto) return;
    const ta = nodes[e.a]?.type, tb = nodes[e.b]?.type;
    let door = null, corr = null;
    if (ta === 'door' && tb === 'corridor') { door = baseId(e.a); corr = e.b; }
    else if (ta === 'corridor' && tb === 'door') { door = baseId(e.b); corr = e.a; }
    if (door) {
      if (manualDoor.has(door)) return; // есть ручная привязка — отбрасываем авто
      const k = `door|${door}`;
      const ex = keep.get(k);
      if (!ex || edgeScore(e) > edgeScore(ex)) keep.set(k, e);
      return;
    }
    let exit = null;
    if (ta === 'exit' && tb === 'corridor') { exit = baseId(e.a); corr = e.b; }
    else if (ta === 'corridor' && tb === 'exit') { exit = baseId(e.b); corr = e.a; }
    if (exit) {
      if (manualExit.has(exit)) return; // ручная привязка — отбрасываем авто
      const k = `exit|${exit}`;
      const ex = keep.get(k);
      if (!ex || edgeScore(e) > edgeScore(ex)) keep.set(k, e);
    }
  });
  overlayEdges = overlayEdges.filter(e => {
    if (!e.auto) return true;
    const ta = nodes[e.a]?.type, tb = nodes[e.b]?.type;
    let door = null, exit = null;
    if (ta === 'door' && tb === 'corridor') door = baseId(e.a);
    else if (ta === 'corridor' && tb === 'door') door = baseId(e.b);
    if (ta === 'exit' && tb === 'corridor') exit = baseId(e.a);
    else if (ta === 'corridor' && tb === 'exit') exit = baseId(e.b);
    if (door) {
      if (manualDoor.has(door)) return false; // удаляем все авто для двери с ручной связью
      const k = `door|${door}`;
      const kept = keep.get(k);
      return kept === e;
    }
    if (exit) {
      if (manualExit.has(exit)) return false;
      const k = `exit|${exit}`;
      const kept = keep.get(k);
      return kept === e;
    }
    return true;
  });
  persistWrite('navOverlayEdges', overlayEdges);
}
function addOverlayEdge(a, b, auto = false) {
  if (hasOverlayEdge(a, b)) return;
  if (auto && isAutoEdgeBlocked(a, b)) return;
  const ta = nodes[a]?.type;
  const tb = nodes[b]?.type;
  if (auto && ta === 'door' && tb === 'door') return;
  overlayEdges.push({ a, b, auto: !!auto });
  dedupeOverlayEdges();
  if (!hasEdge(a, b)) addEdgeConstrained(a, b, dist(a, b));
}

function mergeOverlayEdgesToGraph() {
  if (!Array.isArray(overlayEdges)) return;
  const seen = new Set();
  overlayEdges = overlayEdges.filter(e => {
    const a = e.a, b = e.b;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedupeOverlayEdges();
  overlayEdges.forEach(e => { if (nodes[e.a] && nodes[e.b] && !hasEdge(e.a, e.b)) addEdgeConstrained(e.a, e.b, dist(e.a, e.b)); });
}

function mergeOverlayNodesToGraph() {
  if (!Array.isArray(overlayNodes)) return;
  const used = new Set(Object.keys(nodes));
  let changed = false;
  overlayNodes.forEach(n => {
    let id = n.id;
    if (used.has(id)) {
      const oldId = id;
      const base = String(oldId).replace(/(?:_\d+)+$/, '');
      let k = 1;
      let newId = base;
      if (used.has(newId)) {
        while (used.has(`${base}_${k}`)) k++;
        newId = `${base}_${k}`;
      }
      n.id = newId;
      id = newId;
      changed = true;
      overlayEdges = overlayEdges.map(e => ({ ...e, a: e.a === oldId ? newId : e.a, b: e.b === oldId ? newId : e.b }));
    }
    used.add(id);
    if (!nodes[id]) nodes[id] = { x: n.x, y: n.y, floor: '1', type: n.type || 'room', name: n.name || id };
    if (!adj[id]) adj[id] = [];
  });
  if (changed) {
    persistWrite('navOverlayNodes', overlayNodes);
    persistWrite('navOverlayEdges', overlayEdges);
    renderOverlay();
  }
}

function hasEdge(a, b) {
  return !!(adj[a] && adj[a].some(e => e.to === b));
}

function ensureBasicConnectivity() {
  const ids = Object.keys(nodes).filter(id => nodes[id].type !== 'anchor');
  if (ids.length < 2) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const nearThresh = Math.max(36, 0.07 * Math.max(bb.width, bb.height));
  const k = 2;
  ids.forEach(a => {
    const candidates = ids.filter(b => b !== a).map(b => ({ b, d: dist(a, b) })).sort((x, y) => x.d - y.d);
    let linked = 0;
    for (let i = 0; i < candidates.length && linked < k; i++) {
      const { b, d } = candidates[i];
      if (hasEdge(a, b)) continue;
      if (d <= nearThresh || (!(adj[a] && adj[a].length))) {
        addEdge(a, b, d);
        linked++;
      }
    }
  });
}

function deleteNode(id) {
  const marker = overlay.querySelector(`[data-node="${safeAttrSelector(id)}"]`);
  if (marker) marker.remove();
  overlayNodes = overlayNodes.filter(n => n.id !== id);
  overlayEdges = overlayEdges.filter(ed => ed.a !== id && ed.b !== id);
  persistWrite('navOverlayNodes', overlayNodes);
  persistWrite('navOverlayEdges', overlayEdges);
  if (startId === id) startId = null;
  if (goalId === id) goalId = null;
  renderOverlay();
  updateSelection();
  updateLabels();
  draw([]);
  stepsEl.textContent = 'Узел удалён';
  buildGraph();
}

function deleteCorrLine(id) {
  overlayCorrLines = overlayCorrLines.filter(l => l.id !== id);
  persistWrite('navOverlayCorrLines', overlayCorrLines);
  renderOverlay();
  stepsEl.textContent = 'Линия удалена';
  buildGraph();
}

function clampPan() {
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = getContentBBox();
  let m = panMargin;
  if (isMobile() && scale > 1) {
    const baseDim = Math.max(vb.width, vb.height);
    m = Math.max(panMargin, 0.15 * baseDim);
  }
  const scaledW = scale * bb.width;
  const scaledH = scale * bb.height;
  if (scaledW + 2 * m <= vb.width) {
    offsetX = vb.x + (vb.width - scaledW) / 2 - scale * bb.x;
  } else {
    const minOffsetX = (vb.x + vb.width - m) - scale * (bb.x + bb.width);
    const maxOffsetX = (vb.x + m) - scale * bb.x;
    offsetX = Math.max(minOffsetX, Math.min(offsetX, maxOffsetX));
  }
  if (scaledH + 2 * m <= vb.height) {
    offsetY = vb.y + (vb.height - scaledH) / 2 - scale * bb.y;
  } else {
    const minOffsetY = (vb.y + vb.height - m) - scale * (bb.y + bb.height);
    const maxOffsetY = (vb.y + m) - scale * bb.y;
    offsetY = Math.max(minOffsetY, Math.min(offsetY, maxOffsetY));
  }
}
function applyTransform() {
  viewport.setAttribute('transform', `matrix(${scale} 0 0 ${scale} ${offsetX} ${offsetY})`);
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(v, b));
}

function userFromClient(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const s = Math.min(rect.width / vb.width, rect.height / vb.height);
  const ox = (rect.width - vb.width * s) / 2;
  const oy = (rect.height - vb.height * s) / 2;
  return { ux: vb.x + (clientX - rect.left - ox) / s, uy: vb.y + (clientY - rect.top - oy) / s };
}

function worldFromClient(clientX, clientY) {
  const m = viewport.getScreenCTM ? viewport.getScreenCTM() : null;
  const pt = svg.createSVGPoint ? svg.createSVGPoint() : null;
  if (pt && m && typeof m.inverse === 'function') {
    pt.x = clientX; pt.y = clientY;
    const p = pt.matrixTransform(m.inverse());
    return { wx: p.x, wy: p.y };
  }
  const { ux, uy } = userFromClient(clientX, clientY);
  return { wx: (ux - offsetX) / scale, wy: (uy - offsetY) / scale };
}

svg.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAnchorX = e.clientX; zoomAnchorY = e.clientY;
  const { ux, uy } = userFromClient(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.05 : 0.95;
  let newScale = clamp(scale * factor, minScale, maxScale);
  newScale = snapScale(newScale);
  const { wx, wy } = worldFromClient(e.clientX, e.clientY);
  offsetX = ux - newScale * wx;
  offsetY = uy - newScale * wy;
  scale = newScale;
  clampPan();
  applyTransform();
  if (zoomSlider) zoomSlider.value = String(scale);
}, { passive: false});

let p1 = null, dragging = false;
let dragWorldX = 0, dragWorldY = 0;
let dragStarted = false;
let pointerCaptured = false;
const dragThreshold = 10;
let zoomAnchorX = null, zoomAnchorY = null;
svg.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
  if (e.button !== 0) return;
  p1 = { id: e.pointerId, x: e.clientX, y: e.clientY };
  dragging = true;
  dragStarted = false;
  startDownX = e.clientX; startDownY = e.clientY; wasDragging = false;
  const { ux, uy } = userFromClient(e.clientX, e.clientY);
  const { wx, wy } = worldFromClient(e.clientX, e.clientY);
  dragWorldX = wx;
  dragWorldY = wy;
  try { svg.setPointerCapture(e.pointerId); } catch (_) {}
}, { passive: true });
svg.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
  if (!dragging || !p1 || e.pointerId !== p1.id) return;
  p1.x = e.clientX; p1.y = e.clientY;
  zoomAnchorX = e.clientX; zoomAnchorY = e.clientY;
  const moved = Math.hypot(e.clientX - startDownX, e.clientY - startDownY) > dragThreshold;
  if (!dragStarted && !moved) return;
  if (!dragStarted && moved) {
    dragStarted = true;
    if (!pointerCaptured) {
      try { svg.setPointerCapture(e.pointerId); pointerCaptured = true; } catch (_) {}
    }
  }
  if (dragStarted) e.preventDefault();
  const { ux, uy } = userFromClient(e.clientX, e.clientY);
  offsetX = ux - scale * dragWorldX;
  offsetY = uy - scale * dragWorldY;
  clampPan();
  applyTransform();
  wasDragging = true;
}, { passive: false });
svg.addEventListener('pointerup', e => {
  if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
  if (!p1 || e.pointerId !== p1.id) return;
  if (pointerCaptured) {
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    pointerCaptured = false;
  }
  if (wasDragging) {
    const movedDist = Math.hypot(e.clientX - startDownX, e.clientY - startDownY);
    if (movedDist > dragThreshold) suppressClickOnce = true;
    wasDragging = false;
  }
  p1 = null; dragging = false;
  dragStarted = false;
}, { passive: true });
svg.addEventListener('pointercancel', e => {
  p1 = null;
  dragging = false;
  dragStarted = false;
  if (pointerCaptured) { try { svg.releasePointerCapture(e.pointerId); } catch (_) {} pointerCaptured = false; }
}, { passive: true});
applyTransform();
clampPan();
applyTransform();

function setNavMode(mode) {
  document.body.classList.toggle('mode-3d', mode === '3d');
  document.body.classList.toggle('mode-2d', mode === '2d');
  if (tab2dBtn) tab2dBtn.classList.toggle('active', mode === '2d');
  if (tab3dBtn) tab3dBtn.classList.toggle('active', mode === '3d');
  try { localStorage.setItem('navMode', mode); } catch (_) {}
}

const savedNavMode = (() => { try { return localStorage.getItem('navMode'); } catch (_) { return null; } })();
const urlModeParam = (() => { try { const p = new URLSearchParams(location.search); return p.get('mode'); } catch (_) { return null; } })();
setNavMode(urlModeParam === '3d' ? '3d' : (savedNavMode === '3d' ? '3d' : '2d'));
if (tabsEl) {
  tabsEl.addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const mode = btn.dataset.tab;
    setNavMode(mode);
    if (mode === '3d') { try { toggleMenu(false); } catch (_) {} }
  });
}

mode = 'start';
startId = null;
goalId = null;

whereBtn.onclick = () => { 
  setMode('start'); 
  whereBtn.classList.add('btn-danger');
  whereBtn.classList.remove('btn-primary');
  toggleMenu(false); 
};
document.getElementById('clear').onclick = clearAll;
function toggleMenu(open) {
  document.body.classList.toggle('menu-open', open);
  uiPanel.classList.toggle('open', open);
  uiPanel.classList.toggle('peek', !open && isMobile());
  if (scrim) {
    const scrimOpen = open || (markupPanel && markupPanel.classList.contains('open'));
    scrim.classList.toggle('open', scrimOpen);
  }
  if (open) adjustPanelHeight();
  if (menuToggle) {
    if (!isMobile()) {
      menuToggle.textContent = open ? 'Закрыть' : 'Меню';
      positionMenuButton();
      trackPanelDuringTransition();
    }
  }
  if (open) {
    // ATTENTION PERSISTENCE: use sessionStorage so hints reappear after reload; switch to localStorage for persistence across sessions
    try { sessionStorage.setItem('uiAttentionCaptured', '1');} catch (_) {}
  }
}

function toggleMarkupMenu(open) {
  if (!markupPanel) return;
  markupPanel.classList.toggle('open', open);
  if (scrim) {
    const scrimOpen = open || uiPanel.classList.contains('open');
    scrim.classList.toggle('open', scrimOpen);
  }
}

const mq = window.matchMedia('(max-width: 768px)');
function isMobile() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 768px)').matches;
  } catch (_) {
    return false;
  }
}
[ 'gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
  window.addEventListener(ev, e => e.preventDefault(), { passive: false });
});


if (menuToggle) {
  const handler = () => {
    const open = !uiPanel.classList.contains('open');
    toggleMenu(open);
  };
  menuToggle.addEventListener('click', handler);
  menuToggle.addEventListener('touchstart', handler, { passive: true });
}
if (markupPanel) {
  const handleMarkupToggle = () => {
    const open = !markupPanel.classList.contains('open');
    if (open && uiPanel && uiPanel.classList.contains('open')) toggleMenu(false);
    toggleMarkupMenu(open);
  };
  if (markupMenuToggle) {
    markupMenuToggle.addEventListener('click', handleMarkupToggle);
    markupMenuToggle.addEventListener('touchstart', handleMarkupToggle, { passive: true });
  }
  if (markupMenuToggleMobile) {
    markupMenuToggleMobile.addEventListener('click', handleMarkupToggle);
    markupMenuToggleMobile.addEventListener('touchstart', handleMarkupToggle, { passive: true });
  }
}
if (scrim) {
  scrim.addEventListener('click', () => {
    toggleMenu(false);
    toggleMarkupMenu(false);
  });
}

function updateSheetMode() {
  toggleMenu(false);
}
updateSheetMode();
mq.addEventListener('change', updateSheetMode);
window.addEventListener('resize', updateSheetMode);
window.addEventListener('resize', () => positionMenuButton());
document.addEventListener('DOMContentLoaded', () => {
  positionMenuButton();
  if (window.Telegram && window.Telegram.WebApp) {
    try { window.Telegram.WebApp.ready(); } catch (_) {}
    try { window.Telegram.WebApp.expand(); } catch (_) {}
    try { window.Telegram.WebApp.enableClosingConfirmation(); } catch (_) {}
  }
  fitSvgToContent(32);
  let cap = false;
  try {
    cap = sessionStorage.getItem('uiAttentionCaptured') === '1';
  } catch (_) {}
  const getCurrentTranslateY = () => {
    try {
      const m = getComputedStyle(uiPanel).transform;
      if (m && m !== 'none') {
        const parts = m.match(/matrix\(([^)]+)\)/);
        if (parts) {
          const vals = parts[1].split(',');
          const ty = parseFloat(vals[5]);
          return isNaN(ty) ? 0 : ty;
        }
      }
    } catch (_) {}
    return 0;
  };
  const scheduleAttention = () => {
    if (!isMobile() || uiPanel.classList.contains('open')) return;
    const tip = document.getElementById('menu-tip-global');
    const bouncePanel = withTip => {
      const onEnd = () => { uiPanel.classList.remove('attention'); uiPanel.removeEventListener('animationend', onEnd); };
      uiPanel.addEventListener('animationend', onEnd, { once: true });
      uiPanel.classList.add('attention');
      if (withTip && tip) {
        const r = uiPanel.getBoundingClientRect();
        tip.style.left = `${Math.round(r.left + r.width/2)}px`;
        tip.style.top = `${Math.max(0, r.top - 32)}px`;
        tip.classList.add('show');
        setTimeout(() => tip.classList.remove('show'), 3000);
      }
    };
    setTimeout(() => {
      if (!cap && !uiPanel.classList.contains('open')) bouncePanel(false);
      setTimeout(() => {
        if (!cap && !uiPanel.classList.contains('open')) bouncePanel(true);
      }, 5000);
    }, 3000);
  };
  const trigger = () => scheduleAttention();
  if (document.visibilityState === 'visible') trigger();
  else document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trigger(); }, { once: true });
  window.addEventListener('pageshow', trigger, { once: true });
  if (btnMark) {
    btnMark.addEventListener('click', () => {
      markMode = !markMode;
      if (markMode) { linkMode = false; linkA = null; btnMark.classList.add('btn-primary'); btnLink.classList.remove('btn-primary'); hintEl.textContent = 'Разметка: кликните по карте для добавления узла'; }
      else { btnMark.classList.remove('btn-primary'); hintEl.textContent = 'Режим разметки выключен'; }
    });
  }
  if (btnLink) {
    btnLink.addEventListener('click', () => {
      linkMode = !linkMode;
      if (linkMode) { markMode = false; btnLink.classList.add('btn-primary'); btnMark.classList.remove('btn-primary'); linkA = null; hintEl.textContent = 'Режим связи: выберите два узла'; renderOverlay(); }
      else { btnLink.classList.remove('btn-primary'); linkA = null; hintEl.textContent = 'Режим связи выключен'; renderOverlay(); }
    });
  }
  if (btnCorrLine) {
    btnCorrLine.addEventListener('click', () => {
      corrLineMode = !corrLineMode;
      if (corrLineMode) { markMode = false; linkMode = false; btnCorrLine.classList.add('btn-primary'); btnLink.classList.remove('btn-primary'); btnMark.classList.remove('btn-primary'); currentCorrLineId = currentCorrLineId || `CL${Date.now()}`; hintEl.textContent = 'Линия коридора: кликните по траектории'; }
      else { btnCorrLine.classList.remove('btn-primary'); hintEl.textContent = 'Режим линии коридора выключен'; }
    });
  }
  if (btnCorrFinish) {
    btnCorrFinish.addEventListener('click', () => {
      if (!currentCorrLineId) return;
      currentCorrLineId = null;
      corrLineMode = false;
      btnCorrLine.classList.remove('btn-primary');
      hintEl.textContent = 'Линия завершена';
    });
  }
  if (btnDeleteLine) {
    btnDeleteLine.addEventListener('click', () => {
      deleteLineMode = !deleteLineMode;
      btnDeleteLine.classList.toggle('btn-primary', deleteLineMode);
      hintEl.textContent = deleteLineMode ? 'Удаление линий: кликните по линии, чтобы удалить' : 'Режим удаления линий выключен';
      renderOverlay();
    });
  }
  if (btnDeleteEdge) {
    btnDeleteEdge.addEventListener('click', () => {
      deleteEdgeMode = !deleteEdgeMode;
      btnDeleteEdge.classList.toggle('btn-primary', deleteEdgeMode);
      hintEl.textContent = deleteEdgeMode ? 'Удаление связей: кликните по линии связи, чтобы удалить' : 'Режим удаления связей выключен';
      renderOverlay();
    });
  }
  if (btnDelete) {
    const bindDelete = () => {
      if (btnDelete.dataset.deleteBound === '1') return;
      btnDelete.dataset.deleteBound = '1';
      btnDelete.addEventListener('click', () => {
        // Toggle delete mode; if there is a selected node and not in mode, delete immediately
        if (deleteTargetId && !deleteMode) {
          deleteNode(deleteTargetId);
          deleteTargetId = null;
          btnDelete.classList.remove('btn-primary');
          return;
        }
        deleteMode = !deleteMode;
        btnDelete.classList.toggle('btn-danger', deleteMode);
        hintEl.textContent = deleteMode ? 'Удаление узлов: кликните по маркеру, чтобы удалить' : 'Режим удаления узлов выключен';
      });
    };
    bindDelete();
  }
  if (btnEditNode && editNodeModal && editNodeNameInput && editNodeIdInput && editNodeTypeSelect && editNodeSaveBtn && editNodeCancelBtn) {
    const openEditModal = () => {
      let id = deleteTargetId || hoverOverlayId;
      if (!id) {
        stepsEl.textContent = 'Сначала выберите узел на карте';
        return;
      }
      let node = overlayNodes.find(n => n.id === id);
      if (!node && nodes[id]) {
        const base = nodes[id];
        node = {
          id,
          x: base.x,
          y: base.y,
          type: base.type || 'room',
          name: base.name || id
        };
        overlayNodes.push(node);
        persistWrite('navOverlayNodes', overlayNodes);
        renderOverlay();
      }
      if (!node) {
        stepsEl.textContent = 'Узел не найден для редактирования';
        return;
      }
      deleteTargetId = node.id;
      highlightDeleteSelection(node.id);
      editNodeNameInput.value = node.name || '';
      editNodeIdInput.value = node.id || '';
      editNodeTypeSelect.value = node.type || 'room';
      editNodeModal.classList.add('open');
    };
    const closeEditModal = () => {
      editNodeModal.classList.remove('open');
    };
    btnEditNode.addEventListener('click', () => {
      openEditModal();
    });
    editNodeCancelBtn.addEventListener('click', () => {
      closeEditModal();
    });
    editNodeModal.addEventListener('click', e => {
      if (e.target === editNodeModal) closeEditModal();
    });
    editNodeSaveBtn.addEventListener('click', () => {
      if (!deleteTargetId) {
        closeEditModal();
        return;
      }
      const oldId = deleteTargetId;
      const idx = overlayNodes.findIndex(n => n.id === oldId);
      if (idx === -1) {
        closeEditModal();
        return;
      }
      const node = overlayNodes[idx];
      const name = editNodeNameInput.value.trim();
      let newId = editNodeIdInput.value.trim();
      const type = editNodeTypeSelect.value || 'room';
      if (!newId) newId = oldId;
      if (newId !== oldId) {
        const exists = overlayNodes.some((n, i) => i !== idx && n.id === newId);
        if (exists || (nodes[newId] && newId !== oldId)) {
          stepsEl.textContent = 'Узел с таким ID уже существует';
          return;
        }
        overlayEdges = overlayEdges.map(e => ({
          ...e,
          a: e.a === oldId ? newId : e.a,
          b: e.b === oldId ? newId : e.b
        }));
        node.id = newId;
        deleteTargetId = newId;
      }
      if (name) node.name = name;
      node.type = type;
      persistWrite('navOverlayNodes', overlayNodes);
      persistWrite('navOverlayEdges', overlayEdges);
      renderOverlay();
      buildGraph();
      updateLabels();
      refreshDatalist();
      compute();
      if (deleteTargetId) highlightDeleteSelection(deleteTargetId);
      if (markNameEl) markNameEl.value = node.name || '';
      if (markIdEl) markIdEl.value = node.id || '';
      if (markTypeEl) markTypeEl.value = node.type || 'room';
      stepsEl.textContent = 'Узел обновлён';
      closeEditModal();
    });
  }
  if (btnExport) {
    btnExport.addEventListener('click', async () => {
      const data = prepareOverlayExport();
      const text = JSON.stringify(data, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nav_overlay.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
      let ok = false; try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
      stepsEl.textContent = ok ? 'Разметка экспортирована: файл скачан, данные скопированы' : 'Разметка экспортирована: файл скачан';
    });
  }
  if (btnImport && importFile) {
    btnImport.addEventListener('click', () => { importFile.click(); });
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      let text = '';
      try { text = await file.text(); } catch (_) { stepsEl.textContent = 'Ошибка чтения файла'; return; }
      let data = null;
      try { data = JSON.parse(text); } catch (_) { stepsEl.textContent = 'Ошибка: файл не JSON'; importFile.value = ''; return; }
      overlayNodes = Array.isArray(data.nodes) ? data.nodes : [];
      overlayEdges = Array.isArray(data.edges) ? data.edges.filter(e => !e.auto) : [];
      overlayCorrLines = Array.isArray(data.corridorLines) ? data.corridorLines : [];
      if (Array.isArray(data.autoEdgeBlocks)) {
        autoEdgeBlocks = data.autoEdgeBlocks.slice();
        persistWrite('navAutoEdgeBlocks', autoEdgeBlocks);
      }
      persistWrite('navOverlayNodes', overlayNodes);
      persistWrite('navOverlayEdges', overlayEdges);
      persistWrite('navOverlayCorrLines', overlayCorrLines);
      renderOverlay();
      buildGraph();
      stepsEl.textContent = 'Разметка импортирована';
      importFile.value = '';
    });
  }
  if (btnClearMark) {
    btnClearMark.addEventListener('click', () => {
      overlayNodes = []; overlayEdges = []; persistWrite('navOverlayNodes', overlayNodes); persistWrite('navOverlayEdges', overlayEdges); renderOverlay(); buildGraph(); stepsEl.textContent = 'Разметка очищена';
    });
  }
  if (btnHideNonRooms) {
    const applyVisibilityState = () => {
      btnHideNonRooms.textContent = onlyRoomsMode ? 'Показать разметку' : 'Скрыть разметку';
    };
    applyVisibilityState();
    btnHideNonRooms.addEventListener('click', () => {
      onlyRoomsMode = !onlyRoomsMode;
      persistWrite('onlyRoomsMode', onlyRoomsMode);
      renderOverlay();
      stepsEl.textContent = onlyRoomsMode ? 'Режим: только аудитории' : 'Режим: все элементы';
      applyVisibilityState();
    });
  }
  if (btnDebugToggle) {
    const applyDebugState = () => {
      btnDebugToggle.classList.toggle('btn-primary', DEBUG_NAV);
      btnDebugToggle.textContent = DEBUG_NAV ? 'Выключить отладку' : 'Включить отладку';
    };
    applyDebugState();
    btnDebugToggle.addEventListener('click', () => {
      DEBUG_NAV = !DEBUG_NAV;
      persistWrite('navDebugMode', DEBUG_NAV);
      applyDebugState();
    });
  }
});

// Mobile gestures: interactive grab to open/close on the grabber, with visual feedback
function getHeaderHeight() {
  const header = document.querySelector('.sheet-header');
  return header ? header.offsetHeight : 56;
}
function getPeekTranslateY() {
  const h = uiPanel.offsetHeight;
  const headerH = getHeaderHeight();
  return Math.max(0, h - headerH);
}
function setPanelTranslate(px) {
  const y = Math.max(0, Math.min(px, getPeekTranslateY()));
  uiPanel.style.transform = `translateY(${y}px)`;
}
let dragOpenActive = false;
let dragOpenStartY = null;
let dragCloseActive = false;
let dragCloseStartY = null;

document.addEventListener('touchstart', e => {
  if (!isMobile() || uiPanel.classList.contains('open')) return;
  const t = e.target;
  if (!(t && t.closest('.grabber, .drag-zone, .sheet-header'))) return;
  dragOpenActive = true;
  dragOpenStartY = e.touches[0].clientY;
  uiPanel.classList.add('dragging');
  const g = document.querySelector('.grabber'); if (g) g.classList.add('active');
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!dragOpenActive || !isMobile() || uiPanel.classList.contains('open')) return;
  const dy = dragOpenStartY - e.touches[0].clientY;
  const base = getPeekTranslateY();
  e.preventDefault();
  setPanelTranslate(base - dy);
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!dragOpenActive) return;
  const m = uiPanel.style.transform.match(/translateY\(([-\d.]+)px\)/);
  const y = m ? parseFloat(m[1]) : getPeekTranslateY();
  const shouldOpen = y < getPeekTranslateY() - 40;
  uiPanel.classList.remove('dragging');
  const g = document.querySelector('.grabber'); if (g) g.classList.remove('active');
  dragOpenActive = false; dragOpenStartY = null;
  uiPanel.style.transform = '';
  toggleMenu(shouldOpen);
}, { passive: true });

uiPanel.addEventListener('touchstart', e => {
  if (!isMobile() || !uiPanel.classList.contains('open')) return;
  if (!(e.target && e.target.closest('.grabber, .drag-zone, .sheet-header'))) return;
  if (uiPanel.scrollTop > 0) return;
  e.preventDefault();
  dragCloseActive = true;
  dragCloseStartY = e.touches[0].clientY;
  uiPanel.classList.add('dragging');
  const g = document.querySelector('.grabber'); if (g) g.classList.add('active');
}, { passive: false });
uiPanel.addEventListener('touchmove', e => {
  if (!dragCloseActive) return;
  const dy = e.touches[0].clientY - dragCloseStartY;
  e.preventDefault();
  setPanelTranslate(dy);
}, { passive: false });
uiPanel.addEventListener('touchend', () => {
  if (!dragCloseActive) return;
  const m = uiPanel.style.transform.match(/translateY\(([-\d.]+)px\)/);
  const y = m ? parseFloat(m[1]) : 0;
  const shouldClose = y > 40;
  uiPanel.classList.remove('dragging');
  const g = document.querySelector('.grabber'); if (g) g.classList.remove('active');
  dragCloseActive = false; dragCloseStartY = null;
  uiPanel.style.transform = '';
  toggleMenu(!shouldClose);
  if (shouldClose) toggleMenu(false);
}, { passive: true });
function positionMenuButton() {
  if (!menuToggle) return;
  if (isMobile()) return;
  const rect = uiPanel.getBoundingClientRect();
  const spacing = 12;
  const btnRect = menuToggle.getBoundingClientRect();
  let left = rect.right + spacing;
  const maxLeft = window.innerWidth - btnRect.width - spacing;
  const minLeft = spacing;
  left = Math.max(minLeft, Math.min(left, maxLeft));
  let top = rect.top;
  const maxTop = window.innerHeight - btnRect.height - spacing;
  const minTop = spacing;
  top = Math.max(minTop, Math.min(top, maxTop));
  menuToggle.style.left = `${left}px`;
  menuToggle.style.top = `${top}px`;
  menuToggle.style.bottom = '';
  menuToggle.style.transform = 'none';
}

function trackPanelDuringTransition() {
  let start = performance.now();
  function step(now) {
    positionMenuButton();
    if (now - start < 350) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
 

function adjustPanelHeight() {
  if (!isMobile()) { uiPanel.style.height = ''; return; }
  const vv = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const min = Math.round(vv * 0.40);
  const max = Math.round(vv - 24);
  uiPanel.style.height = 'auto';
  requestAnimationFrame(() => {
    const h = uiPanel.scrollHeight;
    const clamped = Math.max(min, Math.min(h, max));
    uiPanel.style.height = `${clamped}px`;
  });
}
const ro = new ResizeObserver(() => adjustPanelHeight());
[uiPanel, turnsEl, stepsEl].forEach(el => { if (el) ro.observe(el); });

if (startInput) {
  const applyStartValue = () => {
    const v = startInput.value.trim();
    if (!v) return;
    setByValue('start', v);
  };
  startInput.addEventListener('change', applyStartValue);
  startInput.addEventListener('input', () => {
    filterNodeDropdownForInput(startInput);
  });
}

if (goalInput) {
  const applyGoalValue = () => {
    const v = goalInput.value.trim();
    if (!v) return;
    setByValue('goal', v);
  };
  goalInput.addEventListener('change', applyGoalValue);
  goalInput.addEventListener('input', () => {
    filterNodeDropdownForInput(goalInput);
  });
}

if (startArrow && startInput) {
  startArrow.addEventListener('click', e => {
    e.stopPropagation();
    if (dropdownActiveInput === startInput && nodeDropdown.style.display === 'block') {
      closeNodeDropdown();
    } else {
      openNodeDropdown(startInput);
    }
  });
}

if (goalArrow && goalInput) {
  goalArrow.addEventListener('click', e => {
    e.stopPropagation();
    if (dropdownActiveInput === goalInput && nodeDropdown.style.display === 'block') {
      closeNodeDropdown();
    } else {
      openNodeDropdown(goalInput);
    }
  });
}

document.addEventListener('click', e => {
  if (!nodeDropdown.contains(e.target)) {
    closeNodeDropdown();
  }
});


svg.addEventListener('click', e => {
  if (startInput) startInput.blur();
  if (goalInput) goalInput.blur();
  closeNodeDropdown();
  if (suppressClickOnce) { suppressClickOnce = false; return; }
  if (Date.now() <= (typeof suppressTapUntil !== 'undefined' ? suppressTapUntil : 0)) return;
  if (deleteLineMode) {
    const nearest = nearestCorrLine(e.clientX, e.clientY);
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
    const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
    const threshold = Math.max(16, 0.03 * Math.max(bb.width, bb.height));
    if (nearest && nearest.d <= threshold) { deleteCorrLine(nearest.id); return; }
  }
  if (deleteEdgeMode) {
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
    const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
    const threshold = Math.max(28, 0.05 * Math.max(bb.width, bb.height));
    const cand = nearestOverlayEdge(e.clientX, e.clientY);
    if (cand && cand.d <= threshold) { deleteOverlayEdgeByKey(cand.key); return; }
  }
  if (deleteMode) {
    let id = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hit = el ? el.closest('#overlay [data-node]') : null;
    if (hit) id = hit.getAttribute('data-node') || hit.getAttribute('id');
    if (!id) {
      const { wx, wy } = worldFromClient(e.clientX, e.clientY);
      let best = null, bestD = Infinity;
      overlayNodes.forEach(n => {
        const d = Math.hypot(n.x - wx, n.y - wy);
        if (d < bestD) { bestD = d; best = n.id; }
      });
      const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
      const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
      const threshold = Math.max(22, 0.035 * Math.max(bb.width, bb.height));
      if (best && bestD <= threshold) id = best;
    }
    if (id) { deleteNode(id); return; }
  }
  if (markMode) {
    const { wx, wy } = worldFromClient(e.clientX, e.clientY);
    const name = markNameEl ? markNameEl.value.trim() : '';
    const type = markTypeEl ? (markTypeEl.value || 'room') : 'room';
    const idRaw = markIdEl ? markIdEl.value.trim() : '';
    const nid = addOverlayNode({ x: wx, y: wy }, type, name, idRaw);
    const auto = markAutoEl ? !!markAutoEl.checked : true;
    if (auto && type === 'door') {
      const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
      const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
      const corridors = Object.keys(nodes).filter(nid2 => nodes[nid2].type === 'corridor');
      let best = null, bestD = Infinity;
      for (const cid of corridors) { const d = dist(nid, cid); if (d < bestD) { bestD = d; best = cid; } }
      if (best) addOverlayEdge(nid, best, true);
    } else if (auto && type === 'room') {
      const doors = Object.keys(nodes).filter(nid2 => nodes[nid2].type === 'door');
      if (doors.length) {
        let best = null, bestD = Infinity;
        for (const did of doors) { const d = dist(nid, did); if (d < bestD) { bestD = d; best = did; } }
        if (best) addOverlayEdge(nid, best, true);
      }
    }
    buildGraph();
    return;
  }
  if (corrLineMode) {
    const { wx, wy } = worldFromClient(e.clientX, e.clientY);
    const id = currentCorrLineId || `CL${Date.now()}`;
    let line = overlayCorrLines.find(l => l.id === id);
    if (!line) { line = { id, points: [] }; overlayCorrLines.push(line); currentCorrLineId = id; }
    line.points.push({ x: Math.round(wx), y: Math.round(wy) });
    persistWrite('navOverlayCorrLines', overlayCorrLines);
    renderOverlay();
    buildGraph();
    hintEl.textContent = `Точек в линии: ${line.points.length}`;
    return;
  }
  if (linkMode) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hit = el ? el.closest('[data-node], .room[id], .corridor[id], .exit[id], .door[id], .anchor[id]') : null;
    let id = hit ? (hit.getAttribute('data-node') || hit.getAttribute('id')) : null;
    if (!linkA) {
      if (!id || !nodes[id]) {
        const { wx, wy } = worldFromClient(e.clientX, e.clientY);
        let bestDoor = null, bestD = Infinity;
        Object.keys(nodes).forEach(nid => {
          if (nodes[nid].type !== 'door') return;
          const dx = nodes[nid].x - wx, dy = nodes[nid].y - wy;
          const d = Math.hypot(dx, dy);
          if (d < bestD) { bestD = d; bestDoor = nid; }
        });
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const threshold = Math.max(40, 0.06 * Math.max(bb.width, bb.height));
        if (bestDoor && bestD <= threshold) id = bestDoor; else return;
      }
      linkA = id; hintEl.textContent = 'Выберите второй узел для связи'; renderOverlay();
    } else {
      if (!id || !nodes[id]) {
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const threshold = Math.max(32, 0.06 * Math.max(bb.width, bb.height));
        let added = false;
        const nearest = nearestCorrLine(e.clientX, e.clientY);
        if (nearest && nearest.d <= threshold) {
          const typeA = getNodeTypeSafe(linkA);
          const segA = `${nearest.id}_${nearest.i}`;
          const segB = `${nearest.id}_${nearest.i + 1}`;
          const segCandidates = [segA, segB].filter(id2 => nodes[id2]);
          if (typeA === 'door') {
            if (segCandidates.length) {
              let target = segCandidates[0];
              if (segCandidates.length === 2) {
                const d1 = dist(linkA, segA);
                const d2 = dist(linkA, segB);
                target = d1 <= d2 ? segA : segB;
              }
              addOverlayEdge(linkA, target, false);
              added = true;
            }
          } else if (typeA === 'exit') {
            if (segCandidates.length) {
              let target = segCandidates[0];
              if (segCandidates.length === 2) {
                const d1 = dist(linkA, segA);
                const d2 = dist(linkA, segB);
                target = d1 <= d2 ? segA : segB;
              }
              addOverlayEdge(linkA, target, false);
              added = true;
            }
          } else if (typeA === 'room') {
            const room = linkA;
            const roomPos = getNodeCoordsSafe(room);
            const doors = Object.keys(nodes).filter(id2 => nodes[id2].type === 'door');
            let bestDoor = null, bestD = Infinity;
            if (roomPos && doors.length) {
              doors.forEach(did => {
                const dNode = getNodeCoordsSafe(did);
                if (!dNode) return;
                const dx = dNode.x - roomPos.x;
                const dy = dNode.y - roomPos.y;
                const d = Math.hypot(dx, dy);
                if (d < bestD) { bestD = d; bestDoor = did; }
              });
            }
            if (bestDoor) {
              addOverlayEdge(room, bestDoor, false);
              if (segCandidates.length) {
                let target = segCandidates[0];
                if (segCandidates.length === 2) {
                  const d1 = dist(bestDoor, segA);
                  const d2 = dist(bestDoor, segB);
                  target = d1 <= d2 ? segA : segB;
                }
                addOverlayEdge(bestDoor, target, false);
                added = true;
              }
            }
          } else {
            const srcPos = getNodeCoordsSafe(linkA);
            const doors = Object.keys(nodes).filter(id2 => nodes[id2].type === 'door');
            let bestDoor = null, bestD = Infinity;
            if (srcPos && doors.length) {
              doors.forEach(did => {
                const dNode = getNodeCoordsSafe(did);
                if (!dNode) return;
                const dx = dNode.x - srcPos.x;
                const dy = dNode.y - srcPos.y;
                const d = Math.hypot(dx, dy);
                if (d < bestD) { bestD = d; bestDoor = did; } 
              });
            }
            if (bestDoor) {
              if (segCandidates.length) {
                let target = segCandidates[0];
                if (segCandidates.length === 2) {
                  const d1 = dist(bestDoor, segA);
                  const d2 = dist(bestDoor, segB);
                  target = d1 <= d2 ? segA : segB;
                }
                addOverlayEdge(bestDoor, target, false);
                added = true;
                linkA = bestDoor;
              }
            }
          }
        }
        if (added) { linkA = null; hintEl.textContent = 'Связь добавлена'; renderOverlay(); buildGraph(); return; }
        return;
      }
      addOverlayEdge(linkA, id);
      linkA = null; hintEl.textContent = 'Связь добавлена'; renderOverlay(); buildGraph();
    }
    return;
  }
  handleTapSelect(e.clientX, e.clientY);
});

svg.addEventListener('mousemove', e => {
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const delThreshold = Math.max(16, 0.03 * Math.max(bb.width, bb.height));
  const linkThreshold = Math.max(32, 0.06 * Math.max(bb.width, bb.height));
  overlay.querySelectorAll('.selected-delete-line').forEach(el => el.classList.remove('selected-delete-line'));
  overlay.querySelectorAll('.selected-delete-edge').forEach(el => el.classList.remove('selected-delete-edge'));
  overlay.querySelectorAll('.corridor-line.highlight').forEach(el => el.classList.remove('highlight'));
  if (linkHighlightSeg && linkHighlightSeg.parentNode) { try { linkHighlightSeg.remove(); } catch (_) {} linkHighlightSeg = null; }
  const nearest = nearestCorrLine(e.clientX, e.clientY);
  if (nearest) {
    if (deleteLineMode && nearest.d <= delThreshold) {
      const el = overlay.querySelector(`[data-corr-line="${nearest.id}"]`);
      if (el) el.classList.add('selected-delete-line');
    }
    if (deleteEdgeMode) {
      const cand = nearestOverlayEdge(e.clientX, e.clientY);
      const t = Math.max(18, 0.03 * Math.max(bb.width, bb.height));
      if (cand && cand.d <= t) {
        const el = overlay.querySelector(`[data-edge="${cand.key}"]`);
        if (el) el.classList.add('selected-delete-edge');
      }
    }
    if (linkMode && nearest.d <= linkThreshold) {
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', String(nearest.a.x));
      ln.setAttribute('y1', String(nearest.a.y));
      ln.setAttribute('x2', String(nearest.b.x));
      ln.setAttribute('y2', String(nearest.b.y));
      ln.setAttribute('class', 'corridor-line highlight');
      overlay.appendChild(ln);
      linkHighlightSeg = ln;
    }
  }
  if (!deleteLineMode && !deleteEdgeMode && !deleteMode && !linkMode) {
    const { wx, wy } = worldFromClient(e.clientX, e.clientY);
    let best = null;
    let bestD = Infinity;
    overlayNodes.forEach(n => {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    });
    const hoverThreshold = Math.max(24, 0.05 * Math.max(bb.width, bb.height));
    if (best && bestD <= hoverThreshold) setOverlayHover(best);
    else setOverlayHover(null);
  } else {
    setOverlayHover(null);
  }
}, { passive: true });

function updateSelection() {
  renderOverlay();
}

function updateLabels() {
  const sNode = startId && nodes[startId] ? nodes[startId] : null;
  const gNode = goalId && nodes[goalId] ? nodes[goalId] : null;
  startLabel.textContent = sNode ? getNodeLabel(sNode, startId) : 'не выбран';
  goalLabel.textContent = gNode ? getNodeLabel(gNode, goalId) : 'не выбрано';
}

function compute() {
  if (startId && !nodes[startId]) startId = null;
  if (goalId && !nodes[goalId]) goalId = null;
  updateLabels();
  if (!startId || !goalId) return;
  if (nodes[startId]?.type === 'room' && !isRoomNavigable(startId)) {
    console.log('Маршрут не построен: стартовая аудитория не имеет корректных рёбер', {
      startId,
      neighbors: (adj[startId] || []).map(e => ({ to: e.to, type: nodes[e.to]?.type }))
    });
    stepsEl.textContent = 'Маршрут не найден';
    draw([]);
    return;
  }
  if (nodes[goalId]?.type === 'room' && !isRoomNavigable(goalId)) {
    console.log('Маршрут не построен: целевая аудитория не имеет корректных рёбер', {
      goalId,
      neighbors: (adj[goalId] || []).map(e => ({ to: e.to, type: nodes[e.to]?.type }))
    });
    stepsEl.textContent = 'Маршрут не найден';
    draw([]);
    return;
  }
  const startCandidates = candidateDoorsNearNode(startId);
  const goalCandidates = candidateDoorsNearNode(goalId);
  const startOrdered = sortDoorsByDistance(startId, startCandidates);
  const goalOrdered = sortDoorsByDistance(goalId, goalCandidates);
  const exitDoors = (nodes[goalId]?.type === 'exit')
    ? (adj[goalId] || []).filter(e => nodes[e.to]?.type === 'door').map(e => e.to)
    : [];
  if (nodes[startId]?.type === 'door') snapDoorToCorridor(startId);
  if (nodes[goalId]?.type === 'door') snapDoorToCorridor(goalId);
  const startFiltered = startOrdered.filter(id => {
    const hasCorr = (adj[id] || []).some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return true;
    const t = nodes[id]?.type;
    if (t === 'door') snapDoorToCorridor(id);
    else if (t === 'exit' || t === 'stair') snapExitToCorridor(id, null, true);
    return (adj[id] || []).some(e => nodes[e.to]?.type === 'corridor');
  });
  const goalFiltered = goalOrdered.filter(id => {
    const hasCorr = (adj[id] || []).some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return true;
    const t = nodes[id]?.type;
    if (t === 'door') snapDoorToCorridor(id);
    else if (t === 'exit' || t === 'stair') snapExitToCorridor(id, null, true);
    return (adj[id] || []).some(e => nodes[e.to]?.type === 'corridor');
  });
  if (nodes[startId]?.type === 'room' && (startFiltered.length === 0 || startCandidates.length === 0)) {
    const forced = findDoorForRoom(startId);
    if (forced) startOrdered.push(forced);
  }
  if (nodes[goalId]?.type === 'room' && (goalFiltered.length === 0 || goalCandidates.length === 0)) {
    const forced = findDoorForRoom(goalId);
    if (forced) goalOrdered.push(forced);
  }
  let bestPath = null;
  let bestLen = Infinity;
  let bestStartDoor = null;
  let bestGoalDoor = null;
  const startLoop = startFiltered.length ? startFiltered : (startOrdered.length ? startOrdered : [startId]);
  let goalLoop = goalFiltered.length ? goalFiltered : (goalOrdered.length ? goalOrdered : [goalId]);
  if (nodes[goalId]?.type === 'exit' && exitDoors.length) {
    goalLoop = exitDoors;
  }
  console.log('COMPUTE startId, goalId, startLoop, goalLoop', {
    startId,
    goalId,
    startLoop,
    goalLoop
  });
  for (const s of startLoop) {
    for (const g of goalLoop) {
      const allowed = new Set();
      if (nodes[s]?.type === 'door') allowed.add(s);
      if (nodes[g]?.type === 'door') allowed.add(g);
      const pathCore = astar(s, g, allowed);
      if (!pathCore) continue;
      let L = pathCost(pathCore);
      if (nodes[goalId]?.type === 'room' && nodes[g]?.type === 'door') {
        const doorPenalty = dist(goalId, g);
        L += doorPenalty;
      }
      if (L < bestLen) { bestLen = L; bestPath = pathCore; bestStartDoor = s; bestGoalDoor = g; }
    }
  }
  if (!bestPath) {
    const allowSet = new Set();
    startLoop.forEach(id => { if (nodes[id]?.type === 'door') allowSet.add(id); });
    goalLoop.forEach(id => { if (nodes[id]?.type === 'door') allowSet.add(id); });
    Object.keys(nodes).forEach(id => { if (doorIsBridge(id)) allowSet.add(id); });
    for (const s of startLoop) {
      for (const g of goalLoop) {
        const pathCore = astar(s, g, allowSet);
        if (!pathCore) continue;
        let L = pathCost(pathCore);
        if (nodes[goalId]?.type === 'room' && nodes[g]?.type === 'door') {
          const doorPenalty = dist(goalId, g);
          L += doorPenalty;
        }
        if (L < bestLen) { bestLen = L; bestPath = pathCore; bestStartDoor = s; bestGoalDoor = g; }
      }
    }
    if (!bestPath) {
      const allowAllDoors = new Set(Object.keys(nodes).filter(id => nodes[id].type === 'door'));
      // Прямая попытка: от стартовой аудитории напрямую к выходу с разрешением дверей
      if (nodes[startId]?.type === 'room' && nodes[goalId]?.type === 'exit' && exitDoors.length === 0) {
        const direct = astar(startId, goalId, allowAllDoors);
        if (direct && direct.length > 1) { bestPath = direct; bestLen = length(direct); bestStartDoor = null; bestGoalDoor = null; }
      }
      for (const s of startLoop) {
        for (const g of goalLoop) {
          const pathCore2 = astar(s, g, allowAllDoors);
          if (!pathCore2) continue;
          let L2 = pathCost(pathCore2);
          if (nodes[goalId]?.type === 'room' && nodes[g]?.type === 'door') {
            const doorPenalty = dist(goalId, g);
            L2 += doorPenalty;
          }
          if (L2 < bestLen) { bestLen = L2; bestPath = pathCore2; bestStartDoor = s; bestGoalDoor = g; }
        }
      }
      if (!bestPath && nodes[goalId]?.type === 'room') {
        const goalDoors = candidateDoorsForRoom(goalId);
        const goalByCorr = sortDoorsByCorridorProximity(goalDoors);
        for (const s of startLoop) {
          for (const g of goalByCorr) {
            snapDoorToCorridor(g);
            const pathCore2b = astar(s, g, allowAllDoors);
            if (!pathCore2b) continue;
            let L2b = pathCost(pathCore2b);
            const pen = dist(goalId, g);
            L2b += pen;
            if (L2b < bestLen) { bestLen = L2b; bestPath = pathCore2b; bestStartDoor = s; bestGoalDoor = g; }
          }
        }
      }
      if (!bestPath && nodes[goalId]?.type === 'room') {
        const goalDoors = candidateDoorsForRoom(goalId);
        const goalDoorsOrdered = sortDoorsByDistance(goalId, goalDoors);
        for (const s of startLoop) {
          for (const g of goalDoorsOrdered) {
            const pathCore3 = astar(s, g, allowAllDoors);
            if (!pathCore3) continue;
            const L3 = pathCost(pathCore3);
            if (L3 < bestLen) { bestLen = L3; bestPath = pathCore3; bestStartDoor = s; bestGoalDoor = g; }
          }
        }
      }
      if (!bestPath && !(nodes[startId]?.type === 'room' && nodes[goalId]?.type === 'room')) {
        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
        const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
        const corrThresh = Math.max(48, 0.08 * Math.max(bb.width, bb.height));
        const corrAll = Object.keys(nodes).filter(id => nodes[id].type === 'corridor');
        const corrNearGoal = (nodes[goalId] ? corrAll.filter(cid => dist(goalId, cid) <= corrThresh) : []);
        for (const s of startLoop) {
          for (const c of corrNearGoal) {
            const pathCore4 = astar(s, c, allowAllDoors);
            if (!pathCore4) continue;
            const L4 = pathCost(pathCore4);
            if (L4 < bestLen) { bestLen = L4; bestPath = pathCore4; bestStartDoor = s; bestGoalDoor = null; }
          }
        }
      }
      if (!bestPath) {
        if (nodes[startId]?.type === 'room' && nodes[goalId]?.type === 'room') {
          const startDoors = candidateDoorsForRoom(startId);
          const goalDoors = candidateDoorsForRoom(goalId);
          if (DEBUG_NAV) console.log('🧭 MULTI-DOOR FALLBACK', { startId, goalId, startDoors, goalDoors });
          if (startDoors.length && goalDoors.length) {
            const startOrderedDoors = sortDoorsByDistance(startId, startDoors);
            const goalOrderedDoors = sortDoorsByDistance(goalId, goalDoors);
            for (const sDoor of startOrderedDoors) {
              for (const gDoor of goalOrderedDoors) {
                if (DEBUG_NAV) console.log('🧭 TRY DOOR PAIR', { sDoor, gDoor });
                const sSnap = snapDoorChainToCorridor(sDoor, null, true);
                const gSnap = snapDoorChainToCorridor(gDoor, null, true);
                if (!sSnap || !gSnap) {
                  if (DEBUG_NAV) console.log('🧭 SKIP PAIR: SNAP MISSING', { sDoor, gDoor, sSnap, gSnap });
                  continue;
                }
                const pDirect = corridorPathBetweenSnaps(sSnap, gSnap) || corridorPathViaCrossings(sSnap, gSnap) || corridorPathViaBridges(sSnap, gSnap);
                const pSnap = pDirect || astar(sSnap, gSnap, new Set(), new Set(['corridor']));
                if (!pSnap || pSnap.length <= 1) {
                  if (DEBUG_NAV) console.log('🧭 SKIP PAIR: NO CORRIDOR PATH', { sDoor, gDoor, sSnap, gSnap });
                  continue;
                }
                const pre = hasEdge(startId, sDoor) ? [startId, sDoor] : [startId];
                const anchorGoalDoor = doorIdFromSnap(gSnap);
                let post;
                if (anchorGoalDoor && anchorGoalDoor !== gDoor && hasEdge(anchorGoalDoor, gDoor)) {
                  const tail = [anchorGoalDoor, gDoor];
                  if (hasEdge(gDoor, goalId)) tail.push(goalId); else tail.push(goalId);
                  post = tail;
                } else {
                  post = hasEdge(gDoor, goalId) ? [gDoor, goalId] : [goalId];
                }
                const candidate = pre.concat(pSnap).concat(post);
                const Lc = pathCost(candidate);
                if (DEBUG_NAV) console.log('🧭 DOOR PAIR CANDIDATE', {
                  sDoor,
                  gDoor,
                  sSnap,
                  gSnap,
                  pathLength: candidate.length,
                  pathCost: Lc
                });
                if (Lc < bestLen) {
                  bestLen = Lc;
                  bestPath = candidate;
                  bestStartDoor = sDoor;
                  bestGoalDoor = gDoor;
                  if (DEBUG_NAV) console.log('🧭 NEW BEST MULTI-DOOR PATH', { bestLen, bestStartDoor, bestGoalDoor });
                }
              }
            }
          } else {
            if (DEBUG_NAV) console.log('🧭 MULTI-DOOR FALLBACK: no doors for start or goal', { startId, goalId, startDoors, goalDoors });
          }
        }
        if (!bestPath && nodes[goalId]?.type === 'door') {
          const allowAllDoors = new Set(Object.keys(nodes).filter(id => nodes[id].type === 'door'));
          const directDoor = astar(startId, goalId, allowAllDoors);
          if (directDoor && directDoor.length > 1) {
            bestPath = directDoor;
            bestLen = length(directDoor);
            bestStartDoor = nodes[startId]?.type === 'door' ? startId : bestStartDoor;
            bestGoalDoor = goalId;
          }
        }
        if (!bestPath && nodes[goalId]?.type === 'exit' && exitDoors.length === 0) {
          let sDoor = null;
          if (nodes[startId]?.type === 'door') sDoor = startId;
          else if (nodes[startId]?.type === 'room') sDoor = findDoorForRoom(startId);
          const sSnap = sDoor ? snapDoorToCorridor(sDoor, null, true) : null;
          const gSnap = snapExitToCorridor(goalId, null, true);
          if (sSnap && gSnap) {
            const pDirect = corridorPathBetweenSnaps(sSnap, gSnap) || corridorPathViaCrossings(sSnap, gSnap) || corridorPathViaBridges(sSnap, gSnap);
            const pSnap = pDirect || astar(sSnap, gSnap, new Set(), new Set(['corridor']));
            if (pSnap && pSnap.length > 1) {
              const pre = (nodes[startId]?.type === 'room' && sDoor && hasEdge(startId, sDoor)) ? [startId, sDoor] : [];
              const post = [goalId];
              bestPath = pre.concat(pSnap).concat(post);
              bestLen = pathCost(bestPath);
            }
          }
        }
        if (!bestPath && (nodes[startId]?.type === 'exit' || nodes[startId]?.type === 'stair') && nodes[goalId]?.type === 'room') {
          const gDoor = findDoorForRoom(goalId);
          const sSnap = snapExitToCorridor(startId, null, true);
          const gSnap = gDoor ? snapDoorChainToCorridor(gDoor, null, true) : null;
          if (sSnap && gSnap && gDoor) {
            const pDirect = corridorPathBetweenSnaps(sSnap, gSnap) || corridorPathViaCrossings(sSnap, gSnap) || corridorPathViaBridges(sSnap, gSnap);
            const pSnap = pDirect || astar(sSnap, gSnap, new Set(), new Set(['corridor']));
            if (pSnap && pSnap.length > 1) {
              let candidate = [];
              candidate.push(startId);
              if (sSnap !== startId) candidate.push(sSnap);
              if (pSnap.length > 2) candidate = candidate.concat(pSnap.slice(1, -1));
              if (gSnap !== gDoor) candidate.push(gSnap);
              candidate.push(gDoor, goalId);
              bestPath = candidate;
              bestLen = pathCost(bestPath);
              bestStartDoor = null;
              bestGoalDoor = gDoor;
            }
          }
        }
        if (!bestPath) {
          if (nodes[goalId]?.type === 'door') {
            const neighbors = adj[goalId] || [];
            const roomNeighbor = neighbors.map(e => e.to).find(id => nodes[id]?.type === 'room');
            if (roomNeighbor) {
              const originalGoalId = goalId;
              goalId = roomNeighbor;
              compute();
              goalId = originalGoalId;
              return;
            }
          }
          stepsEl.textContent = 'Маршрут не найден'; draw([]); return;
        }
      }
    }
  }
  if (nodes[goalId]?.type === 'stair') {
    let sDoor = null;
    if (nodes[startId]?.type === 'door') sDoor = startId;
    else if (nodes[startId]?.type === 'room') sDoor = findDoorForRoom(startId);
    const sSnap = sDoor ? snapDoorToCorridor(sDoor, null, true) : null;
    const gSnap = snapExitToCorridor(goalId, null, true);
    if (sSnap && gSnap) {
      const pDirect = corridorPathBetweenSnaps(sSnap, gSnap) || corridorPathViaCrossings(sSnap, gSnap) || corridorPathViaBridges(sSnap, gSnap);
      const pSnap = pDirect || astar(sSnap, gSnap, new Set(), new Set(['corridor']));
      if (pSnap && pSnap.length > 1) {
        const pre = (nodes[startId]?.type === 'room' && sDoor && hasEdge(startId, sDoor)) ? [startId, sDoor] : [];
        const post = [goalId];
        const candidate = pre.concat(pSnap).concat(post);
        const Lc = pathCost(candidate);
        bestPath = candidate;
        bestLen = Lc;
        bestStartDoor = sDoor;
        bestGoalDoor = null;
      }
    }
  }
  if (bestPath && bestStartDoor && bestGoalDoor && bestPath.some(id => nodes[id]?.type === 'corridor')) {
    const toSnap = (nodeId) => {
      if (!nodes[nodeId]) return null;
      const t = nodes[nodeId].type;
      if (t === 'door') return snapDoorToCorridor(nodeId, null, true);
      if (t === 'exit' || t === 'stair') return snapExitToCorridor(nodeId, null, true);
      if (t === 'corridor') return nodeId;
      return null;
    };
    const sSnap = toSnap(bestStartDoor);
    const gSnap = toSnap(bestGoalDoor);
    if (sSnap && gSnap) {
      const pDirect = corridorPathBetweenSnaps(sSnap, gSnap) || corridorPathViaCrossings(sSnap, gSnap) || corridorPathViaBridges(sSnap, gSnap);
      const pSnap = pDirect || astar(sSnap, gSnap, new Set(), new Set(['corridor']));
      if (pSnap && pSnap.length > 1) {
        let pathCorr = [];
        if (nodes[startId]?.type === 'room') pathCorr.push(startId);
        pathCorr.push(bestStartDoor);
        if (sSnap !== bestStartDoor) pathCorr.push(sSnap);
        pathCorr = pathCorr.concat(pSnap.slice(1));
        if (bestGoalDoor !== gSnap) pathCorr.push(bestGoalDoor);
        if (nodes[goalId]?.type === 'room') pathCorr.push(goalId);
        bestPath = pathCorr;
        bestLen = pathCost(bestPath);
      }
    }
  }
  if (nodes[startId]?.type === 'room' && bestStartDoor && nodes[bestStartDoor]?.type === 'door' && !hasEdge(startId, bestStartDoor)) {
    addEdgeConstrained(startId, bestStartDoor, dist(startId, bestStartDoor));
  }
  if (nodes[goalId]?.type === 'room' && bestGoalDoor && nodes[bestGoalDoor]?.type === 'door' && !hasEdge(bestGoalDoor, goalId)) {
    addEdgeConstrained(bestGoalDoor, goalId, dist(bestGoalDoor, goalId));
  }
  let pathFinal = [...bestPath];
  if (nodes[goalId]?.type === 'room' && bestGoalDoor && pathFinal && pathFinal.length) {
    const last = pathFinal[pathFinal.length - 1];
    if (last !== bestGoalDoor) {
      const allowTail = new Set([bestGoalDoor]);
      const tail = astar(last, bestGoalDoor, allowTail);
      if (tail && tail.length > 1) {
        pathFinal = pathFinal.concat(tail.slice(1));
      }
    }
  }
  if (nodes[startId]?.type === 'room' && pathFinal[0] !== startId && hasEdge(startId, pathFinal[0])) pathFinal = [startId, ...pathFinal];
  if (nodes[goalId]?.type === 'room' && pathFinal[pathFinal.length - 1] !== goalId && bestGoalDoor && hasEdge(bestGoalDoor, goalId)) pathFinal = [...pathFinal, goalId];

  if (nodes[goalId]?.type === 'door' && pathFinal && pathFinal.length) {
    const last = pathFinal[pathFinal.length - 1];
    if (last !== goalId) {
      const tail = extendPathToDoorGoal(last, goalId);
      if (tail && tail.length > 1 && tail[0] === last) {
        pathFinal = pathFinal.concat(tail.slice(1));
      }
    }
  }

  if ((nodes[goalId]?.type === 'exit' || nodes[goalId]?.type === 'stair') && Array.isArray(pathFinal) && pathFinal.length && exitDoors && exitDoors.length && bestGoalDoor && hasEdge(bestGoalDoor, goalId)) {
    const last = pathFinal[pathFinal.length - 1];
    if (last !== bestGoalDoor) {
      const allowDoors = new Set(Object.keys(nodes).filter(id => nodes[id].type === 'door'));
      const tailToDoor = astar(last, bestGoalDoor, allowDoors);
      if (tailToDoor && tailToDoor.length > 1) {
        pathFinal = pathFinal.concat(tailToDoor.slice(1));
      }
    }
    if (pathFinal[pathFinal.length - 1] === bestGoalDoor) {
      pathFinal = pathFinal.concat([goalId]);
    }
  }

  if (nodes[goalId]?.type === 'exit' && pathFinal && pathFinal.length && (!exitDoors || exitDoors.length === 0)) {
    const last = pathFinal[pathFinal.length - 1];
    if (last !== goalId) {
      const allowDoors = new Set(Object.keys(nodes).filter(id => nodes[id].type === 'door'));
      const exitDoors = (adj[goalId] || []).filter(e => nodes[e.to]?.type === 'door').map(e => e.to);
      let extended = false;
      if (exitDoors.length) {
        for (const d of exitDoors) {
          snapDoorToCorridor(d);
          const tD = astar(last, d, allowDoors);
          if (tD && tD.length > 1) {
            const tEX = astar(d, goalId, allowDoors);
            if (tEX && tEX.length > 1) { pathFinal = pathFinal.concat(tD.slice(1)).concat(tEX.slice(1)); extended = true; break; }
          }
        }
        if (!extended) { stepsEl.textContent = 'Маршрут не найден'; draw([]); return; }
      } else {
        snapExitToCorridor(goalId);
        const tail = astar(last, goalId, allowDoors);
        if (tail && tail.length > 1) {
          pathFinal = pathFinal.concat(tail.slice(1));
        } else {
          const corrNeighbors = (adj[goalId] || []).filter(e => nodes[e.to]?.type === 'corridor').map(e => e.to);
          for (const c of corrNeighbors) {
            const t2 = astar(last, c, allowDoors);
            if (t2 && t2.length > 1) {
              const t3 = astar(c, goalId, allowDoors);
              if (t3 && t3.length > 1) { pathFinal = pathFinal.concat(t2.slice(1)).concat(t3.slice(1)); break; }
            }
          }
        }
      }
    }
  }

  if (nodes[goalId]?.type === 'stair' && pathFinal && pathFinal.length) {
    const last = pathFinal[pathFinal.length - 1];
    if (last !== goalId) {
      const allowDoors = new Set(Object.keys(nodes).filter(id => nodes[id].type === 'door'));
      const stairDoors = (adj[goalId] || []).filter(e => nodes[e.to]?.type === 'door').map(e => e.to);
      let extended = false;
      if (stairDoors.length) {
        for (const d of stairDoors) {
          snapDoorToCorridor(d);
          const tD = astar(last, d, allowDoors);
          if (tD && tD.length > 1) {
            const tST = astar(d, goalId, allowDoors);
            if (tST && tST.length > 1) { pathFinal = pathFinal.concat(tD.slice(1)).concat(tST.slice(1)); extended = true; break; }
          }
        }
        if (!extended) { stepsEl.textContent = 'Маршрут не найден'; draw([]); return; }
      } else {
        snapExitToCorridor(goalId);
        const tail = astar(last, goalId, allowDoors);
        if (tail && tail.length > 1) {
          pathFinal = pathFinal.concat(tail.slice(1));
        } else {
          const corrNeighbors = (adj[goalId] || []).filter(e => nodes[e.to]?.type === 'corridor').map(e => e.to);
          for (const c of corrNeighbors) {
            const t2 = astar(last, c, allowDoors);
            if (t2 && t2.length > 1) {
              const t3 = astar(c, goalId, allowDoors);
              if (t3 && t3.length > 1) { pathFinal = pathFinal.concat(t2.slice(1)).concat(t3.slice(1)); break; }
            }
          }
        }
      }
    }
  }

  console.log('✅ BEST PATH:', bestPath ? bestPath.length : 0, 'nodes, cost:', bestLen);
  console.log('📍 PATH NODES RAW:', bestPath.map(id => ({
    id,
    type: nodes[id]?.type,
    name: nodes[id]?.name
  })));
  if (DEBUG_NAV) {
    bestPath.forEach((id, i) => {
      const n = nodes[id];
      console.log('STEP', i, id, 'type=', n?.type, 'name=', n?.name, 'x=', n?.x, 'y=', n?.y);
    });
  }

  let fullPath = Array.isArray(pathFinal) ? pathFinal : [];
  fullPath = removePathCycles(fullPath);
  fullPath = reconstructCorridorByAnchors(fullPath);

  if (!validateRoute(fullPath)) {
    console.log('Маршрут невалиден, так как содержит дверь без привязки к коридору');
    stepsEl.textContent = 'Маршрут не найден';
    draw([]);
    return;
  }

  let geomPath = fullPath.slice();
  if (nodes[startId]?.type === 'room') {
    let doorsStart = candidateDoorsForRoom(startId);
    if (!doorsStart.length) {
      const forced = findDoorForRoom(startId);
      if (forced) doorsStart = [forced];
    }
    if (doorsStart.length) {
      const doorId = sortDoorsByDistance(startId, doorsStart)[0];
      if (DEBUG_NAV) console.log('🧭 geom start doors', { startId, doorsStart, doorId });
      const idxRoom = geomPath.indexOf(startId);
      if (idxRoom !== -1 && doorId) {
        let idxDoor = geomPath.indexOf(doorId);
        if (idxDoor === -1) {
          geomPath.splice(idxRoom + 1, 0, doorId);
        } else if (idxDoor !== idxRoom + 1) {
          geomPath.splice(idxDoor, 1);
          geomPath.splice(idxRoom + 1, 0, doorId);
        }
      }
    }
  }
  if (nodes[goalId]?.type === 'room') {
    let doorsGoal = candidateDoorsForRoom(goalId);
    if (!doorsGoal.length) {
      const forced = findDoorForRoom(goalId);
      if (forced) doorsGoal = [forced];
    }
    if (doorsGoal.length) {
      const doorId = sortDoorsByDistance(goalId, doorsGoal)[0];
      if (DEBUG_NAV) console.log('🧭 geom goal doors', { goalId, doorsGoal, doorId });
      const idxRoom = geomPath.lastIndexOf(goalId);
      if (idxRoom !== -1 && doorId) {
        let idxDoor = geomPath.lastIndexOf(doorId);
        if (idxDoor === -1) {
          geomPath.splice(idxRoom, 0, doorId);
          idxDoor = idxRoom;
        } else if (idxDoor !== idxRoom - 1) {
          geomPath.splice(idxDoor, 1);
          geomPath.splice(idxRoom, 0, doorId);
          idxDoor = idxRoom;
        }
        const mainDoor = primaryDoorForRoom(goalId, doorId);
        if (mainDoor && mainDoor !== doorId) {
          let idxMain = geomPath.lastIndexOf(mainDoor);
          if (idxMain === -1) {
            geomPath.splice(idxDoor, 0, mainDoor);
          } else if (idxMain !== idxDoor - 1) {
            geomPath.splice(idxMain, 1);
            geomPath.splice(idxDoor, 0, mainDoor);
          }
        }
      }
    }
  }

  const ptsRoute = buildRoutePointsFromPath(geomPath);
  const points = ptsRoute.map(p => `${Math.round(p.x)},${Math.round(p.y)}`);
  route.setAttribute('points', points.join(' '));
  let displayPath = simplifyPath(fullPath);
  const visiblePath = displayPath.filter(id => nodes[id]?.type !== 'anchor');
  stepsEl.textContent = compressedNames(visiblePath).join(' → ');
  turnsEl.textContent = describePath(displayPath);
  adjustPanelHeight();
}

function simplifyRoute(points, pathIds) {
  const toXY = s => {
    const [x, y] = s.split(',').map(v => parseFloat(v));
    return { x, y };
  };
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const eps = Math.max(1, 0.004 * Math.max(bb.width, bb.height));
  const pts = points.map(toXY);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!out.length) { out.push(p); continue; }
    const last = out[out.length - 1];
    const dLast = Math.hypot(p.x - last.x, p.y - last.y);
    if (dLast < eps) continue;
    if (out.length >= 2) {
      const prev = out[out.length - 2];
      const { d, t } = projectOntoSegment(last.x, last.y, prev.x, prev.y, p.x, p.y);
      const keepTypes = new Set(['door', 'exit', 'room']);
      const lastId = pathIds[i - 1];
      const typeLast = nodes[lastId]?.type;
      const corrSpecial = lastId && /^SNAP_|^SNAPX_|^X_|^BR_|^BRP_/.test(String(lastId));
      const typePrev = nodes[pathIds[i - 2]]?.type;
      const typeNext = nodes[pathIds[i]]?.type;
      const corrTurn = typeLast === 'corridor' && typePrev === 'corridor' && typeNext === 'corridor';
      if (!(typeLast && keepTypes.has(typeLast)) && !corrSpecial && !corrTurn) {
        if (d < eps && t > 0 && t < 1) { out.pop(); }
      }
    }
    out.push(p);
  }
  return out.map(p => `${Math.round(p.x)},${Math.round(p.y)}`);
}
function removePathCycles(path) {
  if (!Array.isArray(path) || path.length < 2) return path;
  const pos = new Map();
  let out = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    if (pos.has(id)) {
      const j = pos.get(id);
      out = out.slice(0, j + 1);
      // reset positions after j
      const newPos = new Map();
      for (let k = 0; k < out.length; k++) newPos.set(out[k], k);
      pos.clear();
      newPos.forEach((v, k) => pos.set(k, v));
    } else {
      out.push(id);
      pos.set(id, out.length - 1);
    }
  }
  return out;
}
function compressedNames(path) {
  const out = [];
  let lastCorr = null;
  for (const id of path) {
    const t = nodes[id]?.type || 'corridor';
    const nm = getNodeLabel(nodes[id], id);
    if (t === 'corridor' && typeof nm === 'string' && /пересечение/i.test(nm)) {
      continue;
    }
    if (t === 'corridor') {
      const key = typeof nm === 'string'
        ? nm.toLowerCase().replace(/\s*\d+$/u, '').trim()
        : '';
      if (key && key === lastCorr) continue;
      lastCorr = key || null;
      out.push(nm);
    } else {
      lastCorr = null;
      out.push(nm);
    }
  }
  return out;
}

function draw(points) {
  route.setAttribute('points', points.join(' '));
}

function buildPolylineIds(path) {
  const res = [];
  if (!Array.isArray(path) || path.length === 0) return res;
  const thresh = 400;
  const isDoorOrRoom = n => n && (n.type === 'door' || n.type === 'room');
  res.push(path[0]);
  let i = 0;
  while (i < path.length - 1) {
    const curId = path[i];
    const curNode = nodes[curId];
    if (!isDoorOrRoom(curNode)) {
      const nextId = path[i + 1];
      res.push(nextId);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < path.length) {
      const n = nodes[path[j]];
      if (isDoorOrRoom(n)) break;
      j++;
    }
    if (j >= path.length) {
      for (let k = i + 1; k < path.length; k++) {
        res.push(path[k]);
      }
      break;
    }
    let distSum = 0;
    let doorCount = 0;
    for (let k = i; k < j; k++) {
      distSum += dist(path[k], path[k + 1]);
      const mid = nodes[path[k + 1]];
      if (mid && mid.type === 'door' && k + 1 !== j) doorCount++;
    }
    if (distSum > thresh && doorCount === 0) {
      res.push(path[j]);
    } else {
      for (let k = i + 1; k <= j; k++) {
        res.push(path[k]);
      }
    }
    i = j;
  }
  return res;
}

function trimCorridorTail(path) {
  const out = [];
  let seenCross = false;
  for (const id of path) {
    const n = nodes[id];
    if (!n) continue;
    out.push(id);
    if (
      !seenCross &&
      n.type === 'corridor' &&
      typeof n.name === 'string' &&
      n.name.includes('Пересечение')
    ) {
      seenCross = true;
    } else if (seenCross && n.type === 'corridor') {
      out.pop();
    }
  }
  return out;
}

function cutAtFirstCross(path) {
  if (!Array.isArray(path)) return [];
  const out = [];
  let cut = false;
  for (const id of path) {
    const n = nodes[id];
    if (!n) continue;
    out.push(id);
    if (
      !cut &&
      n.type === 'corridor' &&
      typeof n.name === 'string' &&
      n.name.includes('Пересечение')
    ) {
      cut = true;
      break;
    }
  }
  return out;
}

function firstCorridorIndex(path) {
  if (!Array.isArray(path)) return -1;
  for (let i = 0; i < path.length; i++) {
    const n = nodes[path[i]];
    if (n && n.type === 'corridor') return i;
  }
  return -1;
}

function clampCorridorToPath(path) {
  if (!Array.isArray(path) || path.length < 2) return path;
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const n = nodes[id];
    if (!n) continue;
    if (i === 0 || i === path.length - 1) {
      out.push(id);
      continue;
    }
    const prev = nodes[path[i - 1]];
    const next = nodes[path[i + 1]];
    if (n.type === 'corridor' && prev && next) {
      const dx1 = n.x - prev.x, dy1 = n.y - prev.y;
      const dx2 = next.x - n.x, dy2 = next.y - n.y;
      const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      if (cross < 1) {
        out.push(id);
      }
      continue;
    }
    out.push(id);
  }
  return out;
}

function corridorSegmentPoints(aId, bId) {
  const a = nodes[aId], b = nodes[bId];
  if (!a || !b || a.type !== 'corridor' || b.type !== 'corridor') return null;
  // Проекция точки на отрезок polyline
  function projectPointOnSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const c2 = vx * vx + vy * vy;
    if (c2 === 0) return { t: 0, dist: Math.hypot(px - ax, py - ay) };
    let t = (vx * wx + vy * wy) / c2;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const projx = ax + t * vx;
    const projy = ay + t * vy;
    return { t, dist: Math.hypot(px - projx, py - projy) };
  }

  // Строим отрезок polyline между двумя точками по параметру вдоль линии
  function buildSegmentOnPolyline(pts, lineId) {
    if (!Array.isArray(pts) || pts.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cum[i] = cum[i - 1] + d;
    }
    function projectOnLine(px, py) {
      let best = { s: 0, dist: Infinity, segIndex: 0, t: 0 };
      for (let i = 0; i < pts.length - 1; i++) {
        const A = pts[i], B = pts[i + 1];
        const pr = projectPointOnSeg(px, py, A.x, A.y, B.x, B.y);
        const segLen = Math.hypot(B.x - A.x, B.y - A.y);
        const s = cum[i] + pr.t * segLen;
        if (pr.dist < best.dist) {
          best = { s, dist: pr.dist, segIndex: i, t: pr.t };
        }
      }
      return best;
    }

    // Положение узлов a и b вдоль линии в терминах накопленной длины
    const pa = projectOnLine(a.x, a.y);
    const pb = projectOnLine(b.x, b.y);
    const tol = 4;
    if (pa.dist > tol || pb.dist > tol) return null;

    // sStart и sEnd — параметры вдоль линии; учитываем порядок следования узлов
    let sStart = pa.s;
    let sEnd = pb.s;
    let reversed = false;
    if (sEnd < sStart) {
      const tmp = sStart;
      sStart = sEnd;
      sEnd = tmp;
      reversed = true;
    }

    const segPts = [];
    // Вырезаем из polyline только участок между sStart и sEnd
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1];
      const segLen = Math.hypot(B.x - A.x, B.y - A.y);
      const segStart = cum[i];
      const segEnd = cum[i] + segLen;
      if (segEnd < sStart || segStart > sEnd) continue;
      if (!segPts.length) {
        const tStart = Math.max(0, (sStart - segStart) / segLen);
        const xStart = A.x + tStart * (B.x - A.x);
        const yStart = A.y + tStart * (B.y - A.y);
        segPts.push({ x: xStart, y: yStart });
      }
      const tEnd = segEnd > sEnd ? (sEnd - segStart) / segLen : 1;
      const xEnd = A.x + tEnd * (B.x - A.x);
      const yEnd = A.y + tEnd * (B.y - A.y);
      segPts.push({ x: xEnd, y: yEnd });
      if (segEnd >= sEnd) break;
    }
    if (segPts.length < 2) return null;

    if (reversed) segPts.reverse();

    if (DEBUG_NAV) {
      console.log('🧭 corridor segment', {
        from: aId,
        to: bId,
        lineId,
        sFrom: pa.s,
        sTo: pb.s,
        segIndexFrom: pa.segIndex,
        segIndexTo: pb.segIndex,
        pointsCount: segPts.length
      });
    }

    return segPts;
  }

  // Основной случай — есть id линии коридора (CLxxx) в идентификаторах узлов
  const lineIdFromId = parseCorrLine(aId) || parseCorrLine(bId);
  if (lineIdFromId && Array.isArray(overlayCorrLines) && overlayCorrLines.length) {
    const line = overlayCorrLines.find(l => l.id === lineIdFromId);
    if (line && Array.isArray(line.points) && line.points.length >= 2) {
      const seg = buildSegmentOnPolyline(line.points.map(p => ({ x: p.x, y: p.y })), lineIdFromId);
      if (seg) return seg;
    }
  }

  // Резервный случай — ищем подходящую линию среди SVG polyline
  const scope = document.getElementById('viewport') || document;
  const lines = scope.querySelectorAll('.corridor-line');
  let bestSeg = null;
  let bestCost = Infinity;
  lines.forEach(el => {
    const ptsEl = (el.getAttribute('points') || '')
      .trim().split(/\s+/)
      .map(p => {
        const [x, y] = p.split(',').map(Number);
        return { x, y };
      }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (ptsEl.length < 2) return;
    const lineId = el.getAttribute('data-corr-line') || null;
    const seg = buildSegmentOnPolyline(ptsEl, lineId);
    if (!seg) return;
    const len = Math.hypot(seg[seg.length - 1].x - seg[0].x, seg[seg.length - 1].y - seg[0].y);
    const cost = len;
    if (cost < bestCost) {
      bestCost = cost;
      bestSeg = seg;
    }
  });

  if (bestSeg) return bestSeg;

  if (DEBUG_NAV) console.log('🧭 corridor segment fallback', { from: aId, to: bId });
  return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

function buildRoutePointsFromPath(path) {
  const out = [];
  if (!Array.isArray(path) || path.length === 0) return out;
  const isCorridor = id => !!nodes[id] && nodes[id].type === 'corridor';
  const isCorridorEntry = id => {
    const n = nodes[id];
    if (!n || n.type !== 'corridor') return false;
    const edges = adj[id] || [];
    return edges.some(e => {
      const t = nodes[e.to]?.type;
      return t && t !== 'corridor';
    });
  };
  const isLocalCorrPoint = id => {
    if (!isCorridor(id)) return false;
    const s = String(id);
    if (/^(SNAP_|SNAPX_|X_|BR_|BRP_)/.test(s)) return true;
    return isCorridorEntry(id);
  };
  const lineOf = id => parseCorrLine(id);

  for (let i = 0; i < path.length; i++) {
    const idA = path[i];
    const nA = nodes[idA];
    if (!nA) continue;

    if (i === 0) {
      out.push({ x: nA.x, y: nA.y });
    }
    if (i === path.length - 1) break;

    const idB = path[i + 1];
    const nB = nodes[idB];
    if (!nB) continue;

    if (isCorridor(idA) && isCorridor(idB)) {
      const baseLineId = lineOf(idA) || lineOf(idB);
      if (baseLineId) {
        let j = i;
        while (j + 1 < path.length && isCorridor(path[j + 1])) {
          const idNext = path[j + 1];
          const lineNext = lineOf(idNext);
          if (lineNext && lineNext !== baseLineId) break;
          j++;
        }

        const blockIds = path.slice(i, j + 1);
        if (blockIds.length >= 2) {
          const localIds = blockIds.filter(isLocalCorrPoint);
          const anchors = blockIds.filter(isCorridorEntry);
          let startId = blockIds[0];
          let endId = blockIds[blockIds.length - 1];
          if (localIds.length >= 2) {
            startId = localIds[0];
            endId = localIds[localIds.length - 1];
          } else if (localIds.length === 1) {
            const only = localIds[0];
            if (only === blockIds[0]) {
              startId = only;
            } else if (only === blockIds[blockIds.length - 1]) {
              endId = only;
            } else {
              startId = only;
            }
          } else if (anchors.length >= 2) {
            startId = anchors[0];
            endId = anchors[anchors.length - 1];
          }
          if (DEBUG_NAV) {
            console.log('🧭 route corridor block using polyline', {
              lineId: baseLineId,
              from: startId,
              to: endId,
              count: blockIds.length,
              ids: blockIds
            });
          }
          const seg = corridorSegmentPoints(startId, endId);
          if (seg && seg.length) {
            for (let k = 1; k < seg.length; k++) {
              out.push(seg[k]);
            }
            i = j - 1;
            continue;
          }
        }
      }

      if (DEBUG_NAV) {
        console.log('🧭 route corridor direct', {
          from: idA,
          to: idB,
          lineFrom: lineOf(idA),
          lineTo: lineOf(idB)
        });
      }
      out.push({ x: nB.x, y: nB.y });
      continue;
    }

    out.push({ x: nB.x, y: nB.y });
  }

  return out;
}
function simplifyPath(path) {
  if (!Array.isArray(path) || path.length <= 2) return path;
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const n = nodes[id];
    const prev = i > 0 ? nodes[path[i - 1]] : null;
    const next = i < path.length - 1 ? nodes[path[i + 1]] : null;
    const t = n?.type;
    if (t === 'room' || t === 'door') {
      out.push(id);
      continue;
    }
    if (t === 'corridor') {
      if (typeof n.name === 'string' && n.name.includes('Пересечение')) {
        out.push(id);
        continue;
      }
      if (prev && next) {
        const dx1 = n.x - prev.x;
        const dy1 = n.y - prev.y;
        const dx2 = next.x - n.x;
        const dy2 = next.y - n.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        if (cross > 1) {
          out.push(id);
          continue;
        }
      }
      continue;
    }
    out.push(id);
  }
  return out;
}

function length(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    L += dist(path[i - 1], path[i]);
  }
  return L;
}

function edgeWeight(a, b) {
  if (!nodes[a] || !nodes[b]) return Infinity;
  const ta = nodes[a].type, tb = nodes[b].type;
  if (ta === 'door' && tb === 'door') return Infinity;
  let w = dist(a, b);
  if (ta === 'corridor' && tb === 'corridor') {
    const sa = String(a);
    const sb = String(b);
    const isSpecial = s => /^(SNAP_|SNAPX_|X_|BR_|BRP_)/.test(s);
    const isCLPoint = s => /^CL[^_]*_\d+$/.test(s);

    if (!isSpecial(sa) && !isSpecial(sb) && isCLPoint(sa) && isCLPoint(sb)) {
      const ma = sa.match(/^([^_]+)_(\d+)$/);
      const mb = sb.match(/^([^_]+)_(\d+)$/);
      if (ma && mb && ma[1] === mb[1]) {
        if (Math.abs(parseInt(ma[2], 10) - parseInt(mb[2], 10)) !== 1) w *= 50;
      } else {
        w *= 40;
      }
    }
  }
  if ((ta === 'corridor' && tb === 'exit') || (ta === 'exit' && tb === 'corridor')) {
    const exitId = ta === 'exit' ? a : b;
    const hasDoor = (adj[exitId] || []).some(e => nodes[e.to]?.type === 'door');
    w *= hasDoor ? 1000 : 30;
  }
  return isFinite(w) ? w : Infinity;
}

function adjustedEdgeWeight(cur, to, base, goal) {
  let w = base;
  const tc = nodes[cur]?.type;
  const tt = nodes[to]?.type;
  if (tc === 'corridor' && tt !== 'corridor') w *= 1.5;
  if (dist(to, goal) < dist(cur, goal)) w *= 0.8;
  return w;
}

function pathCost(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    const w = edgeWeight(path[i - 1], path[i]);
    L += isFinite(w) ? w : dist(path[i - 1], path[i]);
  }
  return L;
}

function clearAll() {
  startId = null;
  goalId = null;
  updateSelection();
  updateLabels();
  draw([]);
  stepsEl.textContent = 'Маршрут не задан';
  setMode('start');
  startInput.value = '';
  goalInput.value = '';
  turnsEl.textContent = '';
  whereBtn.classList.remove('btn-danger');
  whereBtn.classList.add('btn-primary');
}

setMode('start');
refreshDatalist();
function setMode(m) {
  mode = m;
  hintEl.textContent = m === 'start'
    ? 'Нажмите «Указать где я», затем кликните на карту'
    : 'Теперь кликните на пункт назначения на карте';
  linkMode = false;
  linkA = null;
  corrLineMode = false;
  deleteLineMode = false;
  deleteEdgeMode = false;
  if (btnLink) btnLink.classList.remove('btn-primary');
  if (btnCorrLine) btnCorrLine.classList.remove('btn-primary');
  if (btnDeleteLine) btnDeleteLine.classList.remove('btn-primary');
  if (btnDeleteEdge) btnDeleteEdge.classList.remove('btn-primary');
  if (linkHighlightSeg && linkHighlightSeg.parentNode) { try { linkHighlightSeg.remove(); } catch (_) {} linkHighlightSeg = null; }
  renderOverlay();
}

function setById(target, id) {
  if (!nodes[id]) return;
  if (target === 'start') startId = id; else goalId = id;
  updateSelection();
  renderOverlay();
  updateLabels();
  hintEl.textContent = target === 'start' ? 'Место отмечено. Теперь выберите пункт назначения.' : 'Пункт назначения указан.';
  compute();
}

function setByValue(target, value) {
  const id = resolveId(value);
  if (!id) return;
  setById(target, id);
}

function normalizeSearchQuery(s) {
  let out = String(s || '').toLowerCase();
  try { out = out.normalize('NFKC'); } catch (_) {}
  out = out.replace(/ё/g, 'е');
  out = out.replace(/[^0-9a-zа-я\s]/g, ' ');
  out = out.replace(/\b(аудитория|ауд\.?|ауд|auditorium|aud)\b/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (/^a\d/.test(out)) out = out.replace(/^a/, 'а');
  return out;
}

function resolveId(value) {
  if (!value) return null;
  if (nodes[value]) return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const norm = normalizeSearchQuery(raw);
  const digits = norm.replace(/\D+/g, '');
  const overlaySet = Array.isArray(overlayNodes) ? new Set(overlayNodes.map(n => n.id)) : null;
  let bestId = null;
  let bestScore = 0;
  for (const [id, n] of Object.entries(nodes)) {
    if (!n) continue;
    const type = n.type || 'room';
    if (type === 'door' || type === 'corridor') continue;
    const label = getNodeLabel(n, id);
    const labelRaw = String(label).trim().toLowerCase();
    const labelNorm = normalizeSearchQuery(labelRaw);
    const idLower = String(id).toLowerCase();
    const labelDigits = labelNorm.replace(/\D+/g, '');
    const idDigits = idLower.replace(/\D+/g, '');
    let score = 0;
    if (labelRaw === raw || idLower === raw) score = 100;
    else if (labelNorm === norm) score = 90;
    else if (labelNorm && norm && (labelNorm.indexOf(norm) !== -1 || norm.indexOf(labelNorm) !== -1 || idLower.indexOf(norm) !== -1)) score = 80;
    else if (digits && (digits === labelDigits || digits === idDigits)) score = 70;
    else if (digits && (labelDigits.indexOf(digits) !== -1 || idDigits.indexOf(digits) !== -1)) score = 60;
    if (!score) continue;
    if (type === 'room') score += 5;
    if (overlaySet && overlaySet.has(id)) score += 25;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

function refreshDatalist() {
  nodeList.innerHTML = '';
  const seen = new Set();
  searchItems = [];
  Object.keys(nodes).forEach(id => {
    const n = nodes[id];
    if (!n) return;
    if (n.type === 'anchor' || n.type === 'door' || n.type === 'corridor') return;
    const label = getNodeLabel(n, id);
    const labelLower = String(label || '').trim().toLowerCase();
    if (labelLower.includes('пересечение')) return;
    const key = labelLower;
    if (!key || seen.has(key)) return;
    seen.add(key);
    searchItems.push(label);
  });
}

function buildNodeDropdown(targetInput, items) {
  if (!targetInput || !items || !items.length) {
    closeNodeDropdown();
    return;
  }
  dropdownActiveInput = targetInput;
  nodeDropdown.innerHTML = '';
  const rect = targetInput.getBoundingClientRect();
  nodeDropdown.style.minWidth = rect.width + 'px';
  nodeDropdown.style.left = rect.left + 'px';
  nodeDropdown.style.top = rect.bottom + 4 + 'px';
  items.forEach(label => {
    const item = document.createElement('div');
    item.className = 'node-dropdown-item';
    item.textContent = label;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      if (!dropdownActiveInput) return;
      dropdownActiveInput.value = label;
      if (dropdownActiveInput === startInput) {
        setByValue('start', label);
      } else if (dropdownActiveInput === goalInput) {
        setByValue('goal', label);
      }
      closeNodeDropdown();
    });
    nodeDropdown.appendChild(item);
  });
  nodeDropdown.style.display = 'block';
  if (targetInput === startInput && startArrow) {
    startArrow.classList.add('open');
  }
  if (targetInput === goalInput && goalArrow) {
    goalArrow.classList.add('open');
  }
}

function openNodeDropdown(targetInput) {
  if (!targetInput || !searchItems.length) return;
  buildNodeDropdown(targetInput, searchItems);
}

function closeNodeDropdown() {
  nodeDropdown.style.display = 'none';
  dropdownActiveInput = null;
  if (startArrow) startArrow.classList.remove('open');
  if (goalArrow) goalArrow.classList.remove('open');
}

function filterNodeDropdownForInput(targetInput) {
  if (!targetInput) return;
  const raw = String(targetInput.value || '').toLowerCase();
  const query = normalizeSearchQuery(raw);
  if (!query) {
    closeNodeDropdown();
    return;
  }
  const filtered = searchItems.filter(label => {
    const labelRaw = String(label || '').toLowerCase();
    const labelNorm = normalizeSearchQuery(labelRaw);
    return (
      labelRaw.includes(raw) ||
      labelNorm.includes(query) ||
      query.includes(labelNorm)
    );
  });
  if (!filtered.length) {
    closeNodeDropdown();
    return;
  }
  buildNodeDropdown(targetInput, filtered);
}

function describePath(path) {
  if (!path || path.length < 2) return '';
  const parts = [];
  let lastCorr = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const tb = nodes[b].type || 'corridor';
    if (tb === 'anchor') continue;
    const name = getNodeLabel(nodes[b], b);
    if (tb === 'corridor') {
      if (typeof name === 'string' && /пересечение/i.test(name)) continue;
      const key = typeof name === 'string'
        ? name.toLowerCase().replace(/\s*\d+$/u, '').trim()
        : '';
      if (key && key === lastCorr) continue;
      parts.push(`Двигайтесь по коридору: ${name}`);
      lastCorr = key || null;
    }
    else if (tb === 'exit') parts.push(`Дойдите до выхода: ${name}`);
    else if (tb === 'door') parts.push(`Пройдите через дверь: ${name}`);
    else if (tb === 'room') { parts.push(`Дойдите до аудитории: ${name}`); lastCorr = null; }
  }
  return parts.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
}

function findDoorForRoom(roomId) {
  const neighbors = adj[roomId] || [];
  for (const e of neighbors) {
    const id = e.to;
    if (nodes[id]?.type === 'door' && isDoorConnectedToCorridor(id)) return id;
  }
  return null;
}

function primaryDoorForRoom(roomId, localDoorId) {
  const neighbors = adj[roomId] || [];
  const startDoors = [];
  neighbors.forEach(e => {
    const id = e.to;
    if (nodes[id]?.type === 'door') startDoors.push(id);
  });
  if (localDoorId && nodes[localDoorId]?.type === 'door' && !startDoors.includes(localDoorId)) {
    startDoors.unshift(localDoorId);
  }
  const visited = new Set();
  const queue = [...startDoors];
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const nb = adj[cur] || [];
    const hasCorr = nb.some(e => nodes[e.to]?.type === 'corridor');
    if (hasCorr) return cur;
    nb.forEach(e => {
      const to = e.to;
      if (!visited.has(to) && nodes[to]?.type === 'door') queue.push(to);
    });
  }
  return null;
}

function candidateDoorsNearNode(nodeId) {
  const res = new Set();
  if (!nodes[nodeId]) return [];
  if (nodes[nodeId].type === 'door') return [nodeId];
  if (nodes[nodeId].type === 'exit') return [nodeId];
  if (nodes[nodeId].type === 'stair') return [nodeId];
  if (nodes[nodeId].type === 'corridor') return [nodeId];
  if (nodes[nodeId].type === 'room') {
    if (!isRoomNavigable(nodeId)) return [];
    const list = candidateDoorsForRoom(nodeId);
    return list;
  }
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(48, 0.10 * Math.max(bb.width, bb.height));
  Object.keys(nodes).forEach(id => {
    if (nodes[id].type !== 'door') return;
    const d = dist(nodeId, id);
    if (d <= threshold) res.add(id);
  });
  const raw = Array.from(res);
  const filtered = raw.filter(id => {
    if (isDoorConnectedToCorridor(id)) return true;
    snapDoorToCorridor(id);
    return isDoorConnectedToCorridor(id);
  });
  return filtered.length ? filtered : raw;
}

function sortDoorsByDistance(nodeId, doors) {
  return [...doors].sort((a, b) => dist(nodeId, a) - dist(nodeId, b));
}
function doorCorridorDistance(doorId) {
  if (!nodes[doorId]) return Infinity;
  let best = Infinity;
  overlayCorrLines.forEach(line => {
    const pts = (line.points || []);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const { d } = projectOntoSegment(nodes[doorId].x, nodes[doorId].y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
  });
  return best;
}
function sortDoorsByCorridorProximity(doors) {
  return [...doors].sort((a, b) => doorCorridorDistance(a) - doorCorridorDistance(b));
}
function candidateDoorsForRoom(roomId) {
  const res = new Set();
  const neighbors = adj[roomId] || [];
  if (DEBUG_NAV) {
    console.log('🧭 candidateDoorsForRoom', {
      roomId,
      neighbors: neighbors.map(e => ({ to: e.to, type: nodes[e.to]?.type }))
    });
  }
  neighbors.forEach(e => {
    const id = e.to;
    if (nodes[id]?.type !== 'door') return;
    const ok = isDoorConnectedToCorridor(id);
    if (DEBUG_NAV) {
      console.log('🧭 candidateDoorsForRoom door check', {
        roomId,
        doorId: id,
        connectedToCorridor: ok
      });
    }
    if (ok) res.add(id);
  });
  if (!res.size && Array.isArray(autoEdgeBlocks) && autoEdgeBlocks.length) {
    Object.keys(nodes).forEach(id => {
      if (nodes[id].type !== 'door') return;
      if (!isAutoEdgeBlocked(id, roomId)) return;
      const ok = isDoorConnectedToCorridor(id);
      if (DEBUG_NAV) {
        console.log('🧭 candidateDoorsForRoom autoEdgeBlock door check', {
          roomId,
          doorId: id,
          blocked: true,
          connectedToCorridor: ok
        });
      }
      if (ok) res.add(id);
    });
  }
  if (!res.size) {
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
    const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
    const baseDim = Math.max(bb.width, bb.height);
    const threshold = isMobile() ? Math.max(192, 0.32 * baseDim) : Math.max(96, 0.16 * baseDim);
    const roomPos = getNodeCoordsSafe(roomId);
    if (roomPos) {
      let bestDoor = null;
      let bestD = Infinity;
      Object.keys(nodes).forEach(id => {
        if (nodes[id].type !== 'door') return;
        if (!isDoorConnectedToCorridor(id)) return;
        const d = dist(roomId, id);
        if (d < bestD && d <= threshold) {
          bestD = d;
          bestDoor = id;
        }
      });
      if (bestDoor) res.add(bestDoor);
    }
  }
  if (DEBUG_NAV) console.log('🧭 candidateDoorsForRoom result', { roomId, doors: Array.from(res) });
  return Array.from(res);
}

function candidateExitsNearRoom(roomId) {
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(64, 0.10 * Math.max(bb.width, bb.height));
  const res = [];
  Object.keys(nodes).forEach(id => {
    if (nodes[id].type !== 'exit') return;
    const d = dist(roomId, id);
    if (d <= threshold) res.push(id);
  });
  return res;
}

function extendPathToDoorGoal(startNodeId, doorId) {
  if (!nodes[doorId] || nodes[doorId].type !== 'door') return null;
  if (!nodes[startNodeId]) return null;
  if (startNodeId === doorId) return [startNodeId];
  const allowedTypes = new Set(['door', 'room', 'corridor']);
  const queue = [startNodeId];
  const visited = new Set([startNodeId]);
  const prev = {};
  while (queue.length) {
    const cur = queue.shift();
    if (cur === doorId) break;
    const edges = adj[cur] || [];
    for (const e of edges) {
      const to = e.to;
      if (visited.has(to)) continue;
      const t = nodes[to]?.type;
      if (!allowedTypes.has(t)) continue;
      if (t === 'door' && !isDoorConnectedToCorridor(to)) continue;
      visited.add(to);
      prev[to] = cur;
      queue.push(to);
    }
  }
  if (!visited.has(doorId)) return null;
  const chain = [];
  let cur = doorId;
  while (true) {
    chain.push(cur);
    if (cur === startNodeId) break;
    cur = prev[cur];
    if (!cur) break;
  }
  chain.reverse();
  return chain;
}

function validateRoute(route) {
  if (!Array.isArray(route)) return false;
  for (const id of route) {
    const node = nodes[id];
    if (node && node.type === 'door' && !isDoorConnectedToCorridor(id)) {
      return false;
    }
  }
  return true;
}

 
if (mapWrap) {
  ['touchmove'].forEach(ev => {
    mapWrap.addEventListener(ev, e => {
      const t = e.target;
      if (!t) return;
      if (t.closest('#zoom-controls') || t.closest('#zoom-slider')) return;
      if (!(t.closest('svg#map'))) return;
      e.preventDefault();
    }, { passive: false });
  });
}

let activeTouch = false;
let tp1 = null, tp2 = null, lastTouchCenter = null, lastTouchDist = null;
let startTouchX = null, startTouchY = null;
let suppressTapUntil = 0;
let lastGestureWasPinch = false;
let pinchAnchorWX = 0, pinchAnchorWY = 0;
let touchMoved = false;
let lastSinglePoint = null;
let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
function onTouchStart(e) {
  const t = e.target;
  if (t && (t.closest('#zoom-controls') || t.closest('#zoom-slider'))) return;
  if (!(t.closest('svg#map'))) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    const now = Date.now();
    const a = e.touches[0];
    const dt = now - lastTapTime;
    const dd = Math.abs(a.clientX - lastTapX) + Math.abs(a.clientY - lastTapY);
    if (dt < 300 && dd < 10) { lastTapTime = 0; return; }
    lastTapTime = now; lastTapX = a.clientX; lastTapY = a.clientY;
  }
  activeTouch = true;
  if (e.touches.length === 2) {
    const a = e.touches[0], b = e.touches[1];
    tp1 = { x: a.clientX, y: a.clientY };
    tp2 = { x: b.clientX, y: b.clientY };
    lastTouchCenter = { cx: (tp1.x + tp2.x) / 2, cy: (tp1.y + tp2.y) / 2 };
    const dx = tp1.x - tp2.x, dy = tp1.y - tp2.y;
    lastTouchDist = Math.hypot(dx, dy);
    const { wx, wy } = worldFromClient(lastTouchCenter.cx, lastTouchCenter.cy);
    pinchAnchorWX = wx;
    pinchAnchorWY = wy;
    lastGestureWasPinch = true;
  } else if (e.touches.length === 1) {
    const a = e.touches[0];
    tp1 = { x: a.clientX, y: a.clientY };
    lastSinglePoint = { x: a.clientX, y: a.clientY };
    touchMoved = false;
    startTouchX = a.clientX; startTouchY = a.clientY;
    const { ux, uy } = userFromClient(a.clientX, a.clientY);
    dragWorldX = (ux - offsetX) / scale;
    dragWorldY = (uy - offsetY) / scale;
  }
}
function onTouchMove(e) {
  const t = e.target;
  if (t && (t.closest('#zoom-controls') || t.closest('#zoom-slider'))) return;
  if (!(t.closest('svg#map'))) return;
  if (!activeTouch) return;
  if (e.touches.length === 2) {
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    tp1 = { x: a.clientX, y: a.clientY };
    tp2 = { x: b.clientX, y: b.clientY };
    const cx = (tp1.x + tp2.x) / 2;
    const cy = (tp1.y + tp2.y) / 2;
    const dx = tp1.x - tp2.x, dy = tp1.y - tp2.y;
    const d = Math.hypot(dx, dy);
    lastTouchCenter = { cx, cy };
    const raw = d / lastTouchDist;
    let newScale = clamp(scale * raw, minScale, maxScale);
    newScale = snapScale(newScale);
    const { ux, uy } = userFromClient(cx, cy);
    const { wx, wy } = worldFromClient(cx, cy);
    offsetX = ux - newScale * wx;
    offsetY = uy - newScale * wy;
    scale = newScale;
    lastGestureWasPinch = true;
    lastTouchDist = d;
    clampPan();
    applyTransform();
    if (zoomSlider) zoomSlider.value = String(scale);
  } else if (e.touches.length === 1 && tp1) {
    e.preventDefault();
    const a = e.touches[0];
    tp1 = { x: a.clientX, y: a.clientY };
    lastSinglePoint = { x: a.clientX, y: a.clientY };
    
    const moved = Math.hypot(a.clientX - startTouchX, a.clientY - startTouchY) > dragThreshold;
    if (!touchMoved && !moved) return;
    if (!touchMoved && moved) touchMoved = true;
    const { ux, uy } = userFromClient(a.clientX, a.clientY);
    offsetX = ux - scale * dragWorldX;
    offsetY = uy - scale * dragWorldY;
    clampPan();
    applyTransform();
    if (zoomSlider) zoomSlider.value = String(scale);
  }
}
function onTouchEnd(e) {
  if (!(e.target && e.target.closest('svg#map'))) return;
  if (e.touches.length === 0) {
    activeTouch = false; tp1 = tp2 = null; lastTouchCenter = null; lastTouchDist = null;
    startTouchX = null; startTouchY = null;
    if (lastGestureWasPinch) { suppressTapUntil = Date.now() + pinchTapSuppressMs; }
    lastGestureWasPinch = false;
    if (!touchMoved && lastSinglePoint && Date.now() > suppressTapUntil) {
      handleTapSelect(lastSinglePoint.x, lastSinglePoint.y);
      lastSinglePoint = null;
    }
  }
}
function onTouchCancel() {
  activeTouch = false; tp1 = tp2 = null; lastTouchCenter = null; lastTouchDist = null;
}
svg.addEventListener('touchstart', onTouchStart, { passive: false });
svg.addEventListener('touchmove', onTouchMove, { passive: false });
svg.addEventListener('touchend', onTouchEnd, { passive: true });
svg.addEventListener('touchcancel', onTouchCancel, { passive: true });

document.addEventListener('click', e => {
  if (Date.now() <= suppressTapUntil) {
    const t = e.target;
    if (t && t.closest('svg#map')) {
      e.preventDefault();
      e.stopPropagation();
      suppressTapUntil = 0;
    }
  }
}, { capture: true });

function zoomTo(factor) {
  const rect = svg.getBoundingClientRect();
  let centerClientX, centerClientY;
  if (typeof zoomAnchorX === 'number' && typeof zoomAnchorY === 'number') {
    centerClientX = zoomAnchorX; centerClientY = zoomAnchorY;
  } else if (lastTouchCenter && typeof lastTouchCenter.cx === 'number' && typeof lastTouchCenter.cy === 'number') {
    centerClientX = lastTouchCenter.cx;
    centerClientY = lastTouchCenter.cy;
  } else if (lastSinglePoint && typeof lastSinglePoint.x === 'number' && typeof lastSinglePoint.y === 'number') {
    centerClientX = lastSinglePoint.x;
    centerClientY = lastSinglePoint.y;
  } else {
    centerClientX = rect.left + rect.width / 2;
    centerClientY = rect.top + rect.height / 2;
  }
  const { ux, uy } = userFromClient(centerClientX, centerClientY);
  const { wx, wy } = worldFromClient(centerClientX, centerClientY);
  let newScale = clamp(scale * factor, minScale, maxScale);
  newScale = snapScale(newScale);
  offsetX = ux - newScale * wx;
  offsetY = uy - newScale * wy;
  scale = newScale;
  clampPan();
  applyTransform();
  if (zoomSlider) zoomSlider.value = String(scale);
}
function resetView() {
  scale = 1; offsetX = 0; offsetY = 0; applyTransform();
  if (zoomSlider) zoomSlider.value = String(scale);
}

function syncZoomSlider() {
  if (zoomSlider) zoomSlider.value = String(scale);
}
if (zoomSlider) {
  zoomSlider.min = String(minScale);
  zoomSlider.max = String(maxScale);
  zoomSlider.step = '0.01';
  zoomSlider.value = String(scale);
  zoomSlider.addEventListener('input', () => {
    const rect = svg.getBoundingClientRect();
    if (zoomAnchorX === null || zoomAnchorY === null) { zoomAnchorX = rect.left + rect.width / 2; zoomAnchorY = rect.top + rect.height / 2; }
    const target = parseFloat(zoomSlider.value || String(scale));
    let clamped = clamp(target, minScale, maxScale);
    clamped = snapScale(clamped);
    const factor = clamped / scale;
    zoomTo(factor);
    syncZoomSlider();
  }, {passive: true});
}

function handleTapSelect(x, y) {
  const el = document.elementFromPoint(x, y);
  let id = null;
  if (el) {
    const hit = el.closest('[data-node], .room[id], .corridor[id], .exit[id], .door[id], .anchor[id]');
    if (hit) id = ensureNodeFromElement(hit);
  }
  if (!id) {
    const { wx, wy } = worldFromClient(x, y);
    let best = null, bestD = Infinity;
    const candidates = Object.keys(nodes).filter(nid => nodes[nid].type !== 'anchor');
    candidates.forEach(nid => {
      const dx = nodes[nid].x - wx, dy = nodes[nid].y - wy;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = nid; }
    });
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
    const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
    const threshold = Math.max(28, 0.05 * Math.max(bb.width, bb.height));
    if (best && bestD <= threshold) {
      const overlaySet = new Set(overlayNodes.map(n => n.id));
      let bestOverlay = null, bestOverlayD = Infinity;
      overlayNodes.forEach(n => {
        const dx = n.x - wx, dy = n.y - wy;
        const d = Math.hypot(dx, dy);
        if (d < bestOverlayD) { bestOverlayD = d; bestOverlay = n.id; }
      });
      if (bestOverlay && bestOverlayD <= threshold && (!overlaySet.has(best) || bestOverlayD <= bestD + 1)) {
        id = bestOverlay;
      } else {
        id = best;
      }
    }
  }
  if (!id) return;
  deleteTargetId = id;
  highlightDeleteSelection(id);
  if (mode === 'start') { startId = id; setMode('goal'); } else { goalId = id; }
  updateSelection();
  renderOverlay();
  updateLabels();
  hintEl.textContent = mode === 'start'
    ? 'Кликните на карту, чтобы указать, где вы находитесь'
    : 'Теперь кликните на пункт назначения на карте';
  compute();
}
function mergeCorridorLinesToGraph() {
  if (!Array.isArray(overlayCorrLines)) return;
  overlayCorrLines.forEach(line => {
    const pts = (line.points || []);
    for (let i = 0; i < pts.length; i++) {
      const nid = `${line.id}_${i}`;
      if (!nodes[nid]) nodes[nid] = { x: pts[i].x, y: pts[i].y, floor: '1', type: 'corridor', name: line.name || 'Коридор' };
      if (!adj[nid]) adj[nid] = [];
      if (i > 0) {
        const pid = `${line.id}_${i - 1}`;
        addEdge(pid, nid, dist(pid, nid));
      }
    }
  });
}

function connectCorridorIntersections() {
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const ids = Object.keys(nodes).filter(id => nodes[id].type === 'corridor');
  const t = Math.max(18, 0.03 * Math.max(bb.width, bb.height));
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i];
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j];
      if (hasEdge(a, b)) continue;
      const d = dist(a, b);
      if (d <= t) addEdgeConstrained(a, b, d);
    }
  }
}

function projectOntoSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const vv = vx * vx + vy * vy;
  let t = vv > 0 ? (wx * vx + wy * vy) / vv : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * vx, qy = ay + t * vy;
  const d = Math.hypot(px - qx, py - qy);
  return { qx, qy, t, d };
}

function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const r1x = bx - ax, r1y = by - ay;
  const r2x = dx - cx, r2y = dy - cy;
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const qpx = cx - ax, qpy = cy - ay;
  const t = (qpx * r2y - qpy * r2x) / den;
  const u = (qpx * r1y - qpy * r1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: ax + t * r1x, y: ay + t * r1y };
}

function connectCorridorCrossings() {
  if (!Array.isArray(overlayCorrLines)) return;
  const nameForLine = id => {
    const l = (overlayCorrLines || []).find(x => x.id === id);
    return (l && l.name) ? l.name : 'Коридор';
  };
  for (let a = 0; a < overlayCorrLines.length; a++) {
    const la = overlayCorrLines[a];
    const pa = la.points || [];
    for (let i = 0; i < pa.length - 1; i++) {
      const a1 = pa[i], a2 = pa[i + 1];
      for (let b = a + 1; b < overlayCorrLines.length; b++) {
        const lb = overlayCorrLines[b];
        const pb = lb.points || [];
        for (let j = 0; j < pb.length - 1; j++) {
          const b1 = pb[j], b2 = pb[j + 1];
          const p = segIntersect(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y);
          if (!p) continue;
          const nid = `X_${la.id}_${i}_${lb.id}_${j}`;
          const nm = `Пересечение ${nameForLine(la.id)} × ${nameForLine(lb.id)}`;
          if (!nodes[nid]) nodes[nid] = { x: Math.round(p.x), y: Math.round(p.y), floor: '1', type: 'corridor', name: nm };
          if (!adj[nid]) adj[nid] = [];
          const aId = `${la.id}_${i}`;
          const aNext = `${la.id}_${i + 1}`;
          const bId = `${lb.id}_${j}`;
          const bNext = `${lb.id}_${j + 1}`;
          if (nodes[aId]) addEdgeConstrained(nid, aId, dist(nid, aId));
          if (nodes[aNext]) addEdgeConstrained(nid, aNext, dist(nid, aNext));
          if (nodes[bId]) addEdgeConstrained(nid, bId, dist(nid, bId));
          if (nodes[bNext]) addEdgeConstrained(nid, bNext, dist(nid, bNext));
        }
      }
    }
  }
}

function connectCorridorEndpoints() {
  if (!Array.isArray(overlayCorrLines)) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(16, 0.020 * Math.max(bb.width, bb.height));
  const corridorIds = Object.keys(nodes).filter(id => nodes[id].type === 'corridor');
  overlayCorrLines.forEach(line => {
    const pts = line.points || [];
    if (pts.length < 1) return;
    const ends = [`${line.id}_0`, `${line.id}_${pts.length - 1}`];
    ends.forEach(eid => {
      if (!nodes[eid]) return;
      let best = null, bestD = Infinity;
      for (const cid of corridorIds) {
        if (cid === eid) continue;
        const d = dist(eid, cid);
        if (d < bestD) { bestD = d; best = cid; }
      }
      if (best && bestD <= threshold && !hasEdge(eid, best)) addEdgeConstrained(eid, best, bestD);
    });
  });
}

function bridgeCorridorEndpointsToSegments() {
  if (!Array.isArray(overlayCorrLines)) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(14, 0.020 * Math.max(bb.width, bb.height));
  const nameForLine = id => {
    const l = (overlayCorrLines || []).find(x => x.id === id);
    return (l && l.name) ? l.name : 'Коридор';
  };
  overlayCorrLines.forEach(la => {
    const pa = la.points || [];
    if (pa.length < 1) return;
    const endIdx = [0, pa.length - 1];
    endIdx.forEach(idx => {
      const eid = `${la.id}_${idx}`;
      if (!nodes[eid]) return;
      let best = null;
      overlayCorrLines.forEach(lb => {
        if (lb.id === la.id) return;
        const pb = lb.points || [];
        for (let i = 0; i < pb.length - 1; i++) {
          const a = pb[i], b = pb[i + 1];
          const { qx, qy, d } = projectOntoSegment(nodes[eid].x, nodes[eid].y, a.x, a.y, b.x, b.y);
          if (!best || d < best.d) best = { lineId: lb.id, i, qx, qy, d };
        }
      });
      if (!best) return;
      if (best.d > threshold) return;
      const bid = `BR_${eid}_${best.lineId}_${best.i}`;
      const nm = nameForLine(best.lineId);
      if (!nodes[bid]) nodes[bid] = { x: Math.round(best.qx), y: Math.round(best.qy), floor: '1', type: 'corridor', name: nm };
      if (!adj[bid]) adj[bid] = [];
      const aId = `${best.lineId}_${best.i}`;
      const bId = `${best.lineId}_${best.i + 1}`;
      if (nodes[aId]) addEdgeConstrained(bid, aId, dist(bid, aId));
      if (nodes[bId]) addEdgeConstrained(bid, bId, dist(bid, bId));
      addEdgeConstrained(eid, bid, dist(eid, bid));
    });
  });
}

function bridgeCorridorPointsToSegments() {
  if (!Array.isArray(overlayCorrLines)) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(12, 0.020 * Math.max(bb.width, bb.height));
  const nameForLine = id => {
    const l = (overlayCorrLines || []).find(x => x.id === id);
    return (l && l.name) ? l.name : 'Коридор';
  };
  overlayCorrLines.forEach(la => {
    const pa = la.points || [];
    for (let idx = 1; idx < pa.length - 1; idx++) {
      const pid = `${la.id}_${idx}`;
      if (!nodes[pid]) continue;
      let best = null;
      overlayCorrLines.forEach(lb => {
        if (lb.id === la.id) return;
        const pb = lb.points || [];
        for (let i = 0; i < pb.length - 1; i++) {
          const a = pb[i], b = pb[i + 1];
          const { qx, qy, d } = projectOntoSegment(nodes[pid].x, nodes[pid].y, a.x, a.y, b.x, b.y);
          if (!best || d < best.d) best = { lineId: lb.id, i, qx, qy, d };
        }
      });
      if (!best) continue;
      if (best.d > threshold) continue;
      const aId = `${best.lineId}_${best.i}`;
      const bId = `${best.lineId}_${best.i + 1}`;
      if ((nodes[aId] && hasEdge(pid, aId)) || (nodes[bId] && hasEdge(pid, bId))) continue;
      const bid = `BRP_${pid}_${best.lineId}_${best.i}`;
      const nm = nameForLine(best.lineId);
      if (!nodes[bid]) nodes[bid] = { x: Math.round(best.qx), y: Math.round(best.qy), floor: '1', type: 'corridor', name: nm };
      if (!adj[bid]) adj[bid] = [];
      if (nodes[aId]) addEdgeConstrained(bid, aId, dist(bid, aId));
      if (nodes[bId]) addEdgeConstrained(bid, bId, dist(bid, bId));
      addEdgeConstrained(pid, bid, dist(pid, bid));
    }
  });
}

function snapDoorToCorridor(doorId, targetLineId = null, force = false) {
  const key = doorId + '|' + (targetLineId || '') + '|' + force;
  if (snapCache.has(key)) return snapCache.get(key);
  const door = nodes[doorId];
  if (!door) return null;
  if (!isDoorConnectedToCorridor(doorId)) return null;
  let best = null;
  const nameForLine = id => {
    const l = (overlayCorrLines || []).find(x => x.id === id);
    return (l && l.name) ? l.name : 'Коридор';
  };
  overlayCorrLines.forEach(line => {
    if (targetLineId && line.id !== targetLineId) return;
    const pts = (line.points || []);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const { qx, qy, t, d } = projectOntoSegment(door.x, door.y, a.x, a.y, b.x, b.y);
      if (!best || d < best.d) best = { lineId: line.id, i, t, d, qx, qy };
    }
  });
  if (!best) return null;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(48, 0.08 * Math.max(bb.width, bb.height));
  if (!force && best.d > threshold) return null;
  const aId = `${best.lineId}_${best.i}`;
  const bId = `${best.lineId}_${best.i + 1}`;
  const nearEndpoint = best.t <= 0.08 || best.t >= 0.92;
  const snapId = `SNAP_${doorId}_${best.lineId}_${best.i}`;
  if (isAutoEdgeBlocked(doorId, snapId)) {
    snapCache.set(key, null);
    return null;
  }
  const nm = nameForLine(best.lineId);
  if (!nodes[snapId]) nodes[snapId] = { x: Math.round(best.qx), y: Math.round(best.qy), floor: '1', type: 'corridor', name: nm };
  if (!adj[snapId]) adj[snapId] = [];
  if (nodes[aId]) addEdgeConstrained(snapId, aId, dist(snapId, aId));
  if (nodes[bId]) addEdgeConstrained(snapId, bId, dist(snapId, bId));
  addEdgeConstrained(doorId, snapId, dist(doorId, snapId));
  snapCache.set(key, snapId);
  return snapId;
}

function snapDoorChainToCorridor(doorId, targetLineId = null, force = false) {
  const direct = snapDoorToCorridor(doorId, targetLineId, force);
  if (direct) return direct;
  const visited = new Set();
  const queue = [];
  visited.add(doorId);
  queue.push(doorId);
  while (queue.length) {
    const cur = queue.shift();
    const neighbors = adj[cur] || [];
    for (const e of neighbors) {
      const to = e.to;
      if (visited.has(to)) continue;
      if (nodes[to]?.type !== 'door') continue;
      visited.add(to);
      const snap = snapDoorToCorridor(to, targetLineId, force);
      if (snap) return snap;
      queue.push(to);
    }
  }
  return null;
}

function doorIdFromSnap(snapId) {
  const parts = String(snapId).split('_');
  if (parts.length < 5) return null;
  if (parts[0] !== 'SNAP') return null;
  return `${parts[1]}_${parts[2]}`;
}

function snapExitToCorridor(exitId, targetLineId, force) {
  const ex = nodes[exitId];
  if (!ex) return;
  let best = null;
  const nameForLine = id => {
    const l = (overlayCorrLines || []).find(x => x.id === id);
    return (l && l.name) ? l.name : 'Коридор';
  };
  overlayCorrLines.forEach(line => {
    if (targetLineId && line.id !== targetLineId) return;
    const pts = (line.points || []);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const { qx, qy, t, d } = projectOntoSegment(ex.x, ex.y, a.x, a.y, b.x, b.y);
      if (!best || d < best.d) best = { lineId: line.id, i, t, qx, qy, d };
    }
  });
  if (!best) return;
  const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { x: 0, y: 0, width: 800, height: 500 };
  const bb = typeof viewport.getBBox === 'function' ? viewport.getBBox() : { x: 0, y: 0, width: vb.width, height: vb.height };
  const threshold = Math.max(48, 0.08 * Math.max(bb.width, bb.height));
  if (!force && best.d > threshold) return;
  const aId = `${best.lineId}_${best.i}`;
  const bId = `${best.lineId}_${best.i + 1}`;
  const nearEndpoint = (best.t <= 0.08 || best.t >= 0.92);
  const snapId = `SNAPX_${exitId}_${best.lineId}_${best.i}`;
  const nm = nameForLine(best.lineId);
  if (!nodes[snapId]) nodes[snapId] = { x: Math.round(best.qx), y: Math.round(best.qy), floor: '1', type: 'corridor', name: nm };
  if (!adj[snapId]) adj[snapId] = [];
  if (nodes[aId]) addEdgeConstrained(snapId, aId, dist(snapId, aId));
  if (nodes[bId]) addEdgeConstrained(snapId, bId, dist(snapId, bId));
  addEdgeConstrained(exitId, snapId, dist(exitId, snapId));
  return snapId;
}

function corridorPathBetweenSnaps(sSnap, gSnap) {
  if (!nodes[sSnap] || !nodes[gSnap]) return null;
  const partsA = String(sSnap).split('_');
  const partsB = String(gSnap).split('_');
  if (partsA.length < 3 || partsB.length < 3) return null;
  const iA = parseInt(partsA[partsA.length - 1], 10);
  const lineA = partsA[partsA.length - 2];
  const iB = parseInt(partsB[partsB.length - 1], 10);
  const lineB = partsB[partsB.length - 2];
  if (!isFinite(iA) || !isFinite(iB)) return null;
  if (lineA !== lineB) return null;
  if (iA === iB) return [sSnap, gSnap];
  const seq = [];
  if (iB > iA) {
    for (let k = iA + 1; k <= iB; k++) {
      const id = `${lineA}_${k}`;
      if (!nodes[id]) return null;
      seq.push(id);
    }
  } else {
    for (let k = iA; k >= iB; k--) {
      const id = `${lineA}_${k}`;
      if (!nodes[id]) return null;
      seq.push(id);
    }
  }
  return [sSnap, ...seq, gSnap];
}

function corridorPathViaCrossings(sSnap, gSnap) {
  return null;
}
function corridorPathViaBridges(sSnap, gSnap) {
  return null;
}
function corridorPathBetweenNodes(a, b) {
  const pa = String(a).match(/^([^_]+)_(\d+)$/);
  const pb = String(b).match(/^([^_]+)_(\d+)$/);
  if (!pa || !pb) return null;
  const la = pa[1], ia = parseInt(pa[2], 10);
  const lb = pb[1], ib = parseInt(pb[2], 10);
  if (!isFinite(ia) || !isFinite(ib)) return null;
  if (la !== lb) return null;
  const seq = [];
  if (ib >= ia) {
    for (let k = ia; k <= ib; k++) {
      const id = `${la}_${k}`;
      if (!nodes[id]) return null;
      seq.push(id);
    }
  } else {
    for (let k = ia; k >= ib; k--) {
      const id = `${la}_${k}`;
      if (!nodes[id]) return null;
      seq.push(id);
    }
  }
  return seq;
}
function parseCorrLine(id) {
  const s = String(id);
  const parts = s.split('_');
  const cl = parts.find(p => p.startsWith('CL'));
  if (cl) return cl;
  return null;
}
function nearestLineIndex(lineId, nodeId) {
  if (!nodes[nodeId]) return null;
  let bestIdx = null, bestD = Infinity;
  let k = 0;
  while (nodes[`${lineId}_${k}`]) {
    const id = `${lineId}_${k}`;
    const d = dist(nodeId, id);
    if (d < bestD) { bestD = d; bestIdx = k; }
    k++;
  }
  return bestIdx;
}
function corridorPathBetweenAnchors(a, b) {
  if (!nodes[a] || !nodes[b]) return [a, b];
  const la = parseCorrLine(a);
  const lb = parseCorrLine(b);
  const lineId = la || lb;
  if (!lineId || !Array.isArray(overlayCorrLines)) return [a, b];
  const line = overlayCorrLines.find(l => l.id === lineId);
  if (!line || !Array.isArray(line.points) || line.points.length < 2) return [a, b];

  // Линейная привязка якорей к polyline коридора
  const pts = line.points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum[i] = cum[i - 1] + d;
  }

  const projectOnLine = node => {
    let best = { s: 0, dist: Infinity, segIndex: 0, t: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1];
      const pr = projectOntoSegment(node.x, node.y, A.x, A.y, B.x, B.y);
      const segLen = Math.hypot(B.x - A.x, B.y - A.y);
      const s = cum[i] + pr.t * segLen;
      if (pr.d < best.dist) {
        best = { s, dist: pr.d, segIndex: i, t: pr.t };
      }
    }
    return best;
  };

  const na = nodes[a];
  const nb = nodes[b];
  const pa = projectOnLine(na);
  const pb = projectOnLine(nb);
  const tol = 6;
  if (pa.dist > tol || pb.dist > tol) return [a, b];

  const sMin = Math.min(pa.s, pb.s);
  const sMax = Math.max(pa.s, pb.s);

  if (DEBUG_NAV) {
    console.log('🧭 corridor anchors', {
      from: a,
      to: b,
      lineId,
      sFrom: pa.s,
      sTo: pb.s,
      sMin,
      sMax
    });
  }

  return [a, b];
}
function reconstructCorridorByAnchors(path) {
  if (!Array.isArray(path) || path.length < 2) return path;
  const out = [];
  let i = 0;
  const isCLPoint = id => /^CL[^_]*_\d+$/.test(String(id));
  while (i < path.length) {
    const curId = path[i];
    const curNode = nodes[curId];
    if (!curNode || curNode.type !== 'corridor') {
      out.push(curId);
      i++;
      continue;
    }
    const lineId = parseCorrLine(curId);
    if (!lineId) {
      out.push(curId);
      i++;
      continue;
    }
    let j = i;
    const blockIds = [];
    while (j < path.length) {
      const id = path[j];
      const n = nodes[id];
      if (!n || n.type !== 'corridor') break;
      const lj = parseCorrLine(id);
      if (lj !== lineId) break;
      blockIds.push(id);
      j++;
    }
    const hasLocal = blockIds.some(id => {
      const n = nodes[id];
      if (!n || n.type !== 'corridor') return false;
      const s = String(id);
      return /^(SNAP_|SNAPX_|X_|BR_|BRP_)/.test(s);
    });
    const clIds = blockIds.filter(isCLPoint);
    if (!hasLocal && clIds.length >= 2) {
      const startCL = clIds[0];
      const endCL = clIds[clIds.length - 1];
      const anchors = corridorPathBetweenAnchors(startCL, endCL);
      const pair = (anchors && anchors.length === 2) ? anchors : [startCL, endCL];
      if (!out.length || out[out.length - 1] !== pair[0]) {
        out.push(pair[0]);
      }
      if (pair[1] !== pair[0]) out.push(pair[1]);
    } else {
      for (const id of blockIds) out.push(id);
    }
    i = j;
  }
  return out;
}
function nearestCorrLine(clientX, clientY) {
  const { wx, wy } = worldFromClient(clientX, clientY);
  let best = null;
  overlayCorrLines.forEach(line => {
    const pts = (line.points || []);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const { d } = projectOntoSegment(wx, wy, a.x, a.y, b.x, b.y);
      if (!best || d < best.d) best = { id: line.id, d, i, a, b };
    }
  });
  return best;
}
function nearestOverlayEdge(clientX, clientY) {
  const { wx, wy } = worldFromClient(clientX, clientY);
  let best = null;
  const seen = new Set();
  overlayEdges.forEach(e => {
    const A = nodes[e.a];
    const B = nodes[e.b];
    if (!A || !B) return;
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    if (seen.has(key)) return; seen.add(key);
    const { d } = projectOntoSegment(wx, wy, A.x, A.y, B.x, B.y);
    if (!best || d < best.d) best = { key, d };
  });
  return best;
}

function deleteOverlayEdgeByKey(key) {
  let deleted = null;
  overlayEdges.forEach(e => {
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    if (k === key) deleted = e;
  });
  overlayEdges = overlayEdges.filter(e => {
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    return k !== key;
  });
  if (deleted && deleted.auto) {
    const ka = baseId(deleted.a), kb = baseId(deleted.b);
    const bk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (!autoEdgeBlocks.includes(bk)) {
      autoEdgeBlocks.push(bk);
      persistWrite('navAutoEdgeBlocks', autoEdgeBlocks);
    }
  }
  persistWrite('navOverlayEdges', overlayEdges);
  renderOverlay();
  buildGraph();
  stepsEl.textContent = 'Связь удалена';
}
function getContentBBox() {
  if (contentBBoxCache) return contentBBoxCache;
  const bb = typeof viewport.getBBox === 'function'
    ? viewport.getBBox()
    : { x: 0, y: 0, width: 800, height: 500 };
  contentBBoxCache = bb;
  return bb;
}

function snapScale(s) {
  return s;
}

function centerContent() {}
