// Illustrations of the five games (home page tiles and lobby cards), drawn as inline SVG so CSS can
// move their parts when the card is hovered (style.css, "Game art"): the brush draws its stroke, the
// telephone rings and lifts its handset, the kart revs and drives off, the control room's knobs turn
// until the panel blows, and the two teams tug the ball between them.
(function () {
  const ART = {
    pictionary: `
      <rect x="12" y="10" width="74" height="56" rx="7" fill="#fff8ec"/>
      <rect x="12" y="10" width="74" height="56" rx="7" fill="none" stroke="#e9dcc4" stroke-width="2"/>
      <path class="ga-ink" pathLength="100" d="M24 48 C 32 22, 44 62, 54 38 S 70 26, 76 44" fill="none" stroke="#ff6b6b" stroke-width="5" stroke-linecap="round"/>
      <path class="ga-ink ga-ink2" pathLength="100" d="M26 58 Q 44 52, 66 58" fill="none" stroke="#3fa9f5" stroke-width="4" stroke-linecap="round"/>
      <g class="ga-palette">
        <path d="M84 50c10-9 28-6 30 7 2 11-7 17-14 13-4-2-6 3-10 2-9-2-13-14-6-22z" fill="#f4c27a"/>
        <circle cx="92" cy="54" r="3.2" fill="#ff6b6b"/><circle cx="101" cy="51" r="3.2" fill="#3fa9f5"/>
        <circle cx="108" cy="58" r="3.2" fill="#7ee0a8"/><circle cx="96" cy="63" r="3" fill="#ffd23f"/>
      </g>
      <g class="ga-brush">
        <path d="M76 44 l4 -6 22 -22 4 4 -22 22z" fill="#8d5a3b"/>
        <path d="M76 44 l4 -6 4 4z" fill="#ff6b6b"/>
        <rect x="83" y="32" width="8" height="5" rx="1" transform="rotate(-45 87 34.5)" fill="#cfd8dc"/>
      </g>`,
    telephone: `
      <path d="M28 70 L37 46 Q40 40 46 40 H74 Q80 40 83 46 L92 70 Z" fill="#e5484d"/>
      <path d="M28 70 H92" stroke="#b83a3e" stroke-width="3" stroke-linecap="round"/>
      <circle cx="60" cy="57" r="10" fill="#fff3e0"/>
      <g fill="#e5484d"><circle cx="60" cy="50.5" r="1.8"/><circle cx="66" cy="54" r="1.8"/><circle cx="66" cy="60" r="1.8"/><circle cx="60" cy="63.5" r="1.8"/><circle cx="54" cy="60" r="1.8"/><circle cx="54" cy="54" r="1.8"/></g>
      <g class="ga-handset">
        <path d="M24 34 Q24 22 38 22 H82 Q96 22 96 34 V36 Q96 41 90 41 H82 Q77 41 77 36 V32 H43 V36 Q43 41 38 41 H30 Q24 41 24 36 Z" fill="#c9363b"/>
      </g>
      <g class="ga-ring" stroke="#ffd27a" stroke-width="2.6" stroke-linecap="round" fill="none">
        <path d="M16 22 q-4 6 0 12"/><path d="M10 19 q-6 9 0 18"/><path d="M104 22 q4 6 0 12"/><path d="M110 19 q6 9 0 18"/>
      </g>
      <g class="ga-bubble">
        <path d="M74 2 H112 Q117 2 117 7 V19 Q117 24 112 24 H90 L84 30 L85 24 H74 Q69 24 69 19 V7 Q69 2 74 2 Z" fill="#fff"/>
        <circle cx="83" cy="13" r="2.4" fill="#0e2a2c"/><circle cx="93" cy="13" r="2.4" fill="#0e2a2c"/><circle cx="103" cy="13" r="2.4" fill="#0e2a2c"/>
      </g>`,
    kart: `
      <path d="M4 68 H116" stroke="rgba(255,255,255,.18)" stroke-width="2" stroke-dasharray="8 7" class="ga-road"/>
      <g class="ga-speed" stroke="#ffd27a" stroke-width="3" stroke-linecap="round"><path d="M2 38 H18"/><path d="M6 48 H20"/><path d="M0 58 H14"/></g>
      <g class="ga-puffs" fill="#e8f3f1"><circle class="ga-puff" cx="16" cy="54" r="4"/><circle class="ga-puff ga-puff2" cx="12" cy="50" r="3"/></g>
      <g class="ga-kart">
        <rect x="18" y="32" width="4" height="16" rx="1" fill="#2b3a40"/>
        <rect x="14" y="30" width="14" height="5" rx="2" fill="#2b3a40"/>
        <path d="M22 56 L30 42 H60 L70 36 H88 Q98 36 100 46 L102 56 Z" fill="#ff7a59"/>
        <path d="M30 42 H60 L66 38" stroke="#ffb59c" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        <path d="M43 40 Q42 22 54 20 Q64 20 64 31 L64 40 Z" fill="#ffd27a"/>
        <path d="M52 27 H64 Q66 27 65.5 30 L64.5 34 H52 Z" fill="#1f3b4d"/>
        <path d="M53 28.5 H58" stroke="#5fa8c9" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M44 33 H51" stroke="#ff7a59" stroke-width="3" stroke-linecap="round"/>
        <g class="ga-wheel"><circle cx="36" cy="58" r="10" fill="#1d2b30"/><circle cx="36" cy="58" r="4" fill="#d8e3e0"/><path d="M36 50 V54" stroke="#d8e3e0" stroke-width="2"/></g>
        <g class="ga-wheel"><circle cx="90" cy="58" r="10" fill="#1d2b30"/><circle cx="90" cy="58" r="4" fill="#d8e3e0"/><path d="M90 50 V54" stroke="#d8e3e0" stroke-width="2"/></g>
      </g>`,
    ballchain: `
      <path d="M4 70 H116" stroke="rgba(255,255,255,.18)" stroke-width="2"/>
      <g class="ga-ball">
        <path d="M24 46 Q34 50 44 48" stroke="#d9b36c" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path d="M96 46 Q86 50 76 48" stroke="#d9b36c" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle cx="60" cy="52" r="17" fill="#3a4a55"/>
        <circle cx="60" cy="52" r="17" fill="none" stroke="#2a363e" stroke-width="2"/>
        <path d="M50 44 a12 12 0 0 1 9 -5" stroke="#8aa0ad" stroke-width="3" fill="none" stroke-linecap="round"/>
        <rect x="56" y="31" width="8" height="5" rx="2" fill="#2a363e"/>
      </g>
      <g class="ga-p1">
        <circle cx="16" cy="34" r="6" fill="#ffb547"/>
        <path d="M17 41 L20 56" stroke="#ffb547" stroke-width="7" stroke-linecap="round"/>
        <path d="M20 56 L14 69 M20 56 L24 69" stroke="#ffb547" stroke-width="4" stroke-linecap="round"/>
        <path d="M18 45 L26 46" stroke="#ffb547" stroke-width="4" stroke-linecap="round"/>
      </g>
      <g class="ga-p2">
        <circle cx="104" cy="34" r="6" fill="#40d2be"/>
        <path d="M103 41 L100 56" stroke="#40d2be" stroke-width="7" stroke-linecap="round"/>
        <path d="M100 56 L106 69 M100 56 L96 69" stroke="#40d2be" stroke-width="4" stroke-linecap="round"/>
        <path d="M102 45 L94 46" stroke="#40d2be" stroke-width="4" stroke-linecap="round"/>
      </g>`,
    controlroom: `
      <g class="ga-blast">
        <path d="M60 2 l5 10 11 -5 -3 11 12 2 -10 7 7 9 -12 -1 -2 12 -8 -9 -8 9 -2 -12 -12 1 7 -9 -10 -7 12 -2 -3 -11 11 5z" fill="#ffd23f"/>
        <circle cx="60" cy="20" r="7" fill="#fff6d6"/>
      </g>
      <rect x="8" y="26" width="104" height="46" rx="9" fill="#2f4858"/>
      <rect x="8" y="26" width="104" height="8" rx="4" fill="#3d5a6c"/>
      <path d="M20 58 a16 16 0 0 1 32 0" fill="#1d2f3a" stroke="#cfe9e4" stroke-width="2"/>
      <g stroke="#cfe9e4" stroke-width="1.6"><path d="M23 50 l3 1.5"/><path d="M36 43 v3"/><path d="M49 50 l-3 1.5"/></g>
      <path class="ga-needle" d="M36 58 L36 45" stroke="#ff6b6b" stroke-width="2.6" stroke-linecap="round"/>
      <circle cx="36" cy="58" r="2.6" fill="#cfe9e4"/>
      <g class="ga-knob ga-knob1"><circle cx="70" cy="50" r="9" fill="#ffb547"/><circle cx="70" cy="50" r="9" fill="none" stroke="#c98a2a" stroke-width="2"/><path d="M70 50 V42.5" stroke="#5a3a08" stroke-width="2.6" stroke-linecap="round"/></g>
      <g class="ga-knob ga-knob2"><circle cx="94" cy="50" r="9" fill="#40d2be"/><circle cx="94" cy="50" r="9" fill="none" stroke="#24998a" stroke-width="2"/><path d="M94 50 V42.5" stroke="#0e2a2c" stroke-width="2.6" stroke-linecap="round"/></g>
      <circle class="ga-lamp" cx="102" cy="30" r="2.6" fill="#ff6b6b"/>
      <circle class="ga-lamp ga-lamp2" cx="94" cy="30" r="2.6" fill="#7ee0a8"/>
      <rect x="62" y="63" width="40" height="4" rx="2" fill="#1d2f3a"/>`,
  };
  const svg = (mode) => (ART[mode] ? `<svg class="game-art ga-${mode}" viewBox="0 0 120 80" aria-hidden="true">${ART[mode]}</svg>` : '');
  window.GameArt = { svg, modes: Object.keys(ART) };
})();
