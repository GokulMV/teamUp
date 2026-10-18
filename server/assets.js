// Cache-busting for the page's own CSS/JS: each local asset link in index.html gets ?v=<content hash>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hashes = new Map();
function hashOf(publicDir, urlPath) {
  const file = path.join(publicDir, urlPath);
  if (!file.startsWith(publicDir)) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = hashes.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  hashes.set(file, { hash, mtimeMs: stat.mtimeMs, size: stat.size });
  return hash;
}

// ES modules imported by other modules (relative imports don't carry the ?v= of their parent),
// versioned through the import map instead.
const MODULE_IMPORTS = [
  '/js/games/kart3d/world.js',
  '/js/games/kart3d/track.js',
  '/js/games/kart3d/items3d.js',
  '/js/games/kart3d/driver.js',
  '/js/games/kart3d/gokart.js',
  '/js/games/kart3d/juice.js',
  '/js/games/kart3d/toon.js',
  '/js/games/kart3d/mounts.js',
  '/js/games/kart3d/arena3d.js',
  '/js/games/kart3d/sculpt3d.js',
  '/js/games/kart3d/bright3d.js',
  '/js/games/kart3d/harbour3d.js',
  '/js/games/kart3d/skygarden3d.js',
  '/js/games/kart3d/keep3d.js',
  '/js/games/kart3d/graveyard3d.js',
  '/js/games/kart3d/weekly3d.js',
  '/js/games/kart3d/golf3d.js',
  '/js/games/kart3d/funfair3d.js',
  '/js/games/ballchain3d.js',
  '/js/games/ballchain3d/course.js',
  '/js/games/ballchain3d/figures.js',
];

// The build: one hash over the page and every script and stylesheet it can load. A page left open
// across a deploy compares it with the server's (app.js) and reloads, instead of playing the old
// code against the new server (other maps, another snapshot format).
function buildId(publicDir) {
  const parts = [];
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(path.join(publicDir, dir), { withFileTypes: true }); } catch { return; }
    for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const url = `${dir}/${d.name}`;
      if (d.isDirectory()) walk(url);
      else if (/\.(js|css)$/.test(d.name)) parts.push(`${url}:${hashOf(publicDir, url)}`);
    }
  };
  walk('/js');
  walk('/css');
  parts.push(`/index.html:${hashOf(publicDir, '/index.html')}`);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

function renderIndex(publicDir) {
  let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="teamup-build" content="${buildId(publicDir)}">`);
  html = html.replace(/(src|href)="(\/(?:js|css|vendor\/moonlit)\/[^"?]+\.(?:js|css))"/g, (m, attr, url) => {
    const h = hashOf(publicDir, url);
    return h ? `${attr}="${url}?v=${h}"` : m;
  });
  html = html.replace(/"imports":\s*\{/, (m) => {
    const extra = MODULE_IMPORTS.map((url) => {
      const h = hashOf(publicDir, url);
      return h ? ` "${url}": "${url}?v=${h}",` : '';
    }).join('');
    return `${m}${extra}`;
  });
  return html;
}

module.exports = { renderIndex, buildId };
