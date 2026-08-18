// Éphéméride Geek — correction des wiki_url/images mal rattachés
// Contrairement à la version précédente qui ne faisait confiance qu'au
// wiki_url existant, celle-ci repart du titre de l'article et cherche
// activement la vraie page Wikipedia correspondante (préfixes/suffixes
// progressifs), pour corriger aussi les cas où wiki_url pointe carrément
// vers un article totalement différent (pas juste une image manquante).

const fs = require('fs');

const USER_AGENT = 'EphemerideGeek/1.0 (https://github.com/nbbou81000/Geek-almanac)';
const OUTPUT_FILE = 'ephemeride.json';
const FALLBACK_ICON_BASE = 'https://nbbou81000.github.io/Geek-almanac/assets/icons';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fallbackIcon(category) {
  const valid = ['hardware', 'software', 'internet', 'gaming', 'space', 'science', 'company', 'culture'];
  const cat = valid.includes(category) ? category : 'culture';
  return `${FALLBACK_ICON_BASE}/${cat}.svg`;
}

async function searchWikipedia(query, attempt = 1) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      if (attempt <= 3) {
        await sleep(attempt * 2000);
        return searchWikipedia(query, attempt + 1);
      }
      return null;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Réponse non-JSON = throttle probable
      if (attempt <= 3) {
        await sleep(attempt * 2000);
        return searchWikipedia(query, attempt + 1);
      }
      return null;
    }
    return data[1] && data[1][0] ? { title: data[1][0], url: data[3][0] } : null;
  } catch {
    return null;
  }
}

// Cherche la vraie page Wikipedia en essayant des préfixes puis des
// suffixes de plus en plus courts du titre (les titres générés sont
// souvent des phrases descriptives, pas le vrai nom de l'article).
async function findBestMatch(title) {
  const words = title.replace(/[,.;:()]/g, '').split(' ').filter(Boolean);

  for (let n = Math.min(5, words.length); n >= 2; n--) {
    const prefix = words.slice(0, n).join(' ');
    const r = await searchWikipedia(prefix);
    await sleep(300);
    if (r) return r;
  }
  for (let n = Math.min(4, words.length); n >= 2; n--) {
    const suffix = words.slice(-n).join(' ');
    const r = await searchWikipedia(suffix);
    await sleep(300);
    if (r) return r;
  }
  return null;
}

async function fetchPageThumbnail(title, attempt = 1) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      if (attempt <= 2) {
        await sleep(1000 * attempt);
        return fetchPageThumbnail(title, attempt + 1);
      }
      return null;
    }
    const data = await res.json();
    return data.thumbnail?.source || data.originalimage?.source || null;
  } catch {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error(`${OUTPUT_FILE} introuvable dans le repo.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  const dayKeys = Object.keys(data);

  let totalEntries = 0;
  let urlCorrected = 0;
  let imageFixed = 0;
  let fixedViaIcon = 0;
  let unchanged = 0;

  for (const [i, key] of dayKeys.entries()) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      totalEntries++;

      const match = await findBestMatch(entry.title_en || '');

      if (match) {
        const urlChanged = match.url !== entry.wiki_url;
        if (urlChanged) {
          console.log(`  ✓ ${key} "${entry.title_en}" → wiki_url corrigé (${match.title})`);
          entry.wiki_url = match.url;
          urlCorrected++;
        }
        const newImage = await fetchPageThumbnail(match.title);
        if (newImage && newImage !== entry.image) {
          entry.image = newImage;
          imageFixed++;
        } else if (!newImage && !entry.image) {
          entry.image = fallbackIcon(entry.category);
          fixedViaIcon++;
        }
        if (!urlChanged && (!newImage || newImage === entry.image)) unchanged++;
      } else if (!entry.image) {
        entry.image = fallbackIcon(entry.category);
        fixedViaIcon++;
      } else {
        unchanged++;
      }
    }

    if (i % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
      console.log(`  💾 Sauvegarde intermédiaire (${i + 1}/${dayKeys.length} jours)`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Terminé.`);
  console.log(`Total entrées : ${totalEntries}`);
  console.log(`wiki_url corrigés : ${urlCorrected}`);
  console.log(`Images corrigées/trouvées : ${imageFixed}`);
  console.log(`Icônes de secours : ${fixedViaIcon}`);
  console.log(`Inchangées (déjà correctes) : ${unchanged}`);
}

main();
