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
  // === PRIORITÉ 1 : smartphones (quasi absents du pool actuel) ===
  'Category:Smartphones',
  'Category:Android (operating system) devices',
  'Category:IPhone',
  'Category:Samsung Galaxy',
  'Category:Nokia mobile phones',
  'Category:Sony Ericsson mobile phones',
  'Category:Huawei mobile phones',
  'Category:Xiaomi mobile phones',
  'Category:Google Pixel',
  'Category:LG mobile phones',
  'Category:Motorola mobile phones',
  'Category:HTC mobile phones',
  'Category:BlackBerry devices',
  'Category:Windows Phone devices',
  'Category:OnePlus mobile phones',
  'Category:Oppo mobile phones',
  'Category:Mobile phones by manufacturer',

  // === PRIORITÉ 2 : espace ===
  'Category:Spacecraft',
  'Category:Space probes',
  'Category:Human spaceflight',
  'Category:Rocket engines',
  'Category:Astronautics',
  'Category:NASA programs and missions',
  'Category:Orbital launch systems',
  'Category:Satellites',
  'Category:Mars exploration',
  'Category:Moon landing',
  'Category:Space telescopes',
  'Category:Space technology',

  // === PRIORITÉ 3 : cybersécurité ===
  'Category:Cybersecurity companies',
  'Category:Computer security organizations',
  'Category:Cyberattacks',
  'Category:Data breaches',
  'Category:Computer worms',
  'Category:Ransomware',
  'Category:Computer crime',
  'Category:Cyberwarfare',
  'Category:Hacking (computer security)',
  'Category:Security hackers',
  'Category:Antivirus software',
  'Category:Encryption algorithms',
  'Category:Malware',
  'Category:Cryptography',
  'Category:Computer security',
  'Category:Privacy',
  'Category:Surveillance',

  // === PRIORITÉ 4 : entreprises tech ===
  'Category:Technology companies',
  'Category:Software companies',
  'Category:Internet companies',
  'Category:American technology companies',
  'Category:Technology companies by country',
  'Category:Defunct computer companies',
  'Category:Computer companies',
  'Category:Video game companies',

  // === PRIORITÉ 5 : science, culture, histoire ===
  'Category:Computer pioneers',
  'Category:Computer scientists',
  'Category:Techno-utopianism',
  'Category:Internet memes',
  'Category:Technology journalists',
  'Category:Science fiction writers',
  'Category:Cyberpunk',
  'Category:Hacker culture',
  'Category:Internet culture',
  'Category:Technology in fiction',
  'Category:Science fiction themes',
  'Category:History of the Internet',
  'Category:Computer humor',

  // === PRIORITÉ 6 (déjà bien fourni, traité en dernier si le temps le permet) ===
  'Category:Programming languages',
  'Category:Artificial intelligence',
  'Category:Machine learning',
  'Category:Computer networking',
  'Category:Operating systems',
  'Category:Computer science',
  'Category:Data compression',
  'Category:Database management systems',
  'Category:Robotics',
  'Category:Consumer electronics',
  'Category:Telecommunications',
  'Category:History of computing hardware',
  'Category:Social networking services',
  'Category:File formats',
  'Category:Computer graphics',
  'Category:Virtual reality',
  'Category:3D printing',
  'Category:Cloud computing',
  'Category:Open-source software',
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
  'Category:Digital media',
  'Category:Audio codecs',
  'Category:Video codecs',
  'Category:Web development software',
  'Category:Integrated development environments',
  'Category:Computer displays',
  'Category:Input devices',
  'Category:Computer fonts',
  'Category:Internet',
  'Category:World Wide Web',
  'Category:Computer hardware',
  'Category:Software',
  'Category:Video games',
  'Category:Video game genres',
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

async function collectFromCategory(category, depth, visitedCats, titles, deadline) {
  if (Date.now() > deadline) return; // sécurité : coupe même en pleine récursion
  if (visitedCats.has(category) || depth > MAX_DEPTH) return;
  visitedCats.add(category);
  await new Promise((r) => setTimeout(r, 800)); // espacement anti-throttle (augmenté)

  // Articles de cette catégorie
  let cont;
  do {
    if (Date.now() > deadline) return;
    const { members, next } = await fetchCategoryMembers(category, 'page', cont);
    members.forEach((m) => {
      if (isLikelyArticle(m.title)) titles.add(m.title);
    });
    cont = next;
  } while (cont);

  // Sous-catégories (récursion limitée en profondeur)
  if (depth < MAX_DEPTH) {
    if (Date.now() > deadline) return;
    let subCont;
    const subcats = [];
    do {
      if (Date.now() > deadline) break;
      const { members, next } = await fetchCategoryMembers(category, 'subcat', subCont);
      subcats.push(...members);
      subCont = next;
    } while (subCont);

    for (const sub of subcats) {
      if (Date.now() > deadline) return;
      await collectFromCategory(sub.title, depth + 1, visitedCats, titles, deadline);
    }
  }
}

async function main() {
  const titles = new Set();
  const visitedCats = new Set();
  const startTime = Date.now();
  const deadline = startTime + MAX_CRAWL_TIME_MS;

  for (const [i, cat] of SEED_CATEGORIES.entries()) {
    if (Date.now() > deadline) {
      console.log(`\n⏰ Limite de temps de collecte atteinte (${MAX_CRAWL_TIME_MS / 60000} min), arrêt propre avec ${titles.size} termes déjà trouvés.`);
      break;
    }
    console.log(`[${i + 1}/${SEED_CATEGORIES.length}] Exploration ${cat} ...`);
    try {
      await collectFromCategory(cat, 0, visitedCats, titles, deadline);
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
