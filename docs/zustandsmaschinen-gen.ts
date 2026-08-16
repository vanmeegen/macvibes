/**
 * Layout-Generator für den verschachtelten Statechart der macvibes-Laufzeit.
 *   A  Sandbox-Lebenszyklus  (sandboxManager.ts)
 *   B  Agent-Turn + Daemon    (chatService / daemonRunner / agentGateway / daemon)
 *   C  Preview-Status         (preview/* , previewStatusPoller/Push/Reporter)
 * B und C sind orthogonale Regionen IM Superzustand running von A.
 * Deterministisch (kein Zufall/Datum). Ausgabe: self-contained SVG.
 */

type Box = { id: string; x: number; y: number; w: number; h: number };
const boxes: Record<string, Box> = {};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const C = {
  paper: '#FAFBFC',
  ink: '#18202E',
  muted: '#5B6675',
  hair: '#D6DCE4',
  aLine: '#B9700C',
  aFill: '#FCF4E6',
  aBand: '#FBEFD8',
  bLine: '#3B41B0',
  bFill: '#ECEDFB',
  bBand: '#E4E6F8',
  cLine: '#0C7B6C',
  cFill: '#E3F4F0',
  cBand: '#D5EEE8',
  tLine: '#B32530',
  tFill: '#FBEAEB',
  kUse: '#8A5A00',
  kEnter: '#0C7B6C',
  kKill: '#B32530',
};

const out: string[] = [];
const P = (s: string) => out.push(s);

function container(
  x: number,
  y: number,
  w: number,
  h: number,
  line: string,
  band: string,
  label: string,
  sub?: string,
) {
  P(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="none" stroke="${line}" stroke-width="2.5"/>`,
  );
  P(
    `<path d="M ${x} ${y + 34} L ${x} ${y + 18} Q ${x} ${y} ${x + 18} ${y} L ${x + w - 18} ${y} Q ${x + w} ${y} ${x + w} ${y + 18} L ${x + w} ${y + 34} Z" fill="${band}"/>`,
  );
  P(
    `<text x="${x + 20}" y="${y + 23}" font-family="ui-sans-serif,system-ui,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="${line}" letter-spacing=".4">${esc(label)}</text>`,
  );
  if (sub)
    P(
      `<text x="${x + w - 18}" y="${y + 23}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5" fill="${line}" opacity=".9">${esc(sub)}</text>`,
    );
}
function region(
  x: number,
  y: number,
  w: number,
  h: number,
  line: string,
  band: string,
  tag: string,
  label: string,
) {
  P(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${band}" fill-opacity=".3" stroke="${line}" stroke-width="1.4"/>`,
  );
  P(`<rect x="${x}" y="${y}" width="184" height="26" rx="9" fill="${line}"/>`);
  P(
    `<text x="${x + 14}" y="${y + 18}" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="700" fill="#fff" letter-spacing=".6">${esc(tag)}</text>`,
  );
  P(
    `<text x="${x + 198}" y="${y + 18}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" fill="${line}">${esc(label)}</text>`,
  );
}
function state(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  line: string,
  fill: string,
  label: string,
  note?: string,
) {
  boxes[id] = { id, x, y, w, h };
  P(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${line}" stroke-width="1.8"/>`,
  );
  const ty = note ? y + h / 2 - 3 : y + h / 2 + 5;
  P(
    `<text x="${x + w / 2}" y="${ty}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="13.5" font-weight="700" fill="${C.ink}">${esc(label)}</text>`,
  );
  if (note)
    P(
      `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${C.muted}">${esc(note)}</text>`,
    );
}
function terminal(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  note?: string,
) {
  P(
    `<rect x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="11" fill="none" stroke="${C.tLine}" stroke-width="1" opacity=".5"/>`,
  );
  state(id, x, y, w, h, C.tLine, C.tFill, label, note);
}
function initialDot(x: number, y: number, color: string) {
  P(`<circle cx="${x}" cy="${y}" r="6" fill="${color}"/>`);
}

const L = (b: Box) => ({ x: b.x, y: b.y + b.h / 2 });
const R = (b: Box) => ({ x: b.x + b.w, y: b.y + b.h / 2 });
const Bt = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h });

type Pt = { x: number; y: number };
function arrow(
  pts: Pt[],
  color: string,
  label?: string,
  o: { dash?: string; lw?: number; lx?: number; ly?: number; anchor?: string; bg?: boolean } = {},
) {
  const d = pts.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
  P(
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.lw ?? 1.8}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''} marker-end="url(#ah-${color.replace('#', '')})"/>`,
  );
  if (label) {
    const lx = o.lx ?? (pts[0].x + pts[pts.length - 1].x) / 2;
    const ly = o.ly ?? (pts[0].y + pts[pts.length - 1].y) / 2 - 6;
    const an = o.anchor ?? 'middle';
    if (o.bg !== false) {
      const w = label.length * 5.9 + 8;
      const bx = an === 'middle' ? lx - w / 2 : an === 'end' ? lx - w : lx;
      P(
        `<rect x="${bx}" y="${ly - 11}" width="${w}" height="15" rx="3" fill="${C.paper}" opacity=".95"/>`,
      );
    }
    P(
      `<text x="${lx}" y="${ly}" text-anchor="${an}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" font-weight="600" fill="${color}">${esc(label)}</text>`,
    );
  }
}
function chip(
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  fill: string,
  lines: string[],
) {
  P(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3"/>`,
  );
  lines.forEach((ln, i) => {
    const b = i === 0;
    P(
      `<text x="${x + 11}" y="${y + 17 + i * 14.5}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${b ? 11.5 : 10.3}" font-weight="${b ? 700 : 400}" fill="${b ? color : C.muted}">${esc(ln)}</text>`,
    );
  });
}

// ===== Vertikale Maße ========================================================
const runY = 232;
const rbY = 276,
  rbH = 384; // Region B 276..660
const rcY = 680,
  rcH = 250; // Region C 680..930
const runBottom = rcY + rcH + 18; // 948
const runH = runBottom - runY;
const Wd = 1600;
const cAy = 92,
  cAh = runBottom + 16 - cAy; // Container A
const Ht = cAy + cAh + 54;

P(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Wd} ${Ht}" font-family="ui-sans-serif,system-ui,sans-serif">`,
);
P(`<rect width="${Wd}" height="${Ht}" fill="${C.paper}"/>`);
for (const col of [C.kUse, C.kEnter, C.kKill, C.aLine, C.bLine, C.cLine, C.tLine, C.muted, C.ink]) {
  const id = col.replace('#', '');
  P(
    `<marker id="ah-${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${col}"/></marker>`,
  );
}

// ===== Titel =================================================================
P(
  `<text x="40" y="46" font-size="26" font-weight="800" fill="${C.ink}" letter-spacing=".2">macvibes · Laufzeit als verschachtelte Zustandsmaschine</text>`,
);
P(
  `<text x="40" y="70" font-size="13.5" fill="${C.muted}">Die Sandbox-VM (A) trägt im Superzustand «running» zwei orthogonale Regionen: den Agent-Turn (B) und den Preview-Status (C). Gestrichelte Pfeile = maschinenübergreifende Synchronisation.</text>`,
);

// ===== A: Container ==========================================================
container(
  24,
  cAy,
  Wd - 48,
  cAh,
  C.aLine,
  C.aBand,
  'A — SANDBOX · VM-Lebenszyklus',
  'sandbox/sandboxManager.ts',
);

// Top-level Meta-Zustände (links gruppiert)
initialDot(60, 183, C.aLine);
state('stopped', 78, 158, 132, 50, C.aLine, C.aFill, 'stopped');
state('starting', 262, 158, 140, 50, C.aLine, C.aFill, 'starting', 'provider.start()');
state('stopping', 452, 158, 138, 50, C.aLine, C.aFill, 'stopping', 'handle.stop()');

// running-Superzustand
const runX = 48,
  runW = Wd - 96;
container(
  runX,
  runY,
  runW,
  runH,
  C.aLine,
  C.aBand,
  'running  (Superzustand)',
  'previewStatus echt nur hier — beim Boot „starting“, sonst „stopped“',
);
boxes['running'] = { id: 'running', x: runX, y: runY, w: runW, h: runH };

// Meta-Übergänge (kurz, keine Kreuzung)
arrow([R(boxes['stopped']), L(boxes['starting'])], C.aLine, 'enter / ensureRunning', { ly: 151 });
arrow(
  [
    { x: 332, y: 208 },
    { x: 332, y: 224 },
    { x: 144, y: 224 },
    { x: 144, y: 208 },
  ],
  C.tLine,
  'Startfehler / Kapazität',
  { lx: 238, ly: 221, dash: '5 4' },
);
arrow(
  [
    { x: 521, y: 158 },
    { x: 521, y: 140 },
    { x: 144, y: 140 },
    { x: 144, y: 158 },
  ],
  C.aLine,
  'stop fertig',
  { lx: 336, ly: 135 },
);
arrow(
  [
    { x: 650, y: 232 },
    { x: 521, y: 208 },
  ],
  C.aLine,
  'stop / Grace / Idle / LRU / Heilung',
  { lx: 606, ly: 224 },
);
// on-exit-Notiz
P(
  `<text x="596" y="252" font-size="10.5" fill="${C.aLine}" opacity=".95">beim Verlassen von running: previewStatus→„stopped“ · currentHandle.abort()</text>`,
);

// ===== Maschine-A-Kopplungs-Chip (links) ====================================
chip(58, 452, 250, 132, C.aLine, C.aFill, [
  'Kopplung an Maschine A',
  'viewers (H11): enter/leave ⇒ Grace',
  'turn/warmup aktiv ⇒ isBusy() ⇒ Grace',
  '  & Eviction aufgeschoben',
  'idleTimer: kein Aufschub',
  'detachForReload: nur Timer, VM lebt',
  'enter bei kaputter VM ⇒ Heilung (gedeckelt)',
]);

// ===== Region B: AGENT-TURN =================================================
const rbX = 344,
  rbW = runW - 320; // 344..1528
region(rbX, rbY, rbW, rbH, C.bLine, C.bBand, 'REGION B', 'Agent-Turn  ·  services/chatService.ts');

const ty0 = rbY + 70; // 346
initialDot(rbX + 24, ty0 + 26, C.bLine);
state('idle', rbX + 46, ty0, 112, 52, C.bLine, C.bFill, 'idle');
state('queued', rbX + 188, ty0, 112, 52, C.bLine, C.bFill, 'queued', 'sendMessage');
state(
  'waiting',
  rbX + 330,
  ty0,
  190,
  52,
  C.bLine,
  C.bFill,
  'waiting-for-conn',
  'activeTurnId · Handle null',
);
state('active', rbX + 560, ty0, 148, 52, C.bLine, C.bFill, 'turn-active', 'currentHandle ≠ null');

const tx = rbX + 760; // 1104
state('done', tx, rbY + 52, 122, 46, C.cLine, C.cFill, 'done', 'turn-completed');
terminal('aborting', tx, rbY + 108, 122, 46, 'aborting', '„Stop heißt Stop“');
terminal('failed', tx, rbY + 164, 122, 46, 'failed', 'error-Zeile');

arrow([R(boxes['idle']), L(boxes['queued'])], C.bLine);
arrow([R(boxes['queued']), L(boxes['waiting'])], C.bLine);
arrow([R(boxes['waiting']), L(boxes['active'])], C.bLine, 'Daemon verbunden', { ly: ty0 - 8 });
arrow([R(boxes['active']), { x: tx, y: rbY + 75 }], C.cLine, '', {});
arrow(
  [
    { x: boxes['active'].x + boxes['active'].w * 0.7, y: Bt(boxes['active']).y },
    { x: tx, y: rbY + 131 },
  ],
  C.tLine,
  'stop / interrupt',
  { lx: tx - 40, ly: rbY + 128, anchor: 'end' },
);
arrow(
  [
    Bt(boxes['failed']),
    { x: boxes['failed'].x + boxes['failed'].w / 2, y: rbY + 232 },
    { x: boxes['waiting'].x + boxes['waiting'].w / 2, y: rbY + 232 },
    Bt(boxes['waiting']),
  ],
  C.bLine,
  'Retry 1× (sawMeaningful = false · kein Nutzerabbruch)',
  { lx: boxes['waiting'].x + 150, ly: rbY + 229, dash: '6 4' },
);

// Nested: Daemon-Verbindung
const dX = rbX + 40,
  dY = rbY + 248,
  dW = 700,
  dH = 104; // 524..628
P(
  `<rect x="${dX}" y="${dY}" width="${dW}" height="${dH}" rx="10" fill="#fff" stroke="${C.bLine}" stroke-width="1.4"/>`,
);
P(
  `<text x="${dX + 14}" y="${dY + 19}" font-family="ui-monospace,Menlo,monospace" font-size="11.5" font-weight="700" fill="${C.bLine}">Sub-Maschine: Daemon-Verbindung — agentGateway ⇄ daemon/main.ts</text>`,
);
initialDot(dX + 24, dY + 65, C.bLine);
state('disc', dX + 40, dY + 42, 128, 46, C.bLine, C.bFill, 'disconnected');
state('conn', dX + 214, dY + 42, 128, 46, C.bLine, C.bFill, 'connecting', 'WS dial-out');
state('cted', dX + 388, dY + 42, 128, 46, C.bLine, C.bFill, 'connected');
arrow([R(boxes['disc']), L(boxes['conn'])], C.bLine, 'connect', { ly: dY + 60 });
arrow([R(boxes['conn']), L(boxes['cted'])], C.bLine, 'open→ready', { ly: dY + 60 });
arrow(
  [
    Bt(boxes['cted']),
    { x: boxes['cted'].x + boxes['cted'].w / 2, y: dY + dH - 8 },
    { x: boxes['disc'].x + boxes['disc'].w / 2, y: dY + dH - 8 },
    Bt(boxes['disc']),
  ],
  C.tLine,
  'close 1006 → abandonTurn + Backoff',
  { lx: dX + 300, ly: dY + dH - 12, dash: '5 4' },
);
P(
  `<text x="${dX + 536}" y="${dY + 50}" font-size="10.3" fill="${C.muted}">ersetzt alte Verbindung (4000)</text>`,
);
P(
  `<text x="${dX + 536}" y="${dY + 66}" font-size="10.3" fill="${C.muted}">Ping/Pong + turn-started-ACK</text>`,
);
P(`<text x="${dX + 536}" y="${dY + 82}" font-size="10.3" fill="${C.muted}">(gegen msb-NAT)</text>`);
P(
  `<text x="${dX + 536}" y="${dY + 98}" font-size="10.3" fill="${C.muted}">Nachzügler bis result verworfen</text>`,
);

// Timeout-/Resume-Chip
chip(tx, dY - 4, rbX + rbW - tx - 18, 112, C.bLine, C.bFill, [
  'Timeouts & Wiederaufnahme',
  'vor 1. Event: coldStart / firstEvent',
  'danach: idle (slow-Var. für lok. Modelle)',
  'resumeUnansweredTurn beim Öffnen:',
  'letzte DB-User-Zeile → selbe turnId',
]);

// ===== Region C: PREVIEW ====================================================
const rcX = 344,
  rcW = runW - 320;
region(
  rcX,
  rcY,
  rcW,
  rcH,
  C.cLine,
  C.cBand,
  'REGION C',
  'Preview-Status  ·  preview/* + previewStatusPoller',
);

const cy0 = rcY + 54;
initialDot(rcX + 24, cy0 + 26, C.cLine);
state('p_starting', rcX + 46, cy0, 128, 52, C.cLine, C.cFill, 'starting');
state('p_ready', rcX + 250, cy0, 128, 52, C.cLine, C.cFill, 'ready', 'HTTP-Probe antwortet');
state(
  'p_restart',
  rcX + 452,
  cy0,
  150,
  52,
  C.cLine,
  C.cFill,
  'restarting',
  'monit Restart pending',
);
terminal('p_failed', rcX + 676, cy0, 132, 52, 'failed', 'Crash-Loop 5/40 → unmonitor');
state('p_stopped', rcX + 880, cy0, 130, 52, C.muted, '#EEF1F4', 'stopped', 'Sandbox ≠ running');

arrow([R(boxes['p_starting']), L(boxes['p_ready'])], C.cLine, 'Running + Probe ok', {
  ly: cy0 + 20,
});
arrow([R(boxes['p_ready']), L(boxes['p_restart'])], C.cLine, 'Crash', { ly: cy0 + 20 });
arrow(
  [
    Bt(boxes['p_restart']),
    { x: boxes['p_restart'].x + boxes['p_restart'].w / 2, y: cy0 + 86 },
    { x: boxes['p_ready'].x + boxes['p_ready'].w / 2, y: cy0 + 86 },
    Bt(boxes['p_ready']),
  ],
  C.cLine,
  'Probe wieder ok',
  { lx: boxes['p_ready'].x + 90, ly: cy0 + 82, dash: '6 4' },
);
arrow([R(boxes['p_restart']), L(boxes['p_failed'])], C.tLine, '', {});
arrow([R(boxes['p_failed']), L(boxes['p_stopped'])], C.muted, 'Stopp', { ly: cy0 + 20 });

chip(rcX + 22, rcY + rcH - 92, 468, 78, C.cLine, C.cFill, [
  'Statusquellen',
  'Push (primär): daemon/previewStatusReporter · staleMs 15 s',
  'Poll (Fallback): previewStatusPoller · 250 ms → 2000 ms',
  'monit: Zyklus 2 s · Port-Health 30× · Crash-Loop 5/40',
]);
chip(rcX + 512, rcY + rcH - 92, 476, 78, C.cLine, C.cFill, [
  'ready-Gate (gateReadyWithProbe)',
  'monit sieht nur den PROZESS — HTTP kommt Sekunden später.',
  '„ready“ erst mit echter HTTP-Antwort, sonst starting/restarting.',
  'httpProbe: redirect:manual (H10, VM-Location angreiferkontrolliert)',
]);

// ===== Kopplungspfeile (gestrichelt) ========================================
// entry: running aktiviert beide Regionen
arrow(
  [
    { x: runX + 24, y: rbY + 13 },
    { x: rbX, y: rbY + 13 },
  ],
  C.kEnter,
  'entry',
  { dash: '2 3', lw: 2, lx: runX + 40, ly: rbY + 9, anchor: 'start', bg: false },
);
arrow(
  [
    { x: runX + 24, y: rcY + 13 },
    { x: rcX, y: rcY + 13 },
  ],
  C.kEnter,
  'entry',
  { dash: '2 3', lw: 2, lx: runX + 40, ly: rcY + 9, anchor: 'start', bg: false },
);
// Region B → Maschine-A-Timer (isBusy / Refcount)
arrow(
  [
    { x: rbX, y: 500 },
    { x: 314, y: 500 },
  ],
  C.kUse,
  '',
  { dash: '6 4', lw: 2 },
);
arrow(
  [
    { x: rbX, y: 528 },
    { x: 314, y: 528 },
  ],
  C.kUse,
  '',
  { dash: '6 4', lw: 2 },
);

// ===== Legende ==============================================================
const lgY = Ht - 30;
const legend: [string, string][] = [
  [C.aLine, 'A Sandbox'],
  [C.bLine, 'B Agent-Turn'],
  [C.cLine, 'C Preview'],
  [C.tLine, 'terminal / Fehler'],
  [C.kUse, 'Kopplung (gestrichelt)'],
];
let lx = 44;
for (const [col, lab] of legend) {
  P(`<rect x="${lx}" y="${lgY - 11}" width="16" height="12" rx="3" fill="${col}" opacity=".85"/>`);
  P(`<text x="${lx + 22}" y="${lgY}" font-size="12" fill="${C.ink}">${esc(lab)}</text>`);
  lx += lab.length * 7.1 + 50;
}
P(
  `<text x="${Wd - 40}" y="${lgY}" text-anchor="end" font-size="11" fill="${C.muted}">Dokumentation — Stand des Codes, nichts geändert</text>`,
);

P(`</svg>`);
// Ausgabe neben dem Skript; die SVG wird anschliessend in zustandsmaschinen.html
// (innerhalb von .fig-card) eingebettet.
await Bun.write(new URL('zustandsmaschinen.svg', import.meta.url).pathname, out.join('\n'));
console.log('SVG geschrieben:', out.length, 'Elemente,', Ht, 'hoch');
