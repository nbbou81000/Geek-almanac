// Ephemeride Geek - re-resolution des wiki_url et des images.
//
// Le QR code ET l'image derivent tous deux de wiki_url : une URL mal
// rattachee produit donc deux erreurs visibles a l'ecran.
//
// Strategie (validee sur echantillon) :
//   1. Requete construite sur les termes DISTINCTIFS du titre (noms propres
//      + nombres) plutot que sur la phrase complete, qui dilue la requete
//      et fait remonter des pages generiques.
//   2. Acceptation d'un candidat seulement si :
//        - au moins la moitie de ses mots significatifs sont dans le titre
//        - ET il partage un terme distinctif avec le titre
//      Sans cette 2e condition, on remplace une URL fausse par une autre.
//   3. Si aucun candidat ne passe : on NE devine PAS. wiki_url pointe vers
//      la recherche Wikipedia du titre (toujours pertinent, jamais trompeur)
//      et l'image devient l'icone de la categorie.

const fs = require('fs');
const { execSync } = require('child_process');

const FILE = 'ephemeride.json';
const UA = 'EphemerideGeek/1.0 (https://github.com/nbbou81000/Geek-almanac)';
const ICON_BASE = 'https://nbbou81000.github.io/Geek-almanac/assets/icons';
const PAUSE = 1200; // ms entre appels API

const STOP = new Set(('the a an of in on at to for and or is was were lands land first with by from as ' +
  'its it their his her that this new probe mission announced confirmed discovery largest').split(' '));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sigWords(s) {
  return new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => !STOP.has(w) && w.length > 2));
}

function distinctiveTokens(title) {
  return (String(title).match(/[A-Za-z0-9]+/g) || []).filter((t) =>
    /^[0-9]{2,}$/.test(t) || (/^[A-Z]/.test(t) && t.length > 2 && !STOP.has(t.toLowerCase()))
  );
}

function fallbackIcon(category) {
  const valid = ['hardware', 'software', 'internet', 'gaming', 'space', 'science', 'company', 'culture'];
  const alias = { smartphone: 'hardware', cybersecurity: 'software', security: 'software',
                  language: 'software', protocol: 'internet', music: 'culture' };
  const cat = alias[category] || category;
  return `${ICON_BASE}/${valid.includes(cat) ? cat : 'culture'}.svg`;
}

function searchUrl(title) {
  return 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(title);
}

async function apiGet(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429 || !res.ok) {
      if (attempt <= 3) { await sleep(3000 * attempt); return apiGet(url, attempt + 1); }
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      if (attempt <= 3) { await sleep(3000 * attempt); return apiGet(url, attempt + 1); }
      return null;
    }
  } catch {
    if (attempt <= 2) { await sleep(2000 * attempt); return apiGet(url, attempt + 1); }
    return null;
  }
}

async function fullTextSearch(query) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
    + encodeURIComponent(query) + '&srlimit=5&format=json';
  const data = await apiGet(url);
  return data && data.query && data.query.search ? data.query.search.map((x) => x.title) : [];
}

function scoreCandidate(title, candidate) {
  const a = sigWords(title), b = sigWords(candidate);
  const dist = new Set(distinctiveTokens(title).map((x) => x.toLowerCase()));
  if (!b.size) return 0;
  let hit = 0;
  for (const w of b) if (a.has(w)) hit++;
  const coverage = hit / b.size;
  let sharesDistinctive = false;
  for (const d of dist) if (b.has(d)) sharesDistinctive = true;
  return (coverage >= 0.5 && sharesDistinctive) ? coverage : 0;
}

async function resolveArticle(title) {
  const pick = (cands) => {
    let best = null, bestScore = 0;
    for (const c of cands) {
      const s = scoreCandidate(title, c);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  };

  const distQuery = distinctiveTokens(title).join(' ');
  if (distQuery) {
    const found = pick(await fullTextSearch(distQuery));
    await sleep(PAUSE);
    if (found) return found;
  }
  const found = pick(await fullTextSearch(title));
  await sleep(PAUSE);
  return found;
}

async function fetchThumbnail(articleTitle) {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(articleTitle);
  const data = await apiGet(url);
  await sleep(400);
  if (!data) return null;
  return (data.thumbnail && data.thumbnail.source)
    || (data.originalimage && data.originalimage.source) || null;
}

function commit(label) {
  try {
    execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' });
    execSync(`git add ${FILE}`, { stdio: 'ignore' });
    execSync(`git commit -m "Fix ephemeride links: ${label}" --quiet`, { stdio: 'ignore' });
    execSync('git push --quiet', { stdio: 'ignore' });
    console.log(`  Progression poussee (${label})`);
  } catch { /* rien a committer ou push momentanement impossible */ }
}

async function main() {
  if (!fs.existsSync(FILE)) { console.error(`${FILE} introuvable.`); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const days = Object.keys(data).sort();

  let total = 0, resolved = 0, fellBack = 0, imagesFound = 0;

  for (const [i, day] of days.entries()) {
    const entries = data[day];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      total++;
      const title = entry.title_en || entry.title_fr || '';
      const article = await resolveArticle(title);

      if (article) {
        entry.wiki_url = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(article.replace(/ /g, '_'));
        const thumb = await fetchThumbnail(article);
        if (thumb) { entry.image = thumb; imagesFound++; }
        else entry.image = fallbackIcon(entry.category);
        resolved++;
      } else {
        // Aucun rattachement fiable : on assume l'incertitude.
        entry.wiki_url = searchUrl(title);
        entry.image = fallbackIcon(entry.category);
        fellBack++;
      }
    }

    if (i % 10 === 0) {
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
      commit(`${i + 1}/${days.length} jours`);
      console.log(`[${i + 1}/${days.length}] ${day} - ${resolved} resolus, ${fellBack} en repli`);
    }
  }

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  commit(`termine - ${total} entrees`);

  console.log('\nTermine.');
  console.log(`Entrees traitees      : ${total}`);
  console.log(`Article Wikipedia sur : ${resolved} (${(resolved / total * 100).toFixed(1)}%)`);
  console.log(`  dont avec image     : ${imagesFound}`);
  console.log(`Repli vers recherche  : ${fellBack} (${(fellBack / total * 100).toFixed(1)}%)`);
}

main();
