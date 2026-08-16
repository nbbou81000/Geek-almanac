// Encyclopédie Geek — Étape 2 : génération des articles
// Pour chaque terme de terms.json : récupère un extrait Wikipedia +
// image, fait réécrire en article bilingue complet par Groq, écrit
// un fichier JSON individuel par terme (terms/NNNNN.json).
//
// REPRENABLE : si le run est interrompu ou si tu veux aller au-delà
// du nombre de termes fait en un run, relance simplement le workflow
// — les termes déjà générés sont sautés automatiquement.
//
// TIME-BOXED : s'arrête proprement avant la limite de 6h de GitHub
// Actions pour laisser le temps au commit final.

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'EncyclopedieGeek/1.0 (GitHub Actions; contact: nico)';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const TERMS_FILE = 'terms.json';
const OUTPUT_DIR = 'terms';
const MANIFEST_FILE = 'manifest.json';
const MAX_RUNTIME_MS = 5.5 * 60 * 60 * 1000; // 5h30, marge de sécurité sur les 6h max
const MIN_EXTRACT_LENGTH = 200; // en dessous, on considère que c'est un stub trop court

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    title
  )}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.type === 'disambiguation') return null;
  return {
    title: data.title,
    extract: data.extract || '',
    image: data.thumbnail?.source || data.originalimage?.source || null,
    wiki_url: data.content_urls?.desktop?.page || null,
  };
}

async function fetchSummaryFr(enTitle) {
  // Tente de trouver l'équivalent français via les langlinks
  try {
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
        enTitle
      )}&prop=langlinks&lllang=fr&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const data = await res.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    const frTitle = page?.langlinks?.[0]?.['*'];
    if (!frTitle) return null;

    const frUrl = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      frTitle
    )}`;
    const frRes = await fetch(frUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!frRes.ok) return null;
    const frData = await frRes.json();
    return frData.extract || null;
  } catch {
    return null;
  }
}

async function curateWithGroq(title, extractEn, extractFr) {
  const systemPrompt = `Tu es le rédacteur de "La Bible Geek", une encyclopédie de la culture tech/geek (informatique, jeux vidéo, internet, IA, hardware, langages de programmation, espace, cybersécurité, culture hacker...).

On te donne un extrait Wikipedia (anglais, et parfois français) à propos d'un terme/concept/invention. Ta mission :
1. Rédige un article COMPLET et bien écrit, en anglais ET en français, sur ce terme — 2 à 3 paragraphes (environ 150-250 mots par langue), informatif, vivant, avec du contexte (pourquoi c'est important, une anecdote si pertinente).
2. Si l'extrait fourni est trop pauvre ou hors-sujet (pas vraiment tech/geek), réponds avec "skip": true.
3. Choisis une catégorie parmi : hardware, software, internet, gaming, ai, security, science, company, language, culture, space.
4. Réponds UNIQUEMENT en JSON valide, ce format exact :

{"skip": false, "category": "hardware", "title_en": "...", "title_fr": "...", "text_en": "...", "text_fr": "..."}`;

  const userPrompt = `Terme : ${title}\n\nExtrait Wikipedia EN :\n${extractEn}\n\nExtrait Wikipedia FR (si disponible) :\n${
    extractFr || '(non disponible)'
  }`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    console.warn(`  Groq error ${res.status}`);
    return null;
  }
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}

async function main() {
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY manquant.');
    process.exit(1);
  }
  if (!fs.existsSync(TERMS_FILE)) {
    console.error(`${TERMS_FILE} introuvable — lance buildTermList.js d'abord.`);
    process.exit(1);
  }

  const terms = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let manifest = { processed_titles: [], generated_count: 0 };
  if (fs.existsSync(MANIFEST_FILE)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  }
  const processedSet = new Set(manifest.processed_titles);

  const remaining = terms.filter((t) => !processedSet.has(t));
  console.log(`${remaining.length} terme(s) restant(s) sur ${terms.length}`);

  const startTime = Date.now();
  let nextIndex = manifest.generated_count;

  for (const [i, title] of remaining.entries()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.log('\n⏰ Limite de temps atteinte, arrêt propre pour ce run.');
      break;
    }

    console.log(`[${i + 1}/${remaining.length}] ${title} ...`);
    try {
      const summaryEn = await fetchSummary(title);
      if (!summaryEn || summaryEn.extract.length < MIN_EXTRACT_LENGTH) {
        console.log('  ⏭ trop court / disambiguation, ignoré');
        processedSet.add(title);
        continue;
      }
      const extractFr = await fetchSummaryFr(title);

      const curated = await curateWithGroq(title, summaryEn.extract, extractFr);
      if (!curated || curated.skip) {
        console.log('  ⏭ écarté par la curation');
        processedSet.add(title);
        continue;
      }

      const entry = {
        category: curated.category || 'culture',
        title_en: curated.title_en,
        title_fr: curated.title_fr,
        text_en: curated.text_en,
        text_fr: curated.text_fr,
        image: summaryEn.image,
        wiki_url: summaryEn.wiki_url,
      };

      const filename = String(nextIndex).padStart(5, '0') + '.json';
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(entry));
      console.log(`  ✓ écrit ${filename}`);

      nextIndex++;
      processedSet.add(title);
    } catch (err) {
      console.error(`  ✗ erreur: ${err.message}`);
      processedSet.add(title); // on ne retente pas indéfiniment un terme qui plante
    }

    // Sauvegarde du manifest tous les 20 termes (sécurité)
    if (i % 20 === 0) {
      manifest.processed_titles = Array.from(processedSet);
      manifest.generated_count = nextIndex;
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest));
    }

    await sleep(150); // reste correct vis-à-vis des APIs
  }

  manifest.processed_titles = Array.from(processedSet);
  manifest.generated_count = nextIndex;
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(
    `\n✅ Run terminé. ${nextIndex} article(s) généré(s) au total sur ${terms.length} termes candidats.`
  );
  console.log(
    processedSet.size < terms.length
      ? `Il reste ${terms.length - processedSet.size} terme(s) à traiter — relance le workflow pour continuer.`
      : `Tous les termes candidats ont été traités.`
  );
}

main();
