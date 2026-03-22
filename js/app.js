/* ==========================================================================
   Rust Blueprint Designer — app.js
   Edge-alignment system: pieces snap to edges, not a grid.
   Equilateral triangles at any 60° rotation; hexagons & arbitrary layouts.
   ========================================================================== */

'use strict';

/* ── CONSTANTS ────────────────────────────────────────────────────────────── */

var SIDE_LEN    = 64;   // triangle side length in world px at zoom=1
var MIN_ZOOM    = 0.15;
var MAX_ZOOM    = 5;
var SNAP_DIST   = 28;   // world px for edge snapping detection
var WALL_CLICK  = 14;   // world px for wall/door click detection
var EDGE_EPS    = 1.0;  // tolerance for matching edge endpoints

var TRI_H = SIDE_LEN * Math.sqrt(3) / 2;  // height of equilateral triangle

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

/* ── GEOMETRY HELPERS ─────────────────────────────────────────────────────── */

function degToRad(d) { return d * Math.PI / 180; }
function radToDeg(r) { return r * 180 / Math.PI; }

function rotatePoint(x, y, angle) {
  var c = Math.cos(angle), s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

function dist(x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function midpoint(x1, y1, x2, y2) {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function pointToSegDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(px, py, ax, ay);
  var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

function crossSign(px, py, x1, y1, x2, y2) {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
}

function pointInTriangle(px, py, v0, v1, v2) {
  var d1 = crossSign(px, py, v0.x, v0.y, v1.x, v1.y);
  var d2 = crossSign(px, py, v1.x, v1.y, v2.x, v2.y);
  var d3 = crossSign(px, py, v2.x, v2.y, v0.x, v0.y);
  var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function pointInConvexPoly(px, py, verts) {
  var n = verts.length;
  var positive = 0, negative = 0;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    var s = crossSign(px, py, verts[i].x, verts[i].y, verts[j].x, verts[j].y);
    if (s > 0) positive++;
    else if (s < 0) negative++;
    if (positive > 0 && negative > 0) return false;
  }
  return true;
}

/* Normalize angle to [0, 2π) */
function normAngle(a) {
  a = a % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

/* Round angle to nearest multiple of step */
function snapAngle(a, step) {
  var deg = radToDeg(a) % 360;
  if (deg < 0) deg += 360;
  return degToRad(Math.round(deg / step) * step % 360);
}

/* ── PIECE GEOMETRY ───────────────────────────────────────────────────────── */

/*
 * Pieces: 'triangle' (equilateral) or 'square'.
 * Each defined by: center (cx,cy), rotation angle, shape, material.
 *
 * Triangle at angle=0: apex at top, base at bottom.
 *   Circumradius R = SIDE_LEN / sqrt(3).
 *   Vertices at angles -90°, 30°, 150° from center (with rotation added).
 *
 * Square at angle=0: axis-aligned, sides = SIDE_LEN.
 */

var _nextId = 1;
function nextId() { return _nextId++; }

function triVerts(cx, cy, angle) {
  var R = SIDE_LEN / Math.sqrt(3);
  var verts = [];
  for (var i = 0; i < 3; i++) {
    var a = angle + degToRad(-90 + i * 120);
    verts.push({
      x: cx + R * Math.cos(a),
      y: cy + R * Math.sin(a)
    });
  }
  return verts;
}

function sqVerts(cx, cy, angle) {
  var half = SIDE_LEN / 2;
  var corners = [
    { x: -half, y: -half },
    { x:  half, y: -half },
    { x:  half, y:  half },
    { x: -half, y:  half }
  ];
  return corners.map(function(c) {
    var r = rotatePoint(c.x, c.y, angle);
    return { x: cx + r.x, y: cy + r.y };
  });
}

function pieceVerts(piece) {
  return piece.shape === 'triangle'
    ? triVerts(piece.cx, piece.cy, piece.angle)
    : sqVerts(piece.cx, piece.cy, piece.angle);
}

function pieceEdges(piece) {
  var verts = pieceVerts(piece);
  var edges = [];
  for (var i = 0; i < verts.length; i++) {
    var j = (i + 1) % verts.length;
    edges.push({ a: verts[i], b: verts[j], idx: i });
  }
  return edges;
}

function edgeLen(edge) {
  return dist(edge.a.x, edge.a.y, edge.b.x, edge.b.y);
}

/* Outward normal of an edge relative to piece center */
function edgeOutwardNormal(edge, cx, cy) {
  var mx = (edge.a.x + edge.b.x) / 2;
  var my = (edge.a.y + edge.b.y) / 2;
  var dx = edge.b.x - edge.a.x;
  var dy = edge.b.y - edge.a.y;
  var len = Math.sqrt(dx * dx + dy * dy);
  var n1x = -dy / len, n1y = dx / len;
  var dot = (mx + n1x - cx) * n1x + (my + n1y - cy) * n1y;
  if (dot > 0) return { x: n1x, y: n1y };
  return { x: dy / len, y: -dx / len };
}

/* Check if two edges are geometrically the same */
function edgesCoincide(e1, e2) {
  return (
    (dist(e1.a.x, e1.a.y, e2.a.x, e2.a.y) < EDGE_EPS &&
     dist(e1.b.x, e1.b.y, e2.b.x, e2.b.y) < EDGE_EPS) ||
    (dist(e1.a.x, e1.a.y, e2.b.x, e2.b.y) < EDGE_EPS &&
     dist(e1.b.x, e1.b.y, e2.a.x, e2.a.y) < EDGE_EPS)
  );
}

/* ── SNAP PLACEMENT ───────────────────────────────────────────────────────── */

/*
 * Given an edge on an existing piece, compute where to place a new piece
 * (triangle or square) so it shares that edge.
 *
 * We try every possible edge-index of the new shape and both direction
 * alignments (edge can be matched forward or reversed), then pick the
 * placement whose matching edge best aligns with the target edge, and
 * whose center is on the outward side.
 */
function computeSnapPlacement(edge, existingPiece, newShape) {
  var norm = edgeOutwardNormal(edge, existingPiece.cx, existingPiece.cy);
  var mx = (edge.a.x + edge.b.x) / 2;
  var my = (edge.a.y + edge.b.y) / 2;

  var numEdges = newShape === 'triangle' ? 3 : 4;
  var best = null;
  var bestErr = Infinity;

  for (var eIdx = 0; eIdx < numEdges; eIdx++) {
    // For each candidate edge of the new shape, find the rotation that
    // makes that edge coincide with the target edge.

    // Get the template vertices at angle=0, centered at origin
    var templateVerts = newShape === 'triangle'
      ? triVerts(0, 0, 0)
      : sqVerts(0, 0, 0);

    var tA = templateVerts[eIdx];
    var tB = templateVerts[(eIdx + 1) % numEdges];

    // Direction of the template edge
    var tDx = tB.x - tA.x, tDy = tB.y - tA.y;
    var tAngle = Math.atan2(tDy, tDx);

    // Two possible target directions (forward and reversed)
    var targetAngles = [
      Math.atan2(edge.a.y - edge.b.y, edge.a.x - edge.b.x),  // reversed
      Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x)   // forward
    ];

    for (var d = 0; d < 2; d++) {
      var targetAngle = targetAngles[d];
      var rotation = targetAngle - tAngle;

      // Compute actual verts with this rotation
      var testVerts = newShape === 'triangle'
        ? triVerts(0, 0, rotation)
        : sqVerts(0, 0, rotation);

      // The edge eIdx of the test piece
      var eA = testVerts[eIdx];
      var eB = testVerts[(eIdx + 1) % numEdges];

      // We need to position the piece so that eA,eB coincide with edge.a,edge.b
      // or edge.b,edge.a. Translate so edge midpoints align.
      var eMx = (eA.x + eB.x) / 2;
      var eMy = (eA.y + eB.y) / 2;
      var cx = mx - eMx;
      var cy = my - eMy;

      // Verify the edge actually matches
      var finalVerts = newShape === 'triangle'
        ? triVerts(cx, cy, rotation)
        : sqVerts(cx, cy, rotation);
      var fA = finalVerts[eIdx];
      var fB = finalVerts[(eIdx + 1) % numEdges];

      var err = Math.min(
        dist(fA.x, fA.y, edge.a.x, edge.a.y) + dist(fB.x, fB.y, edge.b.x, edge.b.y),
        dist(fA.x, fA.y, edge.b.x, edge.b.y) + dist(fB.x, fB.y, edge.a.x, edge.a.y)
      );

      // Check center is on the correct (outward) side
      var dotCheck = (cx - mx) * norm.x + (cy - my) * norm.y;
      if (dotCheck < -EDGE_EPS) continue;

      if (err < bestErr) {
        bestErr = err;
        best = { cx: cx, cy: cy, angle: normAngle(rotation), shape: newShape };
      }
    }
  }

  return best;
}

/* ── STATE ────────────────────────────────────────────────────────────────── */

var state = {
  floors: [makeFloor()],
  currentFloor: 0,
  tcPiece: null,

  tool:        'square',
  shape:       'square',
  material:    'stone',
  doorType:    'single',
  doorMaterial:'sheet',

  zoom: 1,
  panX: 0,
  panY: 0,

  _drag: false,
  _erase: false,
  _pan: false,
  _panAnchorX: 0,
  _panAnchorY: 0,

  _hoverEdge: null,
  _snapPreview: null,
  _snapEdge: null,
  _lastPlacedId: null
};

function makeFloor() {
  return {
    pieces: {},
    walls: {},
    isHalfFloor: false
  };
}

/* ── EDGE KEY ─────────────────────────────────────────────────────────────── */

function makeEdgeKey(pid1, eidx1, pid2, eidx2) {
  if (pid2 === null) return pid1 + ':' + eidx1 + '|ext';
  if (pid1 < pid2) return pid1 + ':' + eidx1 + '|' + pid2 + ':' + eidx2;
  return pid2 + ':' + eidx2 + '|' + pid1 + ':' + eidx1;
}

function findSharedEdge(fl, pieceId, edgeIdx) {
  var piece = fl.pieces[pieceId];
  if (!piece) return null;
  var edges = pieceEdges(piece);
  var e = edges[edgeIdx];

  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    var otherId = parseInt(keys[i], 10);
    if (otherId === pieceId) continue;
    var other = fl.pieces[otherId];
    var oEdges = pieceEdges(other);
    for (var j = 0; j < oEdges.length; j++) {
      if (edgesCoincide(e, oEdges[j])) {
        return { pieceId: otherId, edgeIdx: j };
      }
    }
  }
  return null;
}

function getEdgeKey(fl, pieceId, edgeIdx) {
  var shared = findSharedEdge(fl, pieceId, edgeIdx);
  if (shared) return makeEdgeKey(pieceId, edgeIdx, shared.pieceId, shared.edgeIdx);
  return makeEdgeKey(pieceId, edgeIdx, null, null);
}

/* ── OVERLAP DETECTION ────────────────────────────────────────────────────── */

function piecesOverlap(p1, p2) {
  var d = dist(p1.cx, p1.cy, p2.cx, p2.cy);
  if (d > SIDE_LEN * 2.5) return false;
  // Touching pieces share edges — that's fine. Only overlapping interiors is bad.
  // Shrink shapes slightly and check centroid inclusion + vertex inclusion.
  var shrink = EDGE_EPS * 3;

  if (pointInShapeShrunk(p2.cx, p2.cy, p1, shrink)) return true;
  if (pointInShapeShrunk(p1.cx, p1.cy, p2, shrink)) return true;

  var v1 = pieceVerts(p1), v2 = pieceVerts(p2);
  for (var i = 0; i < v1.length; i++) {
    if (pointInShapeShrunk(v1[i].x, v1[i].y, p2, shrink)) return true;
  }
  for (var i = 0; i < v2.length; i++) {
    if (pointInShapeShrunk(v2[i].x, v2[i].y, p1, shrink)) return true;
  }
  return false;
}

function pointInShape(px, py, piece) {
  var v = pieceVerts(piece);
  if (piece.shape === 'triangle') return pointInTriangle(px, py, v[0], v[1], v[2]);
  return pointInConvexPoly(px, py, v);
}

function pointInShapeShrunk(px, py, piece, shrink) {
  var v = pieceVerts(piece);
  var sv = v.map(function(pt) {
    var dx = pt.x - piece.cx, dy = pt.y - piece.cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.01) return pt;
    var factor = Math.max(0, (d - shrink) / d);
    return { x: piece.cx + dx * factor, y: piece.cy + dy * factor };
  });
  if (piece.shape === 'triangle') return pointInTriangle(px, py, sv[0], sv[1], sv[2]);
  return pointInConvexPoly(px, py, sv);
}

function wouldOverlap(fl, newPiece, ignoreId) {
  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    var id = parseInt(keys[i], 10);
    if (id === ignoreId) continue;
    if (piecesOverlap(newPiece, fl.pieces[id])) return true;
  }
  return false;
}

/* ── FLOOR OPERATIONS ─────────────────────────────────────────────────────── */

function placePiece(shape, cx, cy, angle, material) {
  var fi = state.currentFloor;
  var fl = state.floors[fi];
  var piece = {
    id: nextId(),
    shape: shape,
    cx: cx,
    cy: cy,
    angle: normAngle(angle),
    material: material || state.material
  };

  if (wouldOverlap(fl, piece, -1)) return null;
  fl.pieces[piece.id] = piece;
  return piece;
}

function erasePieceAt(wx, wy) {
  var fi = state.currentFloor;
  var fl = state.floors[fi];
  var keys = Object.keys(fl.pieces);

  for (var i = 0; i < keys.length; i++) {
    var piece = fl.pieces[keys[i]];
    if (pointInShape(wx, wy, piece)) {
      var edges = pieceEdges(piece);
      for (var j = 0; j < edges.length; j++) {
        var ek = getEdgeKey(fl, piece.id, j);
        delete fl.walls[ek];
      }
      if (state.tcPiece && state.tcPiece.floor === fi && state.tcPiece.id === piece.id) {
        state.tcPiece = null;
      }
      delete fl.pieces[piece.id];
      return true;
    }
  }
  return false;
}

function findPieceAt(wx, wy, fi) {
  var fl = state.floors[fi];
  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    var piece = fl.pieces[keys[i]];
    if (pointInShape(wx, wy, piece)) return piece;
  }
  return null;
}

function findClosestEdge(wx, wy) {
  var fi = state.currentFloor;
  var fl = state.floors[fi];
  var best = null;
  var bestDist = Infinity;

  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    var piece = fl.pieces[keys[i]];
    var edges = pieceEdges(piece);
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j];
      var d = pointToSegDist(wx, wy, e.a.x, e.a.y, e.b.x, e.b.y);
      if (d < bestDist) {
        bestDist = d;
        best = { piece: piece, edgeIdx: j, edge: e, dist: d };
      }
    }
  }
  return best;
}

/* ── COORDINATE HELPERS ───────────────────────────────────────────────────── */

function canvasToWorld(cx, cy) {
  return {
    wx: (cx - state.panX) / state.zoom,
    wy: (cy - state.panY) / state.zoom
  };
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
  var wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  render();
}

function render() {
  if (!ctx) return;
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#080c11';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);

  drawGrid();
  drawPieces();
  drawEdgeWalls();
  drawTC();
  drawSnapPreview();
  drawHoverEdge();

  ctx.restore();
  drawOverlay();
}

/* Faint dot grid for spatial reference */
function drawGrid() {
  var x0 = -state.panX / state.zoom;
  var y0 = -state.panY / state.zoom;
  var x1 = (canvas.width  - state.panX) / state.zoom;
  var y1 = (canvas.height - state.panY) / state.zoom;

  var spacing = SIDE_LEN;
  var gxS = Math.floor(x0 / spacing) - 1;
  var gyS = Math.floor(y0 / spacing) - 1;
  var gxE = Math.ceil(x1 / spacing) + 1;
  var gyE = Math.ceil(y1 / spacing) + 1;

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (var gx = gxS; gx <= gxE; gx++) {
    for (var gy = gyS; gy <= gyE; gy++) {
      ctx.beginPath();
      ctx.arc(gx * spacing, gy * spacing, 1.5 / state.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawPieces() {
  var fl = state.floors[state.currentFloor];
  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    drawPiece(fl.pieces[keys[i]], fl.isHalfFloor);
  }
}

function drawPiece(piece, floorHalf) {
  var mat = MATERIALS[piece.material] || MATERIALS.stone;
  var verts = pieceVerts(piece);

  ctx.fillStyle   = mat.fill;
  ctx.strokeStyle = mat.stroke;
  ctx.lineWidth   = 2 / state.zoom;
  ctx.lineJoin    = 'round';

  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (floorHalf || piece.halfFloor) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
    ctx.closePath();
    ctx.fill();
    if (state.zoom >= 0.5) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold ' + (10 / state.zoom) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u00bd', piece.cx, piece.cy - 5 / state.zoom);
    }
  }

  if (piece.isLoot) {
    ctx.fillStyle = 'rgba(80,200,100,0.40)';
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#50c864';
    ctx.lineWidth = 2.5 / state.zoom;
    ctx.stroke();
    if (state.zoom >= 0.4) {
      ctx.fillStyle = '#50c864';
      ctx.font = 'bold ' + (9 / state.zoom) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('LOOT', piece.cx, piece.cy);
    }
  }

  if (piece.isHC) {
    ctx.fillStyle = 'rgba(255, 180, 40, 0.30)';
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
    ctx.closePath();
    ctx.fill();

    if (state.zoom >= 0.4) {
      ctx.fillStyle = '#ffd84a';
      ctx.font = 'bold ' + (9 / state.zoom) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('HC', piece.cx, piece.cy);
    }
  }
}

function drawEdgeWalls() {
  var fi = state.currentFloor;
  var fl = state.floors[fi];
  var drawn = {};

  var keys = Object.keys(fl.pieces);
  for (var i = 0; i < keys.length; i++) {
    var piece = fl.pieces[keys[i]];
    var edges = pieceEdges(piece);
    var mat = MATERIALS[piece.material] || MATERIALS.stone;

    for (var j = 0; j < edges.length; j++) {
      var ek = getEdgeKey(fl, piece.id, j);
      if (drawn[ek]) continue;
      drawn[ek] = true;

      var e = edges[j];
      var wallData = fl.walls[ek] || null;

      if (wallData && wallData.doorType) {
        renderDoor(e.a.x, e.a.y, e.b.x, e.b.y, wallData);
      } else {
        ctx.strokeStyle = mat.stroke;
        ctx.lineWidth   = 3.5 / state.zoom;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      }
    }
  }
}

function renderDoor(x1, y1, x2, y2, wd) {
  var color = DOOR_COLORS[wd.doorMaterial] || DOOR_COLORS.sheet;
  var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  var dx = x2 - x1, dy = y2 - y1;
  var len = Math.sqrt(dx * dx + dy * dy);
  var ux = dx / len, uy = dy / len;

  var fraction = wd.doorType === 'single' ? 0.45
               : wd.doorType === 'double' ? 0.75 : 0.88;
  var hw = (SIDE_LEN * fraction) / 2;

  ctx.strokeStyle = MATERIALS.stone.stroke;
  ctx.lineWidth   = 3.5 / state.zoom;
  ctx.lineCap     = 'square';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(mx - ux * hw, my - uy * hw); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(mx + ux * hw, my + uy * hw); ctx.lineTo(x2, y2); ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth   = 5 / state.zoom;
  ctx.beginPath(); ctx.moveTo(mx - ux * hw, my - uy * hw); ctx.lineTo(mx + ux * hw, my + uy * hw); ctx.stroke();

  if (state.zoom >= 0.5) {
    var label = wd.doorType === 'single' ? 'S' : wd.doorType === 'double' ? 'D' : 'G';
    var perpX = -uy * (13 / state.zoom), perpY = ux * (13 / state.zoom);
    ctx.fillStyle = color;
    ctx.font = 'bold ' + (10 / state.zoom) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx + perpX, my + perpY);
  }
}

function drawTC() {
  if (!state.tcPiece) return;
  if (state.tcPiece.floor !== state.currentFloor) return;
  var fl = state.floors[state.currentFloor];
  var piece = fl.pieces[state.tcPiece.id];
  if (!piece) { state.tcPiece = null; return; }
  var verts = pieceVerts(piece);

  ctx.strokeStyle = '#f0a500';
  ctx.lineWidth   = 3 / state.zoom;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
  ctx.stroke();

  if (state.zoom >= 0.3) {
    ctx.fillStyle = '#f0a500';
    ctx.font = 'bold ' + (13 / state.zoom) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TC', piece.cx, piece.cy);
  }
}

function drawSnapPreview() {
  var sp = state._snapPreview;
  if (!sp) return;

  var verts = sp.shape === 'triangle'
    ? triVerts(sp.cx, sp.cy, sp.angle)
    : sqVerts(sp.cx, sp.cy, sp.angle);

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = MATERIALS[state.material] ? MATERIALS[state.material].fill : MATERIALS.stone.fill;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / state.zoom;
  ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (var i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  if (state._snapEdge) {
    ctx.save();
    ctx.strokeStyle = 'rgba(240,165,0,0.7)';
    ctx.lineWidth = 4 / state.zoom;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(state._snapEdge.a.x, state._snapEdge.a.y);
    ctx.lineTo(state._snapEdge.b.x, state._snapEdge.b.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawHoverEdge() {
  if (state.tool !== 'door') return;
  var he = state._hoverEdge;
  if (!he) return;
  ctx.strokeStyle = 'rgba(255,165,0,0.55)';
  ctx.lineWidth = 8 / state.zoom;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(he.edge.a.x, he.edge.a.y);
  ctx.lineTo(he.edge.b.x, he.edge.b.y);
  ctx.stroke();
}

function drawOverlay() {
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  var fl = state.floors[state.currentFloor];
  var label = 'Floor ' + (state.currentFloor + 1) + ' / ' + state.floors.length;
  if (fl.isHalfFloor) label += '  [Half Floor]';
  ctx.fillText(label, 10, 10);
}

/* ── EVENT HANDLING ───────────────────────────────────────────────────────── */

function initEvents() {
  canvas.addEventListener('mousedown',   onMouseDown);
  canvas.addEventListener('mousemove',   onMouseMove);
  canvas.addEventListener('mouseup',     onMouseUp);
  canvas.addEventListener('mouseleave',  onMouseLeave);
  canvas.addEventListener('wheel',       onWheel, { passive: false });
  canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  document.querySelectorAll('.tool-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tool-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      if (state.tool === 'triangle') state.shape = 'triangle';
      else if (state.tool === 'square') state.shape = 'square';
      syncToolUI();
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
    if (state.tcPiece && state.tcPiece.floor === state.currentFloor) state.tcPiece = null;
    if (state.tcPiece && state.tcPiece.floor > state.currentFloor) state.tcPiece.floor--;
    state.floors.splice(state.currentFloor, 1);
    if (state.currentFloor >= state.floors.length) state.currentFloor = state.floors.length - 1;
    syncFloorUI();
  });
  document.getElementById('half-floor-toggle').addEventListener('change', function(e) {
    state.floors[state.currentFloor].isHalfFloor = e.target.checked;
    render();
  });

  document.getElementById('btn-clear-floor').addEventListener('click', function() {
    if (!confirm('Clear all foundations on this floor?')) return;
    if (state.tcPiece && state.tcPiece.floor === state.currentFloor) state.tcPiece = null;
    state.floors[state.currentFloor] = makeFloor();
    syncFloorUI();
  });
  document.getElementById('btn-clear-all').addEventListener('click', function() {
    if (!confirm('Clear ALL floors?')) return;
    state.floors = [makeFloor()];
    state.currentFloor = 0;
    state.tcPiece = null;
    _nextId = 1;
    syncFloorUI();
  });

  document.getElementById('btn-save-json').addEventListener('click', saveToJSON);
  document.getElementById('btn-load-json').addEventListener('click', function() {
    document.getElementById('load-json-input').value = '';
    document.getElementById('load-json-input').click();
  });
  document.getElementById('load-json-input').addEventListener('change', function(e) {
    if (e.target.files && e.target.files[0]) loadFromJSON(e.target.files[0]);
  });

  document.getElementById('btn-calc-raid').addEventListener('click', doRaidCalc);
}

/* ── MOUSE HANDLERS ───────────────────────────────────────────────────────── */

function onMouseDown(e) {
  e.preventDefault();
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left, my = e.clientY - rect.top;

  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    state._pan = true;
    state._panAnchorX = mx - state.panX;
    state._panAnchorY = my - state.panY;
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button === 2) {
    state._erase = true;
    handleErase(mx, my);
    render(); updateStats();
    return;
  }
  if (e.button === 0) {
    state._drag = true;
    state._lastPlacedId = null;
    handlePlace(mx, my);
    render(); updateStats();
  }
}

function onMouseMove(e) {
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left, my = e.clientY - rect.top;

  if (state._pan) {
    state.panX = mx - state._panAnchorX;
    state.panY = my - state._panAnchorY;
    render();
    return;
  }

  var w = canvasToWorld(mx, my);

  if (state.tool === 'door') {
    var closest = findClosestEdge(w.wx, w.wy);
    if (closest && closest.dist < WALL_CLICK + 10) {
      state._hoverEdge = { pieceId: closest.piece.id, edgeIdx: closest.edgeIdx, edge: closest.edge };
    } else {
      state._hoverEdge = null;
    }
    render();
  }

  if (state.tool === 'triangle' || state.tool === 'square') {
    updateSnapPreview(w.wx, w.wy);
    render();
  }

  if (state._drag && (state.tool === 'square' || state.tool === 'triangle')) {
    handlePlace(mx, my);
    render(); updateStats();
  }
  if (state._erase) {
    handleErase(mx, my);
    render(); updateStats();
  }
}

function onMouseUp() {
  state._drag = false;
  state._erase = false;
  state._pan = false;
  state._lastPlacedId = null;
  canvas.style.cursor = 'crosshair';
}

function onMouseLeave() {
  onMouseUp();
  state._snapPreview = null;
  state._snapEdge = null;
  state._hoverEdge = null;
  render();
}

function onWheel(e) {
  e.preventDefault();
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left, my = e.clientY - rect.top;
  var delta = e.deltaY > 0 ? 0.88 : 1.14;
  var nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * delta));
  state.panX = mx - (mx - state.panX) * (nz / state.zoom);
  state.panY = my - (my - state.panY) * (nz / state.zoom);
  state.zoom = nz;
  render();
}

/* ── SNAP PREVIEW ─────────────────────────────────────────────────────────── */

function updateSnapPreview(wx, wy) {
  var shape = state.shape;
  var fi = state.currentFloor;
  var fl = state.floors[fi];

  var closest = findClosestEdge(wx, wy);
  var snapThresh = SNAP_DIST + 15 / state.zoom;

  if (closest && closest.dist < snapThresh) {
    var snap = computeSnapPlacement(closest.edge, closest.piece, shape);
    if (snap && !wouldOverlap(fl, snap, -1)) {
      state._snapPreview = snap;
      state._snapEdge = closest.edge;
      return;
    }
  }

  if (Object.keys(fl.pieces).length === 0) {
    state._snapPreview = { cx: wx, cy: wy, angle: 0, shape: shape };
    state._snapEdge = null;
  } else {
    state._snapPreview = null;
    state._snapEdge = null;
  }
}

/* ── PLACEMENT LOGIC ──────────────────────────────────────────────────────── */

function handlePlace(mx, my) {
  var tool = state.tool;
  var w = canvasToWorld(mx, my);

  if (tool === 'door') {
    handleDoorPlace(w.wx, w.wy);
    return;
  }
  if (tool === 'tc') {
    var piece = findPieceAt(w.wx, w.wy, state.currentFloor);
    if (piece) state.tcPiece = { floor: state.currentFloor, id: piece.id };
    return;
  }
  if (tool === 'loot') {
    var piece = findPieceAt(w.wx, w.wy, state.currentFloor);
    if (piece) piece.isLoot = !piece.isLoot;
    return;
  }
  if (tool === 'hc') {
    var piece = findPieceAt(w.wx, w.wy, state.currentFloor);
    if (piece) piece.isHC = !piece.isHC;
    return;
  }
  if (tool === 'erase') {
    handleErase(mx, my);
    return;
  }

  var sp = state._snapPreview;
  if (!sp) {
    var fi = state.currentFloor;
    var fl = state.floors[fi];
    if (Object.keys(fl.pieces).length === 0) {
      placePiece(state.shape, w.wx, w.wy, 0, state.material);
    }
    return;
  }

  var fi = state.currentFloor;
  var fl = state.floors[fi];
  if (wouldOverlap(fl, sp, -1)) return;

  var placed = placePiece(sp.shape, sp.cx, sp.cy, sp.angle, state.material);
  if (placed) {
    state._lastPlacedId = placed.id;
    updateSnapPreview(w.wx, w.wy);
  }
}

function handleDoorPlace(wx, wy) {
  var fi = state.currentFloor;
  var fl = state.floors[fi];
  var closest = findClosestEdge(wx, wy);
  if (!closest || closest.dist > WALL_CLICK + 10) return;

  var ek = getEdgeKey(fl, closest.piece.id, closest.edgeIdx);
  if (fl.walls[ek]) {
    delete fl.walls[ek];
  } else {
    fl.walls[ek] = { doorType: state.doorType, doorMaterial: state.doorMaterial };
  }
}

function handleErase(mx, my) {
  var w = canvasToWorld(mx, my);
  var fi = state.currentFloor;
  var fl = state.floors[fi];

  var closest = findClosestEdge(w.wx, w.wy);
  if (closest && closest.dist < WALL_CLICK + 5) {
    var ek = getEdgeKey(fl, closest.piece.id, closest.edgeIdx);
    if (fl.walls[ek]) { delete fl.walls[ek]; return; }
  }
  erasePieceAt(w.wx, w.wy);
}

/* ── UI SYNC ──────────────────────────────────────────────────────────────── */

function syncToolUI() {
  var t = state.tool;
  document.getElementById('door-options').classList.toggle('hidden', t !== 'door');
  // Hide triangle-options since orientation is now automatic
  var triOpts = document.getElementById('triangle-options');
  if (triOpts) triOpts.classList.add('hidden');
  if (t !== 'door') state._hoverEdge = null;
  if (t !== 'triangle' && t !== 'square') {
    state._snapPreview = null;
    state._snapEdge = null;
  }
  canvas.style.cursor = (t === 'loot' || t === 'tc' || t === 'hc') ? 'pointer' : 'crosshair';
  render();
}

function syncFloorUI() {
  document.getElementById('floor-display').textContent = 'Floor ' + (state.currentFloor + 1);
  document.getElementById('half-floor-toggle').checked = state.floors[state.currentFloor].isHalfFloor;
  updateStats();
  render();
}

function updateStats() {
  var squares = 0, triangles = 0, doors = 0, honeycomb = 0;
  state.floors.forEach(function(fl) {
    Object.values(fl.pieces).forEach(function(p) {
      if (p.shape === 'square') squares++;
      else triangles++;
      if (p.isHC) honeycomb++;
    });
    Object.values(fl.walls).forEach(function(w) {
      if (w && w.doorType) doors++;
    });
  });

  document.getElementById('stat-floors').textContent = state.floors.length;
  document.getElementById('stat-squares').textContent = squares;
  document.getElementById('stat-triangles').textContent = triangles;
  document.getElementById('stat-area').textContent = (squares + triangles * 0.5).toFixed(1);
  document.getElementById('stat-doors').textContent = doors;
  document.getElementById('stat-honeycomb').textContent = honeycomb;
  document.getElementById('stat-tc').textContent = state.tcPiece
    ? 'Floor ' + (state.tcPiece.floor + 1) + ' (piece #' + state.tcPiece.id + ')'
    : '\u2014';
}

/* ── RAID CALCULATOR ─────────────────────────────────────────────────────── */

function doRaidCalc() {
  var resultsEl = document.getElementById('raid-results');

  if (!state.tcPiece) {
    resultsEl.innerHTML = '<p class="hint">\u26a0\ufe0f Place a TC first!</p>';
    return;
  }

  var fi = state.tcPiece.floor;
  var fl = state.floors[fi];
  var pieces = fl.pieces;
  var walls = fl.walls;
  var baseMat = document.getElementById('raid-base-mat').value;
  var defaultDoor = document.getElementById('raid-door-mat').value;

  if (Object.keys(pieces).length === 0) {
    resultsEl.innerHTML = '<p class="hint">\u26a0\ufe0f No foundations on TC floor!</p>';
    return;
  }

  var wCost = RAID_COSTS.wall[baseMat] || RAID_COSTS.wall.stone;

  function edgeCost(ek) {
    var wd = walls[ek] || null;
    if (wd && wd.doorType) {
      var dc = RAID_COSTS.door[wd.doorMaterial] || RAID_COSTS.door[defaultDoor];
      return dc.rockets;
    }
    return wCost.rockets;
  }

  var OUTSIDE = '__outside__';
  var graph = {};
  graph[OUTSIDE] = [];

  var pkeys = Object.keys(pieces);
  pkeys.forEach(function(pk) { graph[pk] = []; });

  pkeys.forEach(function(pk) {
    var piece = pieces[pk];
    var edges = pieceEdges(piece);
    for (var j = 0; j < edges.length; j++) {
      var ek = getEdgeKey(fl, piece.id, j);
      var shared = findSharedEdge(fl, piece.id, j);
      var cost = edgeCost(ek);

      if (shared) {
        var nbk = String(shared.pieceId);
        graph[pk].push({ to: nbk, cost: cost });
      } else {
        graph[pk].push({ to: OUTSIDE, cost: cost });
        graph[OUTSIDE].push({ to: pk, cost: cost });
      }
    }
  });

  var tcKey = String(state.tcPiece.id);
  if (!pieces[tcKey]) {
    resultsEl.innerHTML = '<p class="hint">\u26a0\ufe0f TC piece not found!</p>';
    return;
  }

  var result = dijkstra(graph, OUTSIDE, tcKey);

  if (!isFinite(result.cost)) {
    resultsEl.innerHTML = '<p class="hint">\u26a0\ufe0f TC is unreachable from outside!</p>';
    return;
  }

  var rockets = result.cost;
  var satchels = Math.round(rockets * wCost.satchels / wCost.rockets);
  var c4 = Math.ceil(rockets * wCost.c4 / wCost.rockets);

  var pathNodes = result.path.filter(function(n) { return n !== OUTSIDE; });
  var pathStr = pathNodes.map(function(n) { return '#' + n; }).join(' \u2192 ');

  var html = '<div class="raid-row"><span>\ud83d\ude80 Rockets</span><span><strong>' + rockets + '</strong></span></div>'
    + '<div class="raid-row"><span>\ud83d\udca3 ~Satchels</span><span><strong>' + satchels + '</strong></span></div>'
    + '<div class="raid-row"><span>\ud83d\udca5 ~C4</span><span><strong>' + c4 + '</strong></span></div>'
    + '<div class="raid-total"><span>Estimated cost</span><span>~' + rockets + ' rockets</span></div>';

  if (pathStr) {
    html += '<div class="raid-path">Path: outside \u2192 ' + pathStr + '</div>';
  }
  resultsEl.innerHTML = html;
}

function dijkstra(graph, start, end) {
  var d = {}, prev = {}, visited = {};
  Object.keys(graph).forEach(function(n) { d[n] = Infinity; });
  d[start] = 0;

  var pq = [{ node: start, cost: 0 }];
  while (pq.length > 0) {
    pq.sort(function(a, b) { return a.cost - b.cost; });
    var cur = pq.shift();
    if (visited[cur.node]) continue;
    visited[cur.node] = true;
    if (cur.node === end) break;

    (graph[cur.node] || []).forEach(function(e) {
      if (visited[e.to]) return;
      var nd = cur.cost + e.cost;
      if (nd < d[e.to]) {
        d[e.to] = nd;
        prev[e.to] = cur.node;
        pq.push({ node: e.to, cost: nd });
      }
    });
  }

  var path = [], node = end;
  while (node) {
    path.unshift(node);
    node = prev[node];
    if (node === start) { path.unshift(start); break; }
  }
  return { cost: d[end], path: path };
}

/* ── SAVE / LOAD JSON ────────────────────────────────────────────────────── */

function saveToJSON() {
  var data = {
    version: 1,
    _nextId: _nextId,
    tcPiece: state.tcPiece,
    floors: state.floors
  };
  var json = JSON.stringify(data, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'rust-base.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(url); document.body.removeChild(a); }, 100);
}

function loadFromJSON(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.floors)) throw new Error('Invalid save file');
      state.floors = data.floors;
      state.tcPiece = data.tcPiece || null;
      state.currentFloor = 0;
      _nextId = data._nextId || 1;
      // Ensure _nextId is always higher than any existing piece id
      state.floors.forEach(function(fl) {
        Object.keys(fl.pieces || {}).forEach(function(k) {
          var id = parseInt(k, 10);
          if (id >= _nextId) _nextId = id + 1;
        });
      });
      syncFloorUI();
    } catch (err) {
      alert('Failed to load save file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

/* ── INIT ─────────────────────────────────────────────────────────────────── */

function init() {
  initCanvas();
  initEvents();
  state.panX = canvas.width / 2;
  state.panY = canvas.height / 2;
  syncFloorUI();
  syncToolUI();
}

document.addEventListener('DOMContentLoaded', init);
