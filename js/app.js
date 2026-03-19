/* ==========================================================================
   Rust Blueprint Designer — app.js
   All logic in one file, plain ES5-compatible vanilla JS.
   ========================================================================== */

'use strict';

/* ── CONSTANTS ────────────────────────────────────────────────────────────── */

var CELL_SIZE   = 64;   // px at zoom=1
var MIN_ZOOM    = 0.25;
var MAX_ZOOM    = 4;
var WALL_THRESH = 0.18; // fraction of cell size used as wall-click detection band

var MATERIALS = {
  wood:    { fill: '#6b4c1a', stroke: '#4a3310', name: 'Wood'        },
  stone:   { fill: '#4d5359', stroke: '#363c41', name: 'Stone'       },
  metal:   { fill: '#2d6b8a', stroke: '#1e4d65', name: 'Sheet Metal' },
  armored: { fill: '#223d50', stroke: '#162835', name: 'Armored'     }
};

var DOOR_COLORS = {
  sheet:   '#78afc7',
  armored: '#8090a0',
  garage:  '#c09030'
};

/*
 * Raid costs in rockets (primary unit).
 * Source: approximate real-game values, widely cited in community guides.
 *   Wall  : wood=2  stone=4  metal=8  armored=15
 *   Door  : sheet=1 armored=3 garage=2  (single/double treated the same; garage a bit cheaper)
 * Satchel conversions: wood≈3 stone≈10 metal≈23 armored≈46
 * C4 conversions:      wall×0.5 rounded up (C4 does ~550 dmg each)
 */
var RAID_COSTS = {
  wall: {
    wood:    { rockets: 2,  satchels: 3,  c4: 1  },
    stone:   { rockets: 4,  satchels: 10, c4: 2  },
    metal:   { rockets: 8,  satchels: 23, c4: 4  },
    armored: { rockets: 15, satchels: 46, c4: 8  }
  },
  door: {
    sheet:   { rockets: 1,  satchels: 4,  c4: 1  },
    armored: { rockets: 3,  satchels: 12, c4: 2  },
    garage:  { rockets: 2,  satchels: 9,  c4: 1  }
  }
};

/* ── STATE ────────────────────────────────────────────────────────────────── */

/*
 * Data model for one floor:
 *   cells : { "x,y" : { type, material, halfFloor } }
 *   walls : { wallKey : { doorType, doorMaterial } }
 *     wallKey format:
 *       horizontal wall above row r at column c : "h|c|r"
 *       vertical wall left of column c at row r : "v|c|r"
 *   isHalfFloor : boolean (flag for the whole floor)
 *
 * cell.type values:
 *   "square" | "tri-ne" | "tri-nw" | "tri-sw" | "tri-se"
 *
 * door types  : "single" | "double" | "garage"
 * door materials: "sheet" | "armored"
 */

var state = {
  floors:      [ makeFloor() ],
  currentFloor: 0,
  tcCell:      null,           // { floor, x, y }

  tool:        'square',
  material:    'stone',
  orientation: 'ne',           // triangle orientation
  doorType:    'single',
  doorMaterial:'sheet',

  zoom: 1,
  panX: 0,
  panY: 0,

  /* drag / pan state */
  _drag:   false,
  _erase:  false,
  _pan:    false,
  _panAnchorX: 0,
  _panAnchorY: 0,

  /* hover wall highlight */
  _hoverWall: null   // { x, y, dir }
};

function makeFloor() {
  return { cells: {}, walls: {}, isHalfFloor: false };
}

/* ── WALL KEY HELPERS ─────────────────────────────────────────────────────── */

/*
 * Each wall segment has a unique canonical key:
 *   Horizontal wall between row (r-1) and row r at column c  →  "h|c|r"
 *   Vertical wall between col (c-1) and col c at row r       →  "v|c|r"
 *
 * From a cell (cx, cy) and direction:
 *   north → horizontal wall above row cy  → "h|cx|cy"
 *   south → horizontal wall above row cy+1 → "h|cx|cy+1"  (= north of cell below)
 *   west  → vertical wall left of col cx  → "v|cx|cy"
 *   east  → vertical wall left of col cx+1 → "v|cx+1|cy" (= west of cell to right)
 */
function wallKey(cx, cy, dir) {
  if (dir === 'n') return 'h|' + cx + '|' + cy;
  if (dir === 's') return 'h|' + cx + '|' + (cy + 1);
  if (dir === 'w') return 'v|' + cx + '|' + cy;
  if (dir === 'e') return 'v|' + (cx + 1) + '|' + cy;
  return null;
}

function getWall(floorIdx, cx, cy, dir) {
  return state.floors[floorIdx].walls[wallKey(cx, cy, dir)] || null;
}

function setWall(floorIdx, cx, cy, dir, data) {
  var k = wallKey(cx, cy, dir);
  if (data === null) {
    delete state.floors[floorIdx].walls[k];
  } else {
    state.floors[floorIdx].walls[k] = data;
  }
}

/* Segment geometry for a wall on cell (cx,cy) side dir — in CELL units */
function wallSegment(cx, cy, dir) {
  if (dir === 'n') return { x1: cx,   y1: cy,   x2: cx+1, y2: cy   };
  if (dir === 's') return { x1: cx,   y1: cy+1, x2: cx+1, y2: cy+1 };
  if (dir === 'w') return { x1: cx,   y1: cy,   x2: cx,   y2: cy+1 };
  if (dir === 'e') return { x1: cx+1, y1: cy,   x2: cx+1, y2: cy+1 };
  return null;
}

/* Neighbour cell in direction dir */
function neighbour(cx, cy, dir) {
  if (dir === 'n') return { x: cx,   y: cy-1 };
  if (dir === 's') return { x: cx,   y: cy+1 };
  if (dir === 'w') return { x: cx-1, y: cy   };
  if (dir === 'e') return { x: cx+1, y: cy   };
  return null;
}

/* ── GRID OPERATIONS ──────────────────────────────────────────────────────── */

function cellKey(x, y) { return x + ',' + y; }

function getCell(floorIdx, x, y) {
  return state.floors[floorIdx].cells[cellKey(x, y)] || null;
}

function setCell(floorIdx, x, y, data) {
  if (data === null) {
    delete state.floors[floorIdx].cells[cellKey(x, y)];
  } else {
    state.floors[floorIdx].cells[cellKey(x, y)] = data;
  }
}

function placeCell(x, y) {
  var fi   = state.currentFloor;
  var floor = state.floors[fi];
  if (floor.cells[cellKey(x, y)]) return; // occupied
  var type = (state.tool === 'triangle') ? ('tri-' + state.orientation) : 'square';
  setCell(fi, x, y, { type: type, material: state.material, halfFloor: false });
}

function eraseCell(x, y) {
  var fi = state.currentFloor;
  if (!state.floors[fi].cells[cellKey(x, y)]) return;
  /* remove TC if it was here */
  if (state.tcCell && state.tcCell.floor === fi &&
      state.tcCell.x === x && state.tcCell.y === y) {
    state.tcCell = null;
  }
  setCell(fi, x, y, null);
  /* remove doors on all edges */
  ['n','e','s','w'].forEach(function(d) { setWall(fi, x, y, d, null); });
}

function placeTC(x, y) {
  var fi   = state.currentFloor;
  var cell = getCell(fi, x, y);
  if (!cell) return;
  state.tcCell = { floor: fi, x: x, y: y };
}

function toggleDoor(x, y, dir) {
  var fi   = state.currentFloor;
  var cell = getCell(fi, x, y);
  var nb   = neighbour(x, y, dir);
  var nbc  = getCell(fi, nb.x, nb.y);
  if (!cell && !nbc) return; // no foundation on either side
  var existing = getWall(fi, x, y, dir);
  if (existing) {
    setWall(fi, x, y, dir, null);
  } else {
    setWall(fi, x, y, dir, { doorType: state.doorType, doorMaterial: state.doorMaterial });
  }
}

/* shorthand */
function floor(fi) { return state.floors[fi]; }

/* ── COORDINATE HELPERS ───────────────────────────────────────────────────── */

function canvasToWorld(cx, cy) {
  return {
    wx: (cx - state.panX) / state.zoom,
    wy: (cy - state.panY) / state.zoom
  };
}

function worldToCell(wx, wy) {
  return {
    x: Math.floor(wx / CELL_SIZE),
    y: Math.floor(wy / CELL_SIZE)
  };
}

/*
 * Detect which wall side (if any) is near the mouse.
 * Returns { x, y, dir } or null.
 */
function detectWall(canvasX, canvasY) {
  var w   = canvasToWorld(canvasX, canvasY);
  var gx  = w.wx / CELL_SIZE;
  var gy  = w.wy / CELL_SIZE;
  var cx  = Math.floor(gx);
  var cy  = Math.floor(gy);
  var lx  = gx - cx;   // 0..1 within cell
  var ly  = gy - cy;

  var t = WALL_THRESH;
  if (ly < t)     return { x: cx, y: cy, dir: 'n' };
  if (ly > 1 - t) return { x: cx, y: cy, dir: 's' };
  if (lx < t)     return { x: cx, y: cy, dir: 'w' };
  if (lx > 1 - t) return { x: cx, y: cy, dir: 'e' };
  return null;
}

/* ── RENDERER ─────────────────────────────────────────────────────────────── */

var canvas, ctx;

function initCanvas() {
  canvas = document.getElementById('grid-canvas');
  ctx    = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  var wrap    = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  render();
}

function render() {
  if (!ctx) return;
  var W = canvas.width, H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  /* Background */
  ctx.fillStyle = '#080c11';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);

  drawGrid();
  drawCells();
  drawWalls();
  drawTC();
  drawHoverWall();

  ctx.restore();

  drawOverlay();
}

/* faint dot-grid */
function drawGrid() {
  var lw = 1 / state.zoom;

  /* visible world bounds */
  var x0 = -state.panX / state.zoom;
  var y0 = -state.panY / state.zoom;
  var x1 = (canvas.width  - state.panX) / state.zoom;
  var y1 = (canvas.height - state.panY) / state.zoom;

  var cxStart = Math.floor(x0 / CELL_SIZE) - 1;
  var cyStart = Math.floor(y0 / CELL_SIZE) - 1;
  var cxEnd   = Math.ceil(x1  / CELL_SIZE) + 1;
  var cyEnd   = Math.ceil(y1  / CELL_SIZE) + 1;

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = lw;

  for (var gx = cxStart; gx <= cxEnd; gx++) {
    ctx.beginPath();
    ctx.moveTo(gx * CELL_SIZE, cyStart * CELL_SIZE);
    ctx.lineTo(gx * CELL_SIZE, cyEnd   * CELL_SIZE);
    ctx.stroke();
  }
  for (var gy = cyStart; gy <= cyEnd; gy++) {
    ctx.beginPath();
    ctx.moveTo(cxStart * CELL_SIZE, gy * CELL_SIZE);
    ctx.lineTo(cxEnd   * CELL_SIZE, gy * CELL_SIZE);
    ctx.stroke();
  }
}

function drawCells() {
  var fl = floor(state.currentFloor);
  Object.keys(fl.cells).forEach(function(k) {
    var cell = fl.cells[k];
    var parts = k.split(',');
    var x = parseInt(parts[0], 10);
    var y = parseInt(parts[1], 10);
    drawCell(x, y, cell, fl.isHalfFloor || cell.halfFloor);
  });
}

function drawCell(x, y, cell, isHalf) {
  var mat = MATERIALS[cell.material] || MATERIALS.stone;
  var bx  = x * CELL_SIZE;
  var by  = y * CELL_SIZE;
  var cs  = CELL_SIZE;

  ctx.fillStyle   = mat.fill;
  ctx.strokeStyle = mat.stroke;
  ctx.lineWidth   = 1.5 / state.zoom;

  if (cell.type === 'square') {
    ctx.fillRect(bx + 1, by + 1, cs - 2, cs - 2);
    ctx.strokeRect(bx + 1, by + 1, cs - 2, cs - 2);
  } else {
    drawTriangleCell(ctx, bx, by, cs, cell.type, mat);
  }

  /* half-floor stripe */
  if (isHalf) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(bx + 1, by + 1, cs - 2, (cs - 2) * 0.3);
    if (state.zoom >= 0.55) {
      ctx.fillStyle    = 'rgba(255,255,255,0.55)';
      ctx.font         = 'bold ' + (10 / state.zoom) + 'px sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('½', bx + cs * 0.5, by + cs * 0.18);
    }
  }
}

function drawTriangleCell(ctx, bx, by, cs, type, mat) {
  ctx.beginPath();
  switch (type) {
    case 'tri-ne':
      ctx.moveTo(bx,      by);
      ctx.lineTo(bx + cs, by);
      ctx.lineTo(bx + cs, by + cs);
      break;
    case 'tri-nw':
      ctx.moveTo(bx,      by);
      ctx.lineTo(bx + cs, by);
      ctx.lineTo(bx,      by + cs);
      break;
    case 'tri-sw':
      ctx.moveTo(bx,      by);
      ctx.lineTo(bx,      by + cs);
      ctx.lineTo(bx + cs, by + cs);
      break;
    case 'tri-se':
      ctx.moveTo(bx + cs, by);
      ctx.lineTo(bx + cs, by + cs);
      ctx.lineTo(bx,      by + cs);
      break;
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/* ── WALL / DOOR RENDERING ────────────────────────────────────────────────── */

function drawWalls() {
  var fi    = state.currentFloor;
  var fl    = floor(fi);
  var drawn = {};

  Object.keys(fl.cells).forEach(function(k) {
    var parts = k.split(',');
    var cx = parseInt(parts[0], 10);
    var cy = parseInt(parts[1], 10);
    var cell = fl.cells[k];

    ['n', 'e', 's', 'w'].forEach(function(dir) {
      var wk = wallKey(cx, cy, dir);
      if (drawn[wk]) return;
      drawn[wk] = true;

      var seg = wallSegment(cx, cy, dir);
      var x1  = seg.x1 * CELL_SIZE;
      var y1  = seg.y1 * CELL_SIZE;
      var x2  = seg.x2 * CELL_SIZE;
      var y2  = seg.y2 * CELL_SIZE;

      var nb    = neighbour(cx, cy, dir);
      var nbCell = fl.cells[cellKey(nb.x, nb.y)] || null;
      var wallData = fl.walls[wk] || null;
      var mat  = MATERIALS[(nbCell || cell).material] || MATERIALS.stone;

      if (wallData && wallData.doorType) {
        renderDoor(x1, y1, x2, y2, wallData);
      } else {
        ctx.strokeStyle = mat.stroke;
        ctx.lineWidth   = 3.5 / state.zoom;
        ctx.lineCap     = 'square';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    });
  });
}

function renderDoor(x1, y1, x2, y2, wd) {
  var color   = DOOR_COLORS[wd.doorMaterial] || DOOR_COLORS.sheet;
  var midX    = (x1 + x2) / 2;
  var midY    = (y1 + y2) / 2;
  var dx      = x2 - x1;
  var dy      = y2 - y1;
  var len     = Math.sqrt(dx * dx + dy * dy);
  var ux      = dx / len;
  var uy      = dy / len;

  /* door width depends on type */
  var fraction = wd.doorType === 'single' ? 0.45
               : wd.doorType === 'double' ? 0.75
               : 0.88; /* garage */
  var hw = (CELL_SIZE * fraction) / 2;

  /* wall stubs on each side */
  ctx.strokeStyle = MATERIALS.stone.stroke;
  ctx.lineWidth   = 3.5 / state.zoom;
  ctx.lineCap     = 'square';

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(midX - ux * hw, midY - uy * hw);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(midX + ux * hw, midY + uy * hw);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  /* door segment */
  ctx.strokeStyle = color;
  ctx.lineWidth   = 5 / state.zoom;
  ctx.beginPath();
  ctx.moveTo(midX - ux * hw, midY - uy * hw);
  ctx.lineTo(midX + ux * hw, midY + uy * hw);
  ctx.stroke();

  /* door label */
  if (state.zoom >= 0.5) {
    var label = wd.doorType === 'single' ? 'S'
              : wd.doorType === 'double' ? 'D'
              : 'G';
    var perpX = -uy * (13 / state.zoom);
    var perpY =  ux * (13 / state.zoom);
    ctx.fillStyle    = color;
    ctx.font         = 'bold ' + (10 / state.zoom) + 'px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX + perpX, midY + perpY);
  }
}

function drawTC() {
  if (!state.tcCell) return;
  if (state.tcCell.floor !== state.currentFloor) return;

  var x  = state.tcCell.x;
  var y  = state.tcCell.y;
  var bx = x * CELL_SIZE;
  var by = y * CELL_SIZE;
  var cs = CELL_SIZE;

  /* golden border */
  ctx.strokeStyle = '#f0a500';
  ctx.lineWidth   = 3 / state.zoom;
  ctx.strokeRect(bx + 3, by + 3, cs - 6, cs - 6);

  /* TC label */
  if (state.zoom >= 0.35) {
    ctx.fillStyle    = '#f0a500';
    ctx.font         = 'bold ' + (13 / state.zoom) + 'px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TC', bx + cs / 2, by + cs * 0.65);
  }
}

/* dim highlight of the wall the user is hovering when door tool is active */
function drawHoverWall() {
  if (state.tool !== 'door') return;
  var hw = state._hoverWall;
  if (!hw) return;
  var seg = wallSegment(hw.x, hw.y, hw.dir);
  ctx.strokeStyle = 'rgba(255,165,0,0.55)';
  ctx.lineWidth   = 8 / state.zoom;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(seg.x1 * CELL_SIZE, seg.y1 * CELL_SIZE);
  ctx.lineTo(seg.x2 * CELL_SIZE, seg.y2 * CELL_SIZE);
  ctx.stroke();
}

/* top-left overlay (floor label) drawn in canvas-space, after ctx.restore() */
function drawOverlay() {
  ctx.fillStyle    = 'rgba(255,255,255,0.25)';
  ctx.font         = '13px sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';
  var fl = floor(state.currentFloor);
  var label = 'Floor ' + (state.currentFloor + 1) + ' / ' + state.floors.length;
  if (fl.isHalfFloor) label += '  [Half Floor]';
  ctx.fillText(label, 10, 10);
}

/* ── EVENT HANDLING ───────────────────────────────────────────────────────── */

function initEvents() {
  /* ── canvas ── */
  canvas.addEventListener('mousedown',    onMouseDown);
  canvas.addEventListener('mousemove',    onMouseMove);
  canvas.addEventListener('mouseup',      onMouseUp);
  canvas.addEventListener('mouseleave',   onMouseUp);
  canvas.addEventListener('wheel',        onWheel, { passive: false });
  canvas.addEventListener('contextmenu',  function(e) { e.preventDefault(); });

  /* ── tool buttons ── */
  document.querySelectorAll('.tool-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tool-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      syncToolUI();
    });
  });

  document.querySelectorAll('.orient-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.orient-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.orientation = btn.dataset.orient;
    });
  });

  document.querySelectorAll('.mat-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.mat-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.material = btn.dataset.mat;
    });
  });

  document.querySelectorAll('.dtype-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.dtype-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.doorType = btn.dataset.dtype;
    });
  });

  document.querySelectorAll('.dmat-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.dmat-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.doorMaterial = btn.dataset.dmat;
    });
  });

  /* ── floor controls ── */
  document.getElementById('btn-prev-floor').addEventListener('click', function() {
    if (state.currentFloor > 0) { state.currentFloor--; syncFloorUI(); }
  });

  document.getElementById('btn-next-floor').addEventListener('click', function() {
    if (state.currentFloor < state.floors.length - 1) { state.currentFloor++; syncFloorUI(); }
  });

  document.getElementById('btn-add-floor').addEventListener('click', function() {
    if (state.floors.length >= 12) return;
    state.floors.push(makeFloor());
    state.currentFloor = state.floors.length - 1;
    syncFloorUI();
  });

  document.getElementById('btn-remove-floor').addEventListener('click', function() {
    if (state.floors.length <= 1) return;
    /* remove TC if it was on this floor */
    if (state.tcCell && state.tcCell.floor === state.currentFloor) state.tcCell = null;
    /* adjust TC floor index if it was above the removed floor */
    if (state.tcCell && state.tcCell.floor > state.currentFloor) state.tcCell.floor--;
    state.floors.splice(state.currentFloor, 1);
    if (state.currentFloor >= state.floors.length) state.currentFloor = state.floors.length - 1;
    syncFloorUI();
  });

  document.getElementById('half-floor-toggle').addEventListener('change', function(e) {
    floor(state.currentFloor).isHalfFloor = e.target.checked;
    render();
  });

  /* ── action buttons ── */
  document.getElementById('btn-clear-floor').addEventListener('click', function() {
    if (!confirm('Clear all foundations on this floor?')) return;
    if (state.tcCell && state.tcCell.floor === state.currentFloor) state.tcCell = null;
    state.floors[state.currentFloor] = makeFloor();
    syncFloorUI();
  });

  document.getElementById('btn-clear-all').addEventListener('click', function() {
    if (!confirm('Clear ALL floors?')) return;
    state.floors = [ makeFloor() ];
    state.currentFloor = 0;
    state.tcCell = null;
    syncFloorUI();
  });

  /* ── raid calculator ── */
  document.getElementById('btn-calc-raid').addEventListener('click', doRaidCalc);
}

/* ── mouse handlers ── */

function onMouseDown(e) {
  e.preventDefault();
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left;
  var my = e.clientY - rect.top;

  /* middle-click or alt+left → pan */
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    state._pan = true;
    state._panAnchorX = mx - state.panX;
    state._panAnchorY = my - state.panY;
    canvas.style.cursor = 'grabbing';
    return;
  }

  /* right-click → erase */
  if (e.button === 2) {
    state._erase = true;
    handleErase(mx, my);
    render(); updateStats();
    return;
  }

  /* left-click → active tool */
  if (e.button === 0) {
    state._drag = true;
    handlePlace(mx, my);
    render(); updateStats();
  }
}

function onMouseMove(e) {
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left;
  var my = e.clientY - rect.top;

  if (state._pan) {
    state.panX = mx - state._panAnchorX;
    state.panY = my - state._panAnchorY;
    render();
    return;
  }

  /* update hover-wall highlight for door tool */
  if (state.tool === 'door') {
    state._hoverWall = detectWall(mx, my);
    render();
  }

  if (state._drag) {
    var tool = state.tool;
    if (tool === 'square' || tool === 'triangle' || tool === 'erase') {
      if (tool === 'erase') { handleErase(mx, my); }
      else                  { handlePlace(mx, my); }
      render(); updateStats();
    }
  }

  if (state._erase) {
    handleErase(mx, my);
    render(); updateStats();
  }
}

function onMouseUp() {
  state._drag  = false;
  state._erase = false;
  state._pan   = false;
  canvas.style.cursor = 'crosshair';
}

function onWheel(e) {
  e.preventDefault();
  var rect  = canvas.getBoundingClientRect();
  var mx    = e.clientX - rect.left;
  var my    = e.clientY - rect.top;
  var delta = e.deltaY > 0 ? 0.88 : 1.14;
  var nz    = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * delta));
  state.panX = mx - (mx - state.panX) * (nz / state.zoom);
  state.panY = my - (my - state.panY) * (nz / state.zoom);
  state.zoom = nz;
  render();
}

/* ── placement logic ── */

function handlePlace(mx, my) {
  var tool = state.tool;

  if (tool === 'door') {
    var wall = detectWall(mx, my);
    if (wall) { toggleDoor(wall.x, wall.y, wall.dir); }
    return;
  }

  if (tool === 'tc') {
    var w   = canvasToWorld(mx, my);
    var cell = worldToCell(w.wx, w.wy);
    placeTC(cell.x, cell.y);
    return;
  }

  if (tool === 'erase') {
    handleErase(mx, my);
    return;
  }

  /* square / triangle */
  var wp = canvasToWorld(mx, my);
  var cp = worldToCell(wp.wx, wp.wy);
  placeCell(cp.x, cp.y);
}

function handleErase(mx, my) {
  /* first try to remove a door on the nearest wall */
  var wall = detectWall(mx, my);
  if (wall) {
    var fi = state.currentFloor;
    var existing = getWall(fi, wall.x, wall.y, wall.dir);
    if (existing) { setWall(fi, wall.x, wall.y, wall.dir, null); return; }
  }
  /* otherwise erase cell */
  var wp = canvasToWorld(mx, my);
  var cp = worldToCell(wp.wx, wp.wy);
  eraseCell(cp.x, cp.y);
}

/* ── UI SYNC ──────────────────────────────────────────────────────────────── */

function syncToolUI() {
  var t = state.tool;
  document.getElementById('triangle-options').classList.toggle('hidden', t !== 'triangle');
  document.getElementById('door-options').classList.toggle('hidden', t !== 'door');
  /* clear hover highlight when switching away from door tool */
  if (t !== 'door') state._hoverWall = null;
  render();
}

function syncFloorUI() {
  document.getElementById('floor-display').textContent =
    'Floor ' + (state.currentFloor + 1);
  document.getElementById('half-floor-toggle').checked =
    floor(state.currentFloor).isHalfFloor;
  updateStats();
  render();
}

function updateStats() {
  var squares = 0, triangles = 0, doors = 0;
  state.floors.forEach(function(fl) {
    Object.values(fl.cells).forEach(function(c) {
      if (c.type === 'square') squares++;
      else triangles++;
    });
    Object.values(fl.walls).forEach(function(w) {
      if (w && w.doorType) doors++;
    });
  });

  document.getElementById('stat-floors').textContent    = state.floors.length;
  document.getElementById('stat-squares').textContent   = squares;
  document.getElementById('stat-triangles').textContent = triangles;
  document.getElementById('stat-area').textContent      = (squares + triangles * 0.5).toFixed(1);
  document.getElementById('stat-doors').textContent     = doors;
  document.getElementById('stat-tc').textContent        =
    state.tcCell
      ? 'Floor ' + (state.tcCell.floor + 1) + ' (' + state.tcCell.x + ',' + state.tcCell.y + ')'
      : '—';
}

/* ── RAID CALCULATOR ─────────────────────────────────────────────────────── */

/*
 * Algorithm: Dijkstra from virtual node "__outside__" to the TC cell.
 *
 * Nodes  : "__outside__"  +  every "x,y" cell key on the TC's floor
 * Edges  :
 *   outside → any cell that has an exterior wall edge (i.e. the cell is present
 *             but there is no foundation on the other side of that edge):
 *       cost = wallCost if no door, else doorCost
 *   cell A → adjacent cell B (both present):
 *       cost = wallCost if no door, else doorCost
 *             (you always have to breach something between adjacent rooms)
 *
 * If the TC is unreachable from outside we report that.
 * Only the floor the TC is on is analysed (ground-floor entry assumption).
 */

function doRaidCalc() {
  var resultsEl = document.getElementById('raid-results');

  if (!state.tcCell) {
    resultsEl.innerHTML = '<p class="hint">⚠️ Place a TC first!</p>';
    return;
  }

  var fi          = state.tcCell.floor;
  var fl          = floor(fi);
  var cells       = fl.cells;
  var walls       = fl.walls;
  var baseMat     = document.getElementById('raid-base-mat').value;
  var defaultDoor = document.getElementById('raid-door-mat').value;

  if (Object.keys(cells).length === 0) {
    resultsEl.innerHTML = '<p class="hint">⚠️ No foundations on TC floor!</p>';
    return;
  }

  var wCost = RAID_COSTS.wall[baseMat] || RAID_COSTS.wall.stone;

  function edgeCost(cx, cy, dir) {
    var wk  = wallKey(cx, cy, dir);
    var wd  = walls[wk] || null;
    if (wd && wd.doorType) {
      var dc = RAID_COSTS.door[wd.doorMaterial] || RAID_COSTS.door[defaultDoor];
      return dc.rockets;
    }
    return wCost.rockets;
  }

  /* build adjacency list */
  var OUTSIDE = '__outside__';
  var graph   = {};
  graph[OUTSIDE] = [];

  Object.keys(cells).forEach(function(k) {
    graph[k] = graph[k] || [];
    var parts = k.split(',');
    var cx    = parseInt(parts[0], 10);
    var cy    = parseInt(parts[1], 10);

    ['n', 'e', 's', 'w'].forEach(function(dir) {
      var nb   = neighbour(cx, cy, dir);
      var nbk  = cellKey(nb.x, nb.y);
      var cost = edgeCost(cx, cy, dir);

      if (cells[nbk]) {
        /* interior edge — both present */
        graph[k].push({ to: nbk, cost: cost });
        /* the reverse edge will be added when we process nbk */
      } else {
        /* exterior edge — connects to outside world */
        graph[k].push({ to: OUTSIDE, cost: cost });
        graph[OUTSIDE].push({ to: k, cost: cost });
      }
    });
  });

  var tcKey = cellKey(state.tcCell.x, state.tcCell.y);
  if (!cells[tcKey]) {
    resultsEl.innerHTML = '<p class="hint">⚠️ TC cell not found on this floor!</p>';
    return;
  }

  var result = dijkstra(graph, OUTSIDE, tcKey);

  if (!isFinite(result.cost)) {
    resultsEl.innerHTML = '<p class="hint">⚠️ TC is unreachable from outside!</p>';
    return;
  }

  /* convert total rockets to satchels/C4 proportionally */
  var rockets  = result.cost;
  var satchels = Math.round(rockets * wCost.satchels / wCost.rockets);
  var c4       = Math.ceil(rockets  * wCost.c4      / wCost.rockets);

  /* path description */
  var pathNodes = result.path.filter(function(n) { return n !== OUTSIDE; });
  var pathStr   = pathNodes.map(function(n) { return '(' + n + ')'; }).join(' → ');

  var html = '<div class="raid-row"><span>🚀 Rockets</span><span><strong>' + rockets + '</strong></span></div>'
           + '<div class="raid-row"><span>💣 ~Satchels</span><span><strong>' + satchels + '</strong></span></div>'
           + '<div class="raid-row"><span>💥 ~C4</span><span><strong>' + c4 + '</strong></span></div>'
           + '<div class="raid-total"><span>Estimated cost</span><span>~' + rockets + ' rockets</span></div>';

  if (pathStr) {
    html += '<div class="raid-path">Path: outside → ' + pathStr + '</div>';
  }

  resultsEl.innerHTML = html;
}

/* Standard Dijkstra — works for small graphs (≤ a few hundred nodes). */
function dijkstra(graph, start, end) {
  var dist  = {};
  var prev  = {};
  var visited = {};
  var nodes   = Object.keys(graph);

  nodes.forEach(function(n) { dist[n] = Infinity; });
  dist[start] = 0;

  /* naive priority queue as sorted array — fine for blueprint-sized graphs */
  var pq = [{ node: start, cost: 0 }];

  while (pq.length > 0) {
    pq.sort(function(a, b) { return a.cost - b.cost; });
    var cur = pq.shift();
    if (visited[cur.node]) continue;
    visited[cur.node] = true;
    if (cur.node === end) break;

    var edges = graph[cur.node] || [];
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (visited[e.to]) continue;
      var nd = cur.cost + e.cost;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = cur.node;
        pq.push({ node: e.to, cost: nd });
      }
    }
  }

  /* reconstruct path */
  var path = [];
  var node = end;
  while (node) {
    path.unshift(node);
    node = prev[node];
    if (node === start) { path.unshift(start); break; }
  }

  return { cost: dist[end], path: path };
}

/* ── INIT ─────────────────────────────────────────────────────────────────── */

function init() {
  initCanvas();
  initEvents();

  /* centre the view on a comfortable starting area */
  state.panX = canvas.width  / 2 - 10 * CELL_SIZE * state.zoom;
  state.panY = canvas.height / 2 - 10 * CELL_SIZE * state.zoom;

  syncFloorUI();
  syncToolUI();
}

document.addEventListener('DOMContentLoaded', init);
