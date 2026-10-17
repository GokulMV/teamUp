// Power-up icons drawn as inline SVG (consistent on every device, unlike emoji).
(function () {
  const defs = (id, stops) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs>`;
  const rocket = (x, y, s, gid) => `<g transform="translate(${x} ${y}) scale(${s}) rotate(45)">
      <path d="M0 -26 C9 -18 11 -6 9 10 L-9 10 C-11 -6 -9 -18 0 -26Z" fill="url(#${gid})"/>
      <path d="M0 -26 C5 -21 7 -16 7.5 -12 L-7.5 -12 C-7 -16 -5 -21 0 -26Z" fill="#fff"/>
      <circle cx="0" cy="-3" r="4" fill="#bae6fd" stroke="#fff" stroke-width="1.6"/>
      <path d="M-9 2 L-16 14 L-9 12Z M9 2 L16 14 L9 12Z" fill="#b91c1c"/>
      <path d="M-5 10 Q0 26 5 10Z" fill="#fbbf24"/><path d="M-2.5 10 Q0 19 2.5 10Z" fill="#fff7cc"/>
    </g>`;
  const flake = (x, y, r, c = '#e0f2fe') => `<path d="M${x - r} ${y} H${x + r} M${x - r / 2} ${y - r * 0.87} L${x + r / 2} ${y + r * 0.87} M${x - r / 2} ${y + r * 0.87} L${x + r / 2} ${y - r * 0.87}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`;
  // Eight steel spikes round a hub (spin spikes).
  const spikeRing = () => Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const p = (r, da) => `${(32 + Math.cos(a + da) * r).toFixed(1)} ${(32 + Math.sin(a + da) * r).toFixed(1)}`;
    return `M${p(14, -0.3)} L${p(29, 0.08)} L${p(14, 0.3)}Z`;
  }).join(' ');
  const sparkle = (x, y, r, fill = '#fff') => `<path d="M${x} ${y - r} Q${x + r * 0.2} ${y - r * 0.2} ${x + r} ${y} Q${x + r * 0.2} ${y + r * 0.2} ${x} ${y + r} Q${x - r * 0.2} ${y + r * 0.2} ${x - r} ${y} Q${x - r * 0.2} ${y - r * 0.2} ${x} ${y - r}Z" fill="${fill}"/>`;
  const ICONS = {
    boost: () => `${defs('ib', [[0, '#fff3b0'], [0.5, '#ffb547'], [1, '#ff4f1f']])}
      <path d="M14 14 L34 32 L14 50 L22 50 L42 32 L22 14Z" fill="url(#ib)"/>
      <path d="M30 14 L50 32 L30 50 L38 50 L58 32 L38 14Z" fill="url(#ib)" opacity="0.85"/>`,
    rocket: () => `${defs('ir', [[0, '#ff6b6b'], [1, '#dc2626']])}${rocket(32, 32, 1, 'ir')}`,
    triple: () => `${defs('it', [[0, '#ff6b6b'], [1, '#dc2626']])}${rocket(18, 40, 0.62, 'it')}${rocket(46, 40, 0.62, 'it')}${rocket(32, 22, 0.62, 'it')}`,
    banana: () => `${defs('ia', [[0, '#fff27a'], [1, '#f5b700']])}
      <path d="M14 18 C10 36 22 54 46 52 C52 51 54 47 50 45 C32 46 22 34 22 18 Z" fill="url(#ia)" stroke="#a16207" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M14 18 L17 10 L22 18" fill="#7c4a12"/><path d="M21 26 C23 36 30 42 40 44" stroke="#fde68a" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    shield: () => `${defs('is', [[0, '#7dd3fc'], [1, '#2563eb']])}
      <path d="M32 8 L52 15 V31 C52 44 43 52 32 56 C21 52 12 44 12 31 V15Z" fill="url(#is)" stroke="#e0f2fe" stroke-width="3" stroke-linejoin="round"/>
      <path d="M32 16 V48 C40 44 45 38 45 30 V20Z" fill="#fff" opacity="0.25"/>`,
    mine: () => `${defs('im', [[0, '#6b7280'], [1, '#1f2937']])}
      ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="30" y="8" width="4" height="10" rx="2" fill="#4b5563" transform="rotate(${i * 45} 32 34)"/>`).join('')}
      <circle cx="32" cy="34" r="16" fill="url(#im)" stroke="#9ca3af" stroke-width="2"/>
      <circle cx="32" cy="34" r="5.5" fill="#ef4444"/><circle cx="30" cy="32" r="2" fill="#fecaca"/>`,
    minigun: () => `${defs('ig', [[0, '#e5e7eb'], [1, '#6b7280']])}
      <rect x="8" y="22" width="18" height="20" rx="5" fill="#374151"/>
      <rect x="22" y="20" width="32" height="6" rx="3" fill="url(#ig)"/><rect x="22" y="29" width="34" height="6" rx="3" fill="url(#ig)"/><rect x="22" y="38" width="32" height="6" rx="3" fill="url(#ig)"/>
      <rect x="20" y="18" width="5" height="28" rx="2" fill="#4b5563"/><path d="M56 26 L62 32 L56 38" fill="#fbbf24"/>`,
    bomb: () => `${defs('ix', [[0, '#4b5563'], [1, '#111827']])}
      <circle cx="28" cy="38" r="18" fill="url(#ix)"/><circle cx="22" cy="31" r="5" fill="#fff" opacity="0.25"/>
      <rect x="35" y="15" width="10" height="9" rx="2" fill="#6b7280" transform="rotate(35 40 20)"/>
      <path d="M43 16 Q48 8 54 10" stroke="#a16207" stroke-width="2.5" fill="none"/>
      <path d="M55 4 L57 9 L62 8 L58 12 L61 16 L56 14 L53 18 L53 12 L48 11 L53 9Z" fill="#fbbf24"/>`,
    shock: () => `${defs('iq', [[0, '#e0f2fe'], [1, '#38bdf8']])}
      <circle cx="32" cy="32" r="22" fill="none" stroke="#38bdf8" stroke-width="3" stroke-dasharray="6 5" opacity="0.8"/>
      <path d="M36 8 L18 36 H30 L26 56 L46 26 H34Z" fill="url(#iq)" stroke="#0369a1" stroke-width="2" stroke-linejoin="round"/>`,
    ghost: () => `${defs('ih', [[0, '#ffffff'], [1, '#c7d2fe']])}
      <path d="M14 54 V28 C14 16 22 8 32 8 C42 8 50 16 50 28 V54 L44 48 L38 54 L32 48 L26 54 L20 48Z" fill="url(#ih)" stroke="#818cf8" stroke-width="2.5" stroke-linejoin="round"/>
      <ellipse cx="25" cy="28" rx="3.5" ry="5" fill="#312e81"/><ellipse cx="39" cy="28" rx="3.5" ry="5" fill="#312e81"/>
      <ellipse cx="32" cy="38" rx="4" ry="3" fill="#312e81"/>`,
    // A domed shell with hex plates on a white rim, plus bounce marks.
    bouncer: () => `${defs('ic', [[0, '#86f7cf'], [0.55, '#10b981'], [1, '#047857']])}
      <path d="M5 21 Q8 13 14 15 M50 9 Q56 5 59 11" stroke="#6ee7b7" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="32" cy="51" rx="22" ry="4.5" fill="#000" opacity="0.2"/>
      <path d="M9 42 C9 25 19 14 32 14 C45 14 55 25 55 42Z" fill="url(#ic)" stroke="#064e3b" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M32 19 L40 23.5 L40 32 L32 36.5 L24 32 L24 23.5Z" fill="#d1fae5" fill-opacity="0.45" stroke="#064e3b" stroke-width="1.6"/>
      <path d="M24 32 L17 37 M40 32 L47 37 M32 36.5 V41 M24 23.5 L17 21 M40 23.5 L47 21" stroke="#064e3b" stroke-width="1.6"/>
      <path d="M18 24 C20 19 24 16.5 28 16" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.75"/>
      <rect x="6" y="39" width="52" height="9" rx="4.5" fill="#f8fafc" stroke="#064e3b" stroke-width="2.5"/>`,
    // A blazing core with a long tail, diving from the top right.
    comet: () => `<defs><linearGradient id="ie" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e0e7ff"/><stop offset="0.45" stop-color="#818cf8" stop-opacity="0.85"/><stop offset="1" stop-color="#4338ca" stop-opacity="0"/></linearGradient>
      <radialGradient id="io"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#bae6fd"/><stop offset="1" stop-color="#3b82f6"/></radialGradient></defs>
      <path d="M33 12 C20 25 10 40 3 61 C19 52 35 44 52 31Z" fill="url(#ie)"/>
      <path d="M12 45 L24 34 M19 53 L31 43 M28 26 L22 31" stroke="#eef2ff" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>
      <path d="M43 3 L46 13 L56 10 L50 18 L60 23 L49 25 L52 35 L44 29 L39 38 L37 28 L27 29 L34 22 L28 14 L38 16Z" fill="#fde047" stroke="#f59e0b" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="42" cy="21" r="8.5" fill="url(#io)" stroke="#fff" stroke-width="2"/>`,
    // Rainbow star with sparkles.
    star: () => `<defs><linearGradient id="iy" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff59d"/><stop offset="0.28" stop-color="#fbbf24"/><stop offset="0.52" stop-color="#f472b6"/><stop offset="0.76" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
      <path d="M32 5 L40 22 L59 24.5 L45 37.5 L49 57 L32 47.5 L15 57 L19 37.5 L5 24.5 L24 22Z" fill="url(#iy)" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
      <path d="M32 15 L36.5 25 L47 26.5 L39 33.5 L41 44 L32 39 L23 44 L25 33.5 L17 26.5 L27.5 25Z" fill="#fff" opacity="0.28"/>
      <path d="M26 21 L31 11" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
      ${sparkle(55, 8, 5)}${sparkle(8, 9, 3.5, '#fde68a')}${sparkle(57, 50, 3.5, '#bae6fd')}`,
    // A glossy ink splat with drips.
    ink: () => `<defs><linearGradient id="ik" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="0.5" stop-color="#3b0764"/><stop offset="1" stop-color="#0f0a1e"/></linearGradient></defs>
      <path d="M30 7 C36 7 37 14 42 13 C49 11 55 17 51 23 C49 27 57 30 55 36 C54 43 46 42 44 47 C42 52 36 56 30 52 C25 49 20 55 15 50 C10 45 15 39 11 35 C6 30 9 23 15 22 C20 21 18 14 23 10 C25 8 27 7 30 7Z" fill="url(#ik)" stroke="#c4b5fd" stroke-width="2"/>
      <path d="M36 50 Q39 61 35 62 Q31 61 33 51Z M20 50 Q21 57 18 58 Q15 57 17 51Z" fill="#2e1065"/>
      <circle cx="56" cy="12" r="3.5" fill="#5b21b6"/><circle cx="7" cy="48" r="3" fill="#4c1d95"/><circle cx="52" cy="54" r="2.5" fill="#4c1d95"/>
      <path d="M20 21 Q24 15 31 15.5" stroke="#ede9fe" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.85"/>
      <circle cx="37" cy="20" r="2" fill="#ede9fe" opacity="0.7"/>`,
    // Storm cloud with a lightning bolt.
    thunder: () => `<defs><linearGradient id="iw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#94a3b8"/></linearGradient>
      <linearGradient id="iu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbeb"/><stop offset="0.5" stop-color="#fde047"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
      <path d="M33 30 L21 48 H30 L25 62 L45 39 H36 L42 30Z" fill="url(#iu)" stroke="#b45309" stroke-width="2" stroke-linejoin="round"/>
      <path d="M16 35 C8 35 6 25 13 22 C13 13 24 9 29 15 C32 7 45 7 47 17 C55 16 59 25 55 30 C58 34 55 38 50 38 L18 38 C17 38 16 37 16 35Z" fill="url(#iw)" stroke="#475569" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M20 22 C21 17 26 15 30 18" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>
      <path d="M12 46 L8 50 M52 45 L57 49 M47 54 L50 58" stroke="#fde047" stroke-width="2.6" stroke-linecap="round"/>`,
    // A packed snowball flying in, frost on it.
    snowball: () => `<defs><radialGradient id="is" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#dbeafe"/><stop offset="1" stop-color="#7fb4ea"/></radialGradient></defs>
      <path d="M4 42 L17 38 M7 50 L19 45 M12 58 L23 51" stroke="#93c5fd" stroke-width="3" stroke-linecap="round" opacity="0.85"/>
      <circle cx="37" cy="31" r="20" fill="url(#is)" stroke="#2563eb" stroke-width="2.4"/>
      <circle cx="44" cy="39" r="3.2" fill="#bfdbfe"/><circle cx="31" cy="41" r="2.2" fill="#bfdbfe"/><circle cx="47" cy="27" r="2" fill="#bfdbfe"/>
      <path d="M26 23 Q30 15 39 15" stroke="#fff" stroke-width="3.2" stroke-linecap="round" fill="none"/>
      ${flake(55, 9, 6)}${flake(8, 14, 4, '#bae6fd')}`,
    // A gooey pink bomb that sticks, its light blinking.
    sticky: () => `<defs><radialGradient id="it" cx="0.38" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffc2e4"/><stop offset="0.55" stop-color="#ec4899"/><stop offset="1" stop-color="#9d174d"/></radialGradient></defs>
      <path d="M14 36 C12 22 22 12 34 12 C46 12 54 21 52 34 C51 41 54 44 52 50 C50 55 45 52 43 55 C41 59 36 60 34 56 C32 52 27 58 23 54 C19 50 21 46 17 45 C13 44 14 40 14 36Z" fill="url(#it)" stroke="#831843" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M26 55 Q27 63 24 63 Q21 62 23 56Z" fill="#be185d"/>
      <path d="M21 27 Q25 18 33 17" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>
      <circle cx="39" cy="24" r="7" fill="#7f1d1d"/><circle cx="39" cy="24" r="4.5" fill="#ef4444" stroke="#fecaca" stroke-width="1.4"/>
      <path d="M50 13 Q54 16 54 21 M54 7 Q61 13 60 22" stroke="#fde047" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
    // A spinning ring of steel spikes.
    spikes: () => `<defs><linearGradient id="ip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#64748b"/></linearGradient></defs>
      <path d="M8 20 A27 27 0 0 1 20 7 M56 44 A27 27 0 0 1 44 57" stroke="#fbbf24" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path d="${spikeRing()}" fill="url(#ip)" stroke="#334155" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="32" cy="32" r="15" fill="#334155" stroke="url(#ip)" stroke-width="4.5"/>
      <circle cx="32" cy="32" r="6.5" fill="url(#ip)" stroke="#1e293b" stroke-width="2"/>`,
    // An item box with horns and an upside-down question mark: not the real thing.
    decoy: () => `<defs><linearGradient id="iq" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fda4af"/><stop offset="0.5" stop-color="#c084fc"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs>
      <path d="M17 17 L11 5 L24 13Z M47 17 L53 5 L40 13Z" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.6" stroke-linejoin="round"/>
      <rect x="12" y="14" width="40" height="40" rx="8" fill="url(#iq)" stroke="#fff" stroke-width="2.6" transform="rotate(-6 32 34)"/>
      <g transform="rotate(174 32 34)"><path d="M25 27 C25 21 29 19 32.5 19 C36.5 19 40 22 40 26 C40 31 33 32 33 37 V39" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/><circle cx="33" cy="46" r="3" fill="#fff"/></g>`,
  };
  // Kill feed only (not items).
  const EXTRA = {
    lava: () => `${defs('iL', [[0, '#fde047'], [0.5, '#f97316'], [1, '#b91c1c']])}
      <path d="M32 4 C40 18 53 24 50 40 C48 54 40 60 32 60 C24 60 16 54 14 40 C12 26 26 20 32 4Z" fill="url(#iL)"/>
      <path d="M32 30 C36 38 43 41 40 48 C38 55 26 55 24 48 C22 41 30 38 32 30Z" fill="#fff3b0"/>`,
    boom: () => `${defs('iB', [[0, '#fff3b0'], [0.5, '#fb923c'], [1, '#dc2626']])}
      <path d="M32 4 L37 20 L52 10 L45 26 L61 30 L46 37 L55 52 L39 45 L34 61 L28 45 L12 54 L19 38 L3 32 L19 26 L11 11 L27 19Z" fill="url(#iB)" stroke="#9a3412" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="32" cy="32" r="8" fill="#fffbeb"/>`,
  };
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
  let uid = 0;
  window.ItemIcons = {
    ids: Object.keys(ICONS),
    name: (id) => NAMES[id] || id,
    description: (id) => DESCRIPTIONS[id] || '',
    // Gradient ids are made unique per icon so many icons can share a page.
    svg(id, cls = 'item-icon') {
      const make = ICONS[id] || EXTRA[id];
      const body = make ? make() : '';
      const n = ++uid;
      return `<svg viewBox="0 0 64 64" class="${cls}" aria-hidden="true">${body.replace(/id="(i\w)"/g, `id="$1${n}"`).replace(/url\(#(i\w)\)/g, `url(#$1${n})`)}</svg>`;
    },
  };
})();
