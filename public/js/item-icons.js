// Power-up icons drawn as inline SVG (consistent on every device, unlike emoji). One flat glyph
// style: a white shape with a single accent in the item's category colour (--ia), no outlines,
// gradients or faces, so they read at a glance and sit cleanly in the HUD.
(function () {
  const W = '#ffffff';
  const A = 'var(--ia, #ffb547)';
  const CUT = 'var(--ic, #0d1f22)'; // holes cut through a glyph (eyes, the bomb's shine)
  // A missile pointing up-right at (x, y), scale s.
  const missile = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s}) rotate(45)">
      <path d="M0 -24 C7 -17 8 -8 7 8 H-7 C-8 -8 -7 -17 0 -24Z" fill="${W}"/>
      <path d="M-7 0 L-14 12 H-7Z M7 0 L14 12 H7Z" fill="${A}"/>
      <path d="M-4 10 L0 22 L4 10Z" fill="${A}"/>
    </g>`;
  const spikeRing = (n, r0, r1, w) => Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n;
    const p = (r, da) => `${(32 + Math.cos(a + da) * r).toFixed(1)} ${(32 + Math.sin(a + da) * r).toFixed(1)}`;
    return `M${p(r0, -w)} L${p(r1, 0)} L${p(r0, w)}Z`;
  }).join(' ');
  const ICONS = {
    boost: () => `<path d="M10 14 H22 L36 32 L22 50 H10 L24 32Z" fill="${W}"/><path d="M30 14 H42 L56 32 L42 50 H30 L44 32Z" fill="${A}"/>`,
    rocket: () => missile(31, 33, 1.38),
    triple: () => `${missile(18, 45, 0.74)}${missile(46, 45, 0.74)}${missile(32, 20, 0.74)}`,
    banana: () => `<path d="M11 16 C7 44 28 60 57 49 C59 48 58 43 55 43 C38 45 26 36 25 16Z" fill="${W}"/><path d="M11 17 L13 8 H23 L25 17Z" fill="${A}"/><path d="M55 43 C58 43 59 47 57 49 L52 50Z" fill="${A}"/>`,
    shield: () => `<path d="M32 6 L53 14 V31 C53 45 44 53 32 58 C20 53 11 45 11 31 V14Z" fill="${W}"/><path d="M32 18 L42 23 V32 C42 39 38 43 32 46Z" fill="${A}"/>`,
    mine: () => `<path d="${spikeRing(8, 15, 27, 0.17)}" fill="${W}"/><circle cx="32" cy="32" r="16" fill="${W}"/><circle cx="32" cy="32" r="6" fill="${A}"/>`,
    minigun: () => `<rect x="6" y="21" width="16" height="22" rx="4" fill="${W}"/><rect x="22" y="19" width="30" height="6" rx="3" fill="${W}"/><rect x="22" y="29" width="32" height="6" rx="3" fill="${W}"/><rect x="22" y="39" width="30" height="6" rx="3" fill="${W}"/><path d="M55 22 L62 32 L55 42Z" fill="${A}"/>`,
    bomb: () => `<circle cx="28" cy="38" r="19" fill="${W}"/><path d="M20 30 A10 10 0 0 1 28 25" stroke="${CUT}" stroke-width="3.5" stroke-linecap="round" fill="none" opacity="0.35"/><path d="M38 22 L44 16" stroke="${W}" stroke-width="6" stroke-linecap="round"/><path d="M50 5 L53 11 L59 10 L55 15 L58 20 L52 18 L48 22 L48 16 L43 14 L49 11Z" fill="${A}"/>`,
    shock: () => `<circle cx="32" cy="32" r="25" fill="none" stroke="${A}" stroke-width="4" stroke-dasharray="7 6"/><path d="M36 9 L17 37 H30 L26 55 L47 26 H34Z" fill="${W}"/>`,
    ghost: () => `<path d="M13 56 V28 C13 15 22 7 32 7 C42 7 51 15 51 28 V56 L44 50 L38 56 L32 50 L26 56 L20 50Z" fill="${W}"/><ellipse cx="25" cy="29" rx="4" ry="5.5" fill="${A}"/><ellipse cx="39" cy="29" rx="4" ry="5.5" fill="${A}"/>`,
    bouncer: () => `<path d="M8 42 C8 24 19 13 32 13 C45 13 56 24 56 42Z" fill="${W}"/><rect x="5" y="40" width="54" height="9" rx="4.5" fill="${A}"/><path d="M24 24 L32 19 L40 24 V33 L32 38 L24 33Z" fill="${A}" opacity="0.55"/>`,
    comet: () => `<path d="M35 14 C22 26 12 40 4 60 C20 52 36 43 50 30Z" fill="${A}" opacity="0.85"/><circle cx="43" cy="21" r="13" fill="${W}"/>`,
    star: () => `<path d="M32 5 L40 22 L59 24.5 L45 37.5 L49 57 L32 47.5 L15 57 L19 37.5 L5 24.5 L24 22Z" fill="${W}"/><path d="M32 20 L35.5 27.5 L44 28.5 L37.8 34.2 L39.5 42.5 L32 38.3 L24.5 42.5 L26.2 34.2 L20 28.5 L28.5 27.5Z" fill="${A}"/>`,
    ink: () => `<path d="M30 7 C36 7 37 14 42 13 C49 11 55 17 51 23 C49 27 57 30 55 36 C54 43 46 42 44 47 C42 52 36 56 30 52 C25 49 20 55 15 50 C10 45 15 39 11 35 C6 30 9 23 15 22 C20 21 18 14 23 10 C25 8 27 7 30 7Z" fill="${W}"/><circle cx="56" cy="12" r="4" fill="${A}"/><circle cx="7" cy="49" r="3.5" fill="${A}"/><path d="M34 52 Q37 62 33 62 Q29 62 31 53Z" fill="${A}"/>`,
    thunder: () => `<path d="M16 38 C7 38 5 27 13 24 C13 14 25 9 30 16 C33 7 47 7 49 18 C57 17 61 27 56 32 C59 36 56 40 51 40 H18Z" fill="${W}"/><path d="M34 32 L22 50 H31 L26 62 L46 42 H37 L43 32Z" fill="${A}"/>`,
    snowball: () => `<path d="M4 42 L16 38 M7 51 L18 46 M13 59 L22 52" stroke="${A}" stroke-width="4" stroke-linecap="round"/><circle cx="38" cy="31" r="21" fill="${W}"/><path d="M38 21 V41 M29.3 26 L46.7 36 M29.3 36 L46.7 26" stroke="${A}" stroke-width="3.2" stroke-linecap="round"/>`,
    sticky: () => `<path d="M13 36 C11 22 21 11 34 11 C47 11 55 21 53 34 C52 41 55 44 53 50 C51 55 46 52 44 55 C42 59 37 60 35 56 C33 52 28 58 24 54 C20 50 22 46 18 45 C14 44 13 40 13 36Z" fill="${W}"/><circle cx="35" cy="30" r="8" fill="${A}"/>`,
    spikes: () => `<path d="${spikeRing(8, 15, 30, 0.3)}" fill="${W}"/><circle cx="32" cy="32" r="16" fill="${W}"/><circle cx="32" cy="32" r="8" fill="${A}"/>`,
    decoy: () => `<rect x="10" y="10" width="44" height="44" rx="9" fill="${W}"/><g transform="rotate(180 32 33)"><path d="M25 27 C25 21 29 19 32.5 19 C36.5 19 40 22 40 26 C40 31 33 32 33 37 V39" stroke="${A}" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="33" cy="46" r="3.2" fill="${A}"/></g>`,
  };
  // Kill feed only (not items).
  const EXTRA = {
    lava: () => `<path d="M32 4 C40 18 53 24 50 40 C48 54 40 60 32 60 C24 60 16 54 14 40 C12 26 26 20 32 4Z" fill="#ff7a2a"/><path d="M32 30 C36 38 43 41 40 48 C38 55 26 55 24 48 C22 41 30 38 32 30Z" fill="${W}"/>`,
    boom: () => `<path d="M32 4 L37 20 L52 10 L45 26 L61 30 L46 37 L55 52 L39 45 L34 61 L28 45 L12 54 L19 38 L3 32 L19 26 L11 11 L27 19Z" fill="${W}"/><circle cx="32" cy="32" r="9" fill="#ff7a2a"/>`,
  };
  // Each item's family, which gives its accent colour in the HUD, the lobby and the kill feed.
  const KIND = {
    boost: 'speed', star: 'rare', comet: 'rare', thunder: 'rare',
    rocket: 'attack', triple: 'attack', bouncer: 'attack', minigun: 'attack', bomb: 'attack', shock: 'attack', snowball: 'attack', sticky: 'attack', ink: 'attack',
    banana: 'trap', mine: 'trap', spikes: 'trap', decoy: 'trap',
    shield: 'defence', ghost: 'defence',
  };
  const COLOR = { speed: '#4fe3a0', attack: '#ff5f57', trap: '#ffb547', defence: '#5cc8ff', rare: '#b98cff' };
  const NAMES = {
    boost: 'Boost', rocket: 'Homing rocket', triple: 'Triple rockets', banana: 'Banana', shield: 'Shield',
    mine: 'Mine', minigun: 'Minigun', bomb: 'Bomb', shock: 'Shock wave', ghost: 'Ghost',
    bouncer: 'Bouncer shell', comet: 'Comet', star: 'Star power', ink: 'Ink splat', thunder: 'Thunder',
    snowball: 'Snowball', sticky: 'Sticky bomb', spikes: 'Spin spikes', decoy: 'Decoy box',
  };
  const DESCRIPTIONS = {
    boost: 'Instant burst of speed', rocket: 'Locks on to the rival ahead', triple: 'Three homing rockets', banana: 'Drop behind to spin out chasers',
    shield: 'Blocks the next hit', mine: 'Hidden trap, big blast', minigun: 'Two seconds of rapid fire', bomb: 'Lob it over karts, area blast',
    shock: 'Zaps everyone around you', ghost: 'Untouchable for 4 seconds',
    bouncer: 'Ricochets off walls. Brake to throw it back', comet: 'Hunts down the leader from the sky',
    star: 'Invincible and faster. Ram rivals', ink: 'Blots out the screens of karts ahead', thunder: 'Strikes every rival: spin, shrink, slow',
    snowball: 'Freezes a rival solid. Hit them again to shatter the ice', sticky: 'Sticks to a kart and goes off. Bump someone to pass it on',
    spikes: 'A spiked ring for 4 seconds: touch rivals to spin them out', decoy: 'Looks like an item box. Blows up whoever grabs it',
  };
  const kind = (id) => KIND[id] || 'attack';
  const color = (id) => COLOR[kind(id)];
  window.ItemIcons = {
    ids: Object.keys(ICONS),
    name: (id) => NAMES[id] || id,
    description: (id) => DESCRIPTIONS[id] || '',
    kind,
    color,
    svg(id, cls = 'item-icon') {
      const make = ICONS[id] || EXTRA[id];
      return `<svg viewBox="0 0 64 64" class="${cls}" style="--ia:${color(id)}" aria-hidden="true">${make ? make() : ''}</svg>`;
    },
  };
})();
