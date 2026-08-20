// Genere les donnees du site encyclopedie statique :
//   - docs/encyclopedia-index.json : index compact pour la recherche/filtres
//   - docs/encyclopedia-stats.json : statistiques pre-calculees
//
// L'index reste leger (titres + categorie seulement) : le texte complet
// est charge a la demande depuis terms/NNNNN.json quand on ouvre un article.

const fs = require('fs');
const path = require('path');

const TERMS_DIR = 'terms';
const OUT_DIR = '.';

function readEntry(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  // Supporte les deux formats : {"entries":[{...}]} et {...} brut
  if (raw.entries && Array.isArray(raw.entries)) return raw.entries[0];
  return raw;
}

function main() {
  if (!fs.existsSync(TERMS_DIR)) {
    console.error(`Dossier ${TERMS_DIR} introuvable.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(TERMS_DIR).filter((f) => f.endsWith('.json')).sort();

  const index = [];
  const catCount = {};
  const letterCount = {};
  const lenFr = [];
  const lenEn = [];
  let withRealImage = 0;
  let withFallbackIcon = 0;
  let longest = null;
  let shortest = null;
  let errors = 0;

  for (const file of files) {
    let entry;
    try {
      entry = readEntry(path.join(TERMS_DIR, file));
    } catch {
      errors++;
      continue;
    }

    const id = file.replace('.json', '');
    const titleFr = entry.title_fr || entry.title_en || '(sans titre)';
    const titleEn = entry.title_en || titleFr;
    const cat = entry.category || 'culture';

    // Index compact : "e" (titre EN) omis s'il est identique au FR
    const row = { i: id, f: titleFr, c: cat };
    if (titleEn !== titleFr) row.e = titleEn;
    index.push(row);

    catCount[cat] = (catCount[cat] || 0) + 1;

    const first = titleFr.trim()[0];
    const letter = first && /[a-zA-Z]/.test(first) ? first.toUpperCase() : '#';
    letterCount[letter] = (letterCount[letter] || 0) + 1;

    const wFr = (entry.text_fr || '').split(/\s+/).filter(Boolean).length;
    const wEn = (entry.text_en || '').split(/\s+/).filter(Boolean).length;
    if (wFr) lenFr.push(wFr);
    if (wEn) lenEn.push(wEn);

    if (entry.image && entry.image.includes('assets/icons/')) withFallbackIcon++;
    else if (entry.image) withRealImage++;

    if (wFr) {
      if (!longest || wFr > longest.words) longest = { id, title: titleFr, words: wFr };
      if (!shortest || wFr < shortest.words) shortest = { id, title: titleFr, words: wFr };
    }
  }

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  const stats = {
    generated_at: new Date().toISOString(),
    total: index.length,
    errors,
    categories: catCount,
    letters: letterCount,
    words: {
      fr: { avg: avg(lenFr), median: median(lenFr), min: Math.min(...lenFr), max: Math.max(...lenFr), total: lenFr.reduce((a, b) => a + b, 0) },
      en: { avg: avg(lenEn), median: median(lenEn), min: Math.min(...lenEn), max: Math.max(...lenEn), total: lenEn.reduce((a, b) => a + b, 0) },
    },
    images: { real: withRealImage, fallback: withFallbackIcon },
    longest,
    shortest,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'encyclopedia-index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(OUT_DIR, 'encyclopedia-stats.json'), JSON.stringify(stats, null, 2));

  const idxKb = Math.round(fs.statSync(path.join(OUT_DIR, 'encyclopedia-index.json')).size / 1024);
  console.log(`${index.length} articles indexes (${errors} erreurs)`);
  console.log(`encyclopedia-index.json : ${idxKb} Ko`);
  console.log(`Categories : ${Object.keys(catCount).length}`);
  console.log(`Mots FR : moyenne ${stats.words.fr.avg}, mediane ${stats.words.fr.median}`);
}

main();
