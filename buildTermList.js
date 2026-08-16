// Encyclopédie Geek — Étape 1 : collecte de la liste des termes
// Parcourt récursivement des catégories Wikipedia tech/geek pour bâtir
// une longue liste de titres d'articles candidats. S'exécute une fois
// (ou de temps en temps pour enrichir), écrit terms.json.

const fs = require('fs');

const USER_AGENT = 'EncyclopedieGeek/1.0 (GitHub Actions; contact: nico)';
const MAX_DEPTH = 3; // profondeur de sous-catégories à explorer (augmenté pour plus de volume)
const MAX_CRAWL_TIME_MS = 40 * 60 * 1000; // sécurité : 40 min max pour la collecte (augmenté vu le rythme plus lent)
const OUTPUT_FILE = 'terms.json';

// Catégories de départ, larges pour couvrir "tous les domaines de
// l'informatique et des nouvelles technologies"
const SEED_CATEGORIES = [
  'Category:Programming languages',
  'Category:Computer hardware',
  'Category:Software',
  'Category:Video games',
  'Category:Video game genres',
  'Category:Internet',
  'Category:World Wide Web',
  'Category:Artificial intelligence',
  'Category:Machine learning',
  'Category:Computer security',
  'Category:Cryptography',
  'Category:Computer networking',
  'Category:Operating systems',
  'Category:Computer science',
  'Category:Data compression',
  'Category:Database management systems',
  'Category:Robotics',
  'Category:Space technology',
  'Category:Consumer electronics',
  'Category:Telecommunications',
  'Category:History of computing hardware',
  'Category:Computer companies',
  'Category:Social networking services',
  'Category:File formats',
  'Category:Computer graphics',
  'Category:Virtual reality',
  'Category:3D printing',
  'Category:Cloud computing',
  'Category:Open-source software',
  'Category:Video game companies',
  'Category:Cryptocurrencies',
  'Category:Wireless networking',
  'Category:File systems',
  'Category:Assembly languages',
  'Category:Esports',
  'Category:Video game development',
  'Category:Mobile operating systems',
  'Category:Web browsers',
  'Category:Search engines',
  'Category:Electronic commerce',
  'Category:Quantum computing',
  'Category:Nanotechnology',
  'Category:Wearable computers',
  'Category:Home computers',
  'Category:Supercomputers',
  'Category:Computer memory',
  'Category:Solid-state drives',
  'Category:Graphics processing units',
  'Category:Central processing unit',
  'Category:Computer peripherals',
  'Category:Motherboard',
  'Category:Computer storage devices',
  'Category:Video game platforms',
  'Category:Emulation software',
  'Category:Free software',
  'Category:Computer humor',
  'Category:Hacker culture',
  'Category:Internet culture',
  'Category:Technology in fiction',
  'Category:Science fiction themes',
  'Category:History of the Internet',
  'Category:Digital media',
  'Category:Audio codecs',
  'Category:Video codecs',
  'Category:Web development software',
  'Category:Integrated development environments',
  'Category:Computer displays',
  'Category:Input devices',
  'Category:Computer fonts',
  'Category:Encryption algorithms',
  'Category:Malware',
];

// Filtre pour écarter les pages qui ne sont pas de vrais articles
function isLikelyArticle(title) {
  const bad = [
    /^List of/i,
    /^Lists of/i,
    /^Timeline of/i,
    /^Comparison of/i,
    /^Category:/,
    /^Template:/,
    /^Portal:/,
    /^Wikipedia:/,
    /^Draft:/,
    /\(disambiguation\)/i,
    /^Outline of/i,
    /^Glossary of/i,
  ];
  return !bad.some((re) => re.test(title));
}

async function fetchCategoryMembers(category, cmtype, cmcontinue, attempt = 1) {
  let url =
    `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers` +
    `&cmtitle=${encodeURIComponent(category)}&cmlimit=500&cmtype=${cmtype}&format=json`;
  if (cmcontinue) url += `&cmcontinue=${encodeURIComponent(cmcontinue)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'EncyclopedieGeek/1.0 (https://github.com/nbbou81000/Geek-almanac)' } });

  if (res.status === 429) {
    if (attempt <= 5) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
      const backoff = attempt * 5000; // 5s, 10s, 15s, 20s, 25s
      const wait = Math.max(retryAfterMs, backoff) + Math.floor(Math.random() * 1000); // + jitter
      console.warn(`  ⚠ ${category} → HTTP 429, retry dans ${wait}ms (tentative ${attempt}/5)`);
      await new Promise((r) => setTimeout(r, wait));
      return fetchCategoryMembers(category, cmtype, cmcontinue, attempt + 1);
    }
    console.error(`  ✗ ${category} → throttle persistant après 5 tentatives, catégorie ignorée`);
    return { members: [], next: null };
  }

  if (!res.ok) {
    if (attempt <= 3) {
      const wait = attempt * 2000;
      console.warn(`  ⚠ ${category} → HTTP ${res.status}, retry dans ${wait}ms (tentative ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, wait));
      return fetchCategoryMembers(category, cmtype, cmcontinue, attempt + 1);
    }
    console.error(`  ✗ ${category} → HTTP ${res.status} après 3 tentatives, catégorie ignorée`);
    return { members: [], next: null };
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (attempt <= 5) {
      const wait = attempt * 5000 + Math.floor(Math.random() * 1000);
      console.warn(`  ⚠ ${category} → réponse non-JSON (throttle probable), retry dans ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return fetchCategoryMembers(category, cmtype, cmcontinue, attempt + 1);
    }
    console.error(`  ✗ ${category} → throttle persistant après 5 tentatives, catégorie ignorée`);
    return { members: [], next: null };
  }

  return {
    members: data.query?.categorymembers || [],
    next: data.continue?.cmcontinue || null,
  };
}

async function collectFromCategory(category, depth, visitedCats, titles) {
  if (visitedCats.has(category) || depth > MAX_DEPTH) return;
  visitedCats.add(category);
  await new Promise((r) => setTimeout(r, 800)); // espacement anti-throttle (augmenté)

  // Articles de cette catégorie
  let cont;
  do {
    const { members, next } = await fetchCategoryMembers(category, 'page', cont);
    members.forEach((m) => {
      if (isLikelyArticle(m.title)) titles.add(m.title);
    });
    cont = next;
  } while (cont);

  // Sous-catégories (récursion limitée en profondeur)
  if (depth < MAX_DEPTH) {
    let subCont;
    const subcats = [];
    do {
      const { members, next } = await fetchCategoryMembers(category, 'subcat', subCont);
      subcats.push(...members);
      subCont = next;
    } while (subCont);

    for (const sub of subcats) {
      await collectFromCategory(sub.title, depth + 1, visitedCats, titles);
    }
  }
}

async function main() {
  const titles = new Set();
  const visitedCats = new Set();
  const startTime = Date.now();

  for (const [i, cat] of SEED_CATEGORIES.entries()) {
    if (Date.now() - startTime > MAX_CRAWL_TIME_MS) {
      console.log(`\n⏰ Limite de temps de collecte atteinte (30 min), arrêt propre avec ${titles.size} termes déjà trouvés.`);
      break;
    }
    console.log(`[${i + 1}/${SEED_CATEGORIES.length}] Exploration ${cat} ...`);
    try {
      await collectFromCategory(cat, 0, visitedCats, titles);
    } catch (err) {
      console.warn(`  ⚠ Erreur sur ${cat}: ${err.message}`);
    }
    console.log(`  → ${titles.size} titres uniques cumulés`);
  }

  const result = Array.from(titles).sort();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n✅ ${result.length} termes candidats écrits dans ${OUTPUT_FILE}`);
}

main();
