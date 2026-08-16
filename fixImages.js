// Éphéméride Geek — patch des images manquantes uniquement
// Ne touche PAS au texte déjà généré. Ne fait AUCUN appel Gemini/Mistral.
// Lit ephemeride.json existant, complète les images absentes via Wikipedia
// (nouvelle tentative sur la page de l'article), puis en dernier recours
// une icône générique de catégorie. Rapide et repartable.

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

function titleFromWikiUrl(wikiUrl) {
  if (!wikiUrl) return null;
  try {
    const path = new URL(wikiUrl).pathname; // ex: /wiki/IBM_Personal_Computer
    const raw = path.split('/wiki/')[1];
    return raw ? decodeURIComponent(raw.replace(/_/g, ' ')) : null;
  } catch {
    return null;
  }
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
  let missingBefore = 0;
  let fixedViaWiki = 0;
  let fixedViaIcon = 0;

  for (const [i, key] of dayKeys.entries()) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      totalEntries++;
      const hadImage = !!entry.image;
      if (!hadImage) missingBefore++;

      // On re-vérifie TOUJOURS via wiki_url (source la plus fiable, liée
      // exactement au bon article) — corrige aussi les images mal
      // rattachées par le matching approximatif du script de génération,
      // pas seulement les absentes.
      const title = titleFromWikiUrl(entry.wiki_url) || entry.title_en;
      let image = null;
      if (title) {
        image = await fetchPageThumbnail(title);
      }

      if (image && image !== entry.image) {
        const wasWrong = hadImage;
        entry.image = image;
        fixedViaWiki++;
        console.log(
          `  ✓ ${key} "${entry.title_en}" → image ${wasWrong ? 'corrigée' : 'trouvée'} via Wikipedia`
        );
      } else if (!image && !hadImage) {
        entry.image = fallbackIcon(entry.category);
        fixedViaIcon++;
        console.log(`  ○ ${key} "${entry.title_en}" → icône de secours (${entry.category})`);
      }
      // sinon : l'image existante est confirmée correcte (ou re-vérification
      // impossible mais une image existait déjà) → on ne touche à rien

      await sleep(300); // reste correct vis-à-vis de Wikipedia
    }

    if (i % 20 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Terminé.`);
  console.log(`Total entrées : ${totalEntries}`);
  console.log(`Images manquantes trouvées : ${missingBefore}`);
  console.log(`  → réparées via Wikipedia : ${fixedViaWiki}`);
  console.log(`  → icône de secours : ${fixedViaIcon}`);
}

main();
