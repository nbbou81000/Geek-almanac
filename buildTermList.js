// Encyclopédie Geek — Étape 1 : collecte de la liste des termes
// Parcourt récursivement des catégories Wikipedia tech/geek pour bâtir
// une longue liste de titres d'articles candidats. S'exécute une fois
// (ou de temps en temps pour enrichir), écrit terms.json.

const fs = require('fs');

const USER_AGENT = 'EncyclopedieGeek/1.0 (GitHub Actions; contact: nico)';
const MAX_DEPTH = 2; // profondeur de sous-catégories à explorer
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

async function fetchCategoryMembers(category, cmtype, cmcontinue) {
  let url =
    `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers` +
    `&cmtitle=${encodeURIComponent(category)}&cmlimit=500&cmtype=${cmtype}&format=json`;
  if (cmcontinue) url += `&cmcontinue=${encodeURIComponent(cmcontinue)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { members: [], next: null };
  const data = await res.json();
  return {
    members: data.query?.categorymembers || [],
    next: data.continue?.cmcontinue || null,
  };
}

async function collectFromCategory(category, depth, visitedCats, titles) {
  if (visitedCats.has(category) || depth > MAX_DEPTH) return;
  visitedCats.add(category);

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

  for (const [i, cat] of SEED_CATEGORIES.entries()) {
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
