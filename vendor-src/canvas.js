/*
 * The walkthrough's map: draws one level of blocks, files and tests, lets ELK
 * place the boxes and route every line around them, and owns keyboard focus on
 * the map. `web/walk.js` is its only caller, through `window.WalkCanvas.mount`.
 *
 * This is the one React file in diffotator. It is built once by
 * `scripts/build-vendor.sh` into `web/vendor/canvas.js`, which is committed, so
 * people installing diffotator never run npm.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, BaseEdge, EdgeLabelRenderer } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";

const h = React.createElement;
const W_NODE = 250; // every box but a group is this wide; groups grow to fit
const GROUP_PAD = 20;
const elk = new ELK();
const LAYOUT = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.edgeNodeBetweenLayers": "26",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.edgeEdge": "16",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeLabel": "6",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

const colorOf = (palette, tone) => (tone >= 0 ? palette[tone % palette.length] : "#9aa4b8");

// --- boxes ---------------------------------------------------------------------

const handles = [
  h(Handle, { key: "t", type: "target", position: Position.Left }),
  h(Handle, { key: "s", type: "source", position: Position.Right }),
];
const counts = (d) => h("span", { className: "wk-counts" }, h("span", { className: "wk-add" }, "+" + d.add), " ", h("span", { className: "wk-del" }, "−" + d.del));
const badge = (d) => (d.big ? h("span", { className: "wk-badge" }, "BIGGEST") : null);
const number = (d) => (d.n ? h("span", { className: "wk-kb" }, d.n) : null);

function GroupHead({ d }) {
  return h(React.Fragment, null,
    h("div", { className: "wk-gh" }, h("span", { className: "wk-l" }, d.label), h("span", { className: "wk-sub" }, d.sub, " · "), counts(d), badge(d)),
    d.note ? h("div", { className: "wk-gn" }, d.note) : null);
}
function Group({ data: d }) {
  return h("div", { className: "wk-grp", style: { "--c": d.color } }, ...handles, number(d),
    h("div", { className: "wk-ghead", style: { height: d.headH } }, h(GroupHead, { d })));
}
function BoxBody({ d, onOpenTest }) {
  if (d.kind === "block")
    return h(React.Fragment, null, h("div", { className: "wk-l" }, d.label), h("div", { className: "wk-sub" }, d.sub, " · ", counts(d), badge(d)), d.note ? h("div", { className: "wk-note" }, d.note) : null);
  return h(React.Fragment, null,
    h("div", { className: "wk-l wk-mono" }, d.label),
    h("div", { className: "wk-sub" }, d.kind === "ghost" ? d.sub : counts(d), badge(d)),
    d.tests.length
      ? h("div", { className: "wk-tests" }, d.tests.map((t) =>
          h("div", { key: t.path, className: "wk-tc", title: t.path, onClick: onOpenTest ? (e) => (e.stopPropagation(), onOpenTest(t.path)) : undefined },
            h("span", { className: "wk-tag" }, t.tag), h("span", { className: "wk-tn" }, t.path.slice(t.path.lastIndexOf("/") + 1)), h("span", { className: "wk-add" }, "+" + t.add))))
      : null);
}
function Box({ data: d }) {
  return h("div", { className: `wk-nd wk-${d.kind}${d.big ? " wk-big" : ""}`, style: { "--c": d.color }, title: d.title }, ...handles, number(d), h(BoxBody, { d, onOpenTest: d.onOpenTest }));
}
const nodeTypes = { group: Group, block: Box, file: Box, ghost: Box };

/* ELK needs every box's size before it can place anything, and boxes wrap long
   names rather than cutting them off, so their heights come from rendering the
   real markup once, off screen, at the real width. */
function measure(nodes) {
  const host = document.createElement("div");
  host.className = "wk-measure";
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(nodes.map((n) =>
      n.kind === "group"
        ? h("div", { key: n.id, "data-id": n.id, className: "wk-grp wk-ghead-measure", style: { width: W_NODE + GROUP_PAD * 2 } }, h(GroupHead, { d: n }))
        : h("div", { key: n.id, "data-id": n.id, className: `wk-nd wk-${n.kind}`, style: { width: W_NODE } }, h(BoxBody, { d: n })))));
  const out = new Map();
  for (const el of host.children) out.set(el.dataset.id, Math.ceil(el.getBoundingClientRect().height));
  root.unmount();
  host.remove();
  return out;
}

// --- layout --------------------------------------------------------------------

/* How big a laid-out graph can be drawn in the box: the fit zoom, capped
   where fitView caps it. */
const fitZoom = (g, box) => Math.min(box.w / Math.max(g.width, 1), box.h / Math.max(g.height, 1), 1.1);

async function layout(input, palette, box) {
  const heights = measure(input);
  const kids = new Map();
  for (const n of input) if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
  const elkNode = (n) =>
    n.kind === "group"
      ? {
          id: n.id,
          layoutOptions: { "elk.padding": `[top=${heights.get(n.id) + 12},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]` },
          children: (kids.get(n.id) || []).map(elkNode),
        }
      : { id: n.id, width: W_NODE, height: heights.get(n.id) };
  const labelW = (t) => Math.ceil(t.length * 6.8) + 18;
  const graph = {
    id: "root",
    layoutOptions: LAYOUT,
    children: input.filter((n) => !n.parent).map(elkNode),
    edges: input.edgesIn.map((e) => ({
      id: e.id, sources: [e.from], targets: [e.to],
      labels: e.kind === "block" && e.label ? [{ text: e.label, width: labelW(e.label), height: 20 }] : [],
    })),
  };
  /* Left to right reads best, but a wide flow in a tall window leaves most of
     the screen empty and the boxes tiny. When the width is what limits it,
     also try top to bottom and keep whichever draws the boxes bigger. */
  let out = await elk.layout(graph);
  if (box && out.width / Math.max(out.height, 1) > box.w / box.h) {
    const down = await elk.layout({ ...graph, layoutOptions: { ...LAYOUT, "elk.direction": "DOWN" } });
    if (fitZoom(down, box) > fitZoom(out, box) * 1.4) out = down; // only when clearly bigger: left to right reads better
  }

  const byId = new Map(input.map((n) => [n.id, n]));
  const abs = new Map([["root", { x: 0, y: 0 }]]);
  const nodes = [];
  (function walk(list, parent, px, py) {
    for (const k of list || []) {
      const n = byId.get(k.id);
      abs.set(k.id, { x: px + k.x, y: py + k.y });
      nodes.push({
        id: k.id, type: n.kind, position: { x: k.x, y: k.y }, parentId: parent || undefined,
        style: { width: k.width, height: k.height },
        data: { ...n, color: colorOf(palette, n.tone), headH: n.kind === "group" ? heights.get(n.id) + 12 : undefined, title: n.kind === "file" || n.kind === "ghost" ? n.nav.file : undefined },
      });
      walk(k.children, k.id, px + k.x, py + k.y);
    }
  })(out.children, null, 0, 0);

  const edgeById = new Map(input.edgesIn.map((e) => [e.id, e]));
  const found = [];
  (function gather(n) { (n.edges || []).forEach((e) => found.push(e)); (n.children || []).forEach(gather); })(out);
  const edges = found.flatMap((oe) => {
    const e = edgeById.get(oe.id), s = (oe.sections || [])[0];
    if (!e || !s) return [];
    // ELK gives a line's points relative to the box that contains the line.
    const o = abs.get(oe.container || "root") || { x: 0, y: 0 };
    const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    const lb = (oe.labels || [])[0];
    const color = e.kind === "block" ? colorOf(palette, (byId.get(e.from) || {}).tone ?? -1) : "#8fb8ff";
    return [{
      id: e.id, source: e.from, target: e.to, type: "routed", zIndex: 5,
      data: { pts, kind: e.kind, label: e.label || null, color, at: lb ? { x: lb.x + o.x + lb.width / 2, y: lb.y + o.y + lb.height / 2 } : null },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
    }];
  });
  return { nodes, edges };
}

// --- lines ---------------------------------------------------------------------

function roundPath(p, r = 10) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const toward = (a, b, d) => { const L = dist(a, b) || 1; return { x: a.x + ((b.x - a.x) * d) / L, y: a.y + ((b.y - a.y) * d) / L }; };
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1], rr = Math.min(r, dist(a, b) / 2, dist(b, c) / 2);
    const u = toward(b, a, rr), v = toward(b, c, rr);
    d += ` L${u.x},${u.y} Q${b.x},${b.y} ${v.x},${v.y}`;
  }
  const z = p[p.length - 1];
  return d + ` L${z.x},${z.y}`;
}
function longestMid(p) {
  let best = -1, at = p[0];
  for (let i = 0; i < p.length - 1; i++) {
    const L = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    if (L > best) { best = L; at = { x: (p[i].x + p[i + 1].x) / 2, y: (p[i].y + p[i + 1].y) / 2 }; }
  }
  return at;
}
function Routed({ data: d, markerEnd }) {
  const st = d.state, block = d.kind === "block";
  const style = {
    stroke: st === "hot" ? (block ? "#ffffff" : "#b7d3ff") : d.color,
    strokeWidth: st === "hot" ? 3 : block ? 2.3 : 1.4,
    opacity: st === "dim" ? 0.07 : st === "hot" ? 1 : block ? 0.9 : 0.3,
  };
  const showLabel = d.label && st !== "dim" && (block || st === "hot");
  const at = block && d.at ? d.at : longestMid(d.pts);
  return h(React.Fragment, null,
    h(BaseEdge, { path: roundPath(d.pts), markerEnd, style, className: block ? "wk-edge-block" : "wk-edge-link" + (st === "hot" ? " wk-hot" : "") }),
    showLabel
      ? h(EdgeLabelRenderer, null, h("div", { className: "wk-elabel" + (st === "hot" ? " wk-hot" : ""), style: { transform: `translate(-50%,-50%) translate(${at.x}px,${at.y}px)` } }, d.label))
      : null);
}
const edgeTypes = { routed: Routed };

// --- the map -------------------------------------------------------------------

function Canvas({ nodes, edges, ctl, viewport, onViewport }) {
  const [hot, setHot] = React.useState(null);
  ctl.setHot = setHot;
  /* A box's lines include its children's: hovering a group lights every line
     that touches anything inside it. */
  const rel = React.useMemo(() => {
    if (!hot) return null;
    const s = new Set([hot]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (n.parentId && s.has(n.parentId) && !s.has(n.id)) { s.add(n.id); grew = true; }
    }
    return s;
  }, [hot, nodes]);
  const shown = React.useMemo(
    () => edges.map((e) => ({ ...e, data: { ...e.data, state: !rel ? "idle" : rel.has(e.source) || rel.has(e.target) ? "hot" : "dim" } })),
    [edges, rel]
  );
  return h(ReactFlow, {
    nodes, edges: shown, nodeTypes, edgeTypes,
    nodesDraggable: false, nodesConnectable: false, elementsSelectable: false, nodesFocusable: false, edgesFocusable: false,
    fitView: !viewport, fitViewOptions: { padding: 0.1, maxZoom: 1.1, duration: 350 }, defaultViewport: viewport || undefined,
    minZoom: 0.12, maxZoom: 2.5, colorMode: "dark", proOptions: { hideAttribution: true },
    onNodeMouseEnter: (_, n) => setHot(n.id),
    onNodeMouseLeave: () => setHot(ctl.lit ? ctl.focus : null),
    onNodeClick: (_, n) => ctl.open(n.id),
    onMoveEnd: (_, v) => onViewport && onViewport(v),
    onInit: (inst) => { ctl.rf = inst; ctl.ready(); },
  }, h(Background, { gap: 20, size: 1.2, color: "#252c3b" }), h(Controls, { showInteractive: false }));
}

/**
 * Lay out and draw one level into `el`. Resolves to a controller the page's
 * keyboard handler drives; `onOpen` receives the graph node that was opened.
 */
async function mount(el, props) {
  const input = props.nodes.slice();
  input.edgesIn = props.edges;
  for (const n of input) if (n.kind !== "group") n.onOpenTest = props.onOpenTest;
  const r = el.getBoundingClientRect();
  const { nodes, edges } = await layout(input, props.palette, r.width && r.height ? { w: r.width, h: r.height } : null);
  if (!el.isConnected) return null; // the page moved on while ELK worked
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeEl = (id) => el.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const ids = () => nodes.map((n) => n.id).filter(nodeEl);

  const ctl = {
    rf: null, focus: null, lit: false, setHot: null,
    open(id) {
      const n = byId.get(id);
      if (n) { ctl.focus = id; props.onOpen(n.data); }
    },
    ready() {
      // After fitView's glide, so the first focus does not drag the view.
      // Unlit: the ring shows where the keys start, without fading every other line.
      setTimeout(() => focus(props.focus && byId.has(props.focus) ? props.focus : (nodes.find((n) => n.data.n === 1) || nodes[0] || {}).id, false, false), 380);
    },
  };
  function focus(id, pan = true, light = true) {
    const node = id && nodeEl(id);
    if (!node) return;
    el.querySelectorAll(".react-flow__node.wk-focus").forEach((x) => x.classList.remove("wk-focus"));
    node.classList.add("wk-focus");
    ctl.focus = id;
    ctl.lit = light;
    ctl.setHot && ctl.setHot(light ? id : null);
    if (!pan || !ctl.rf) return;
    const r = node.getBoundingClientRect(), c = el.getBoundingClientRect();
    if (r.left < c.left + 20 || r.right > c.right - 20 || r.top < c.top + 20 || r.bottom > c.bottom - 20) {
      const n = ctl.rf.getInternalNode(id);
      const p = n.internals.positionAbsolute;
      ctl.rf.setCenter(p.x + n.measured.width / 2, p.y + n.measured.height / 2, { zoom: Math.max(ctl.rf.getZoom(), 0.7), duration: 280 });
    }
  }

  el.innerHTML = "";
  const root = createRoot(el);
  root.render(h(Canvas, { nodes, edges, ctl, viewport: props.viewport, onViewport: props.onViewport }));

  return {
    /** Nearest box in a screen direction: "left" | "right" | "up" | "down". */
    move(dir) {
      const all = ids();
      if (!ctl.focus || !nodeEl(ctl.focus)) return focus(all[0]);
      const a = nodeEl(ctl.focus).getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      let best = null, score = Infinity;
      for (const id of all) {
        if (id === ctl.focus) continue;
        const b = nodeEl(id).getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
        const along = { left: -dx, right: dx, up: -dy, down: dy }[dir];
        const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
        if (along <= 4) continue;
        const s = along + across * 2.5;
        if (s < score) { score = s; best = id; }
      }
      if (best) focus(best);
    },
    step(d) {
      const all = ids();
      if (all.length) focus(all[(all.indexOf(ctl.focus) + d + all.length) % all.length]);
    },
    activate() { if (ctl.focus) ctl.open(ctl.focus); },
    openNumber(k) { const n = nodes.find((x) => x.data.n === k); if (n) ctl.open(n.id); },
    fit() { ctl.rf && ctl.rf.fitView({ padding: 0.1, maxZoom: 1.1, duration: 300 }); },
    zoom(d) { ctl.rf && (d > 0 ? ctl.rf.zoomIn({ duration: 200 }) : ctl.rf.zoomOut({ duration: 200 })); },
    focusId: () => ctl.focus,
    unmount() { root.unmount(); },
  };
}

window.WalkCanvas = { mount };
