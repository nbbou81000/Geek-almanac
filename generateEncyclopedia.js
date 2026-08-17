// Encyclopédie Geek — Étape 2 : génération des articles
// Mistral en primaire (quota généreux, 1 req/s), Gemini en secours.
//
// SÉCURITÉ RENFORCÉE :
// - Timeout de 12s sur CHAQUE appel réseau (une requête qui traîne ne
//   peut plus bloquer tout le run)
// - Arrêt interne à 5h (buffer d'1h avant la limite dure de 6h GitHub)
// - COMMITS AUTOMATIQUES PÉRIODIQUES pendant le run (tous les 15
//   articles ET toutes les ~4 minutes) : même en cas de coupure brutale
//   ou de timeout dur, tout ce qui a été généré jusque-là est déjà
//   sauvegardé sur le repo, pas seulement à la fin
//
// REPRENABLE : relance simplement le workflow pour continuer au-delà
// du nombre de termes fait en un run.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const USER_AGENT = 'EncyclopedieGeek/1.0 (https://github.com/nbbou81000/Geek-almanac)';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest';
const MISTRAL_MODEL = 'mistral-small-latest';
const TERMS_FILE = 'terms.json';
const OUTPUT_DIR = 'terms';
const MANIFEST_FILE = 'manifest.json';
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000; // 5h — buffer de sécurité étendu (1h) avant la limite dure de 6h
const FETCH_TIMEOUT_MS = 12000; // aucun appel réseau ne peut bloquer plus de 12s
const MIN_EXTRACT_LENGTH = 200;
const FALLBACK_ICON_BASE = 'https://nbbou81000.github.io/Geek-almanac/assets/icons';
const COMMIT_EVERY_N = 15; // commit auto tous les 15 articles générés
const COMMIT_EVERY_MS = 4 * 60 * 1000; // ou toutes les 4 minutes, selon ce qui arrive en premier

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fallbackIcon(category) {
  const valid = ['hardware', 'software', 'internet', 'gaming', 'space', 'science', 'company', 'culture'];
  // Nouvelles catégories sans icône dédiée -> mappées vers la plus proche existante
  const aliases = { smartphone: 'hardware', cybersecurity: 'software' };
  const resolved = aliases[category] || category;
  const cat = valid.includes(resolved) ? resolved : 'culture';
  return `${FALLBACK_ICON_BASE}/${cat}.svg`;
}

// Wrapper fetch avec timeout — sécurité anti-blocage
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSummary(title, attempt = 1) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      if (res.status !== 404 && attempt <= 3) {
        await sleep(attempt * 1500);
        return fetchSummary(title, attempt + 1);
      }
      return null;
    }
    const data = await res.json();
    if (data.type === 'disambiguation') return null;
    return {
      title: data.title,
      extract: data.extract || '',
      image: data.thumbnail?.source || data.originalimage?.source || null,
      wiki_url: data.content_urls?.desktop?.page || null,
    };
  } catch (err) {
    if (attempt <= 3) {
      await sleep(attempt * 1500);
      return fetchSummary(title, attempt + 1);
    }
    console.warn(`  ⚠ fetchSummary timeout/erreur pour "${title}": ${err.message}`);
    return null;
  }
}

async function fetchSummaryFr(enTitle) {
  try {
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enTitle)}&prop=langlinks&lllang=fr&format=json`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    const frTitle = page?.langlinks?.[0]?.['*'];
    if (!frTitle) return null;

    const frUrl = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(frTitle)}`;
    const frRes = await fetchWithTimeout(frUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!frRes.ok) return null;
    const frData = await frRes.json();
    return frData.extract || null;
  } catch {
    return null;
  }
}

function buildCurationPrompts(title, extractEn, extractFr) {
  const systemPrompt = `Tu es le redacteur de "La Bible Geek", une encyclopedie de la culture tech/geek (informatique, jeux video, internet, IA, hardware, langages de programmation, espace, cybersecurite, culture hacker...).

On te donne un extrait Wikipedia (anglais, et parfois francais) a propos d'un terme/concept/invention. Ta mission :
1. Redige un article COMPLET et bien ecrit, en anglais ET en francais, sur ce terme — 2 a 3 paragraphes (environ 150-250 mots par langue), informatif, vivant, avec du contexte (pourquoi c'est important, une anecdote si pertinente).
2. Si l'extrait fourni est trop pauvre ou hors-sujet (pas vraiment tech/geek), reponds avec "skip": true.
3. Choisis une categorie parmi : hardware, software, internet, gaming, space, science, company, culture, cybersecurity, smartphone. Utilise "smartphone" specifiquement pour un modele ou une gamme de telephone (ex: iPhone, Galaxy S24, Pixel 8), et "hardware" pour tout le reste du materiel informatique.
4. Reponds UNIQUEMENT en JSON valide, sans aucun texte avant/apres, ce format exact :

{"skip": false, "category": "hardware", "title_en": "...", "title_fr": "...", "text_en": "...", "text_fr": "..."}`;

  const userPrompt = `Terme : ${title}\n\nExtrait Wikipedia EN :\n${extractEn}\n\nExtrait Wikipedia FR (si disponible) :\n${extractFr || '(non disponible)'}`;

  return { systemPrompt, userPrompt };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callMistral(systemPrompt, userPrompt) {
  try {
    const res = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      if (res.status !== 429) console.warn(`  Mistral error ${res.status}`);
      return { ok: false };
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) return { ok: false };
    const parsed = parseJsonSafe(text);
    if (parsed === null) return { ok: false };
    return { ok: true, result: parsed };
  } catch (err) {
    console.warn(`  Mistral timeout/erreur: ${err.message}`);
    return { ok: false };
  }
}

async function callGemini(systemPrompt, userPrompt) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.5 },
      }),
    });
    if (!res.ok) {
      if (res.status !== 429) console.warn(`  Gemini error ${res.status}`);
      return { ok: false };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false };
    const parsed = parseJsonSafe(text);
    if (parsed === null) return { ok: false };
    return { ok: true, result: parsed };
  } catch (err) {
    console.warn(`  Gemini timeout/erreur: ${err.message}`);
    return { ok: false };
  }
}

async function curateTerm(title, extractEn, extractFr) {
  const { systemPrompt, userPrompt } = buildCurationPrompts(title, extractEn, extractFr);

  if (MISTRAL_API_KEY) {
    const mistral = await callMistral(systemPrompt, userPrompt);
    if (mistral.ok) return { result: mistral.result, provider: 'mistral' };
    console.warn('  → bascule sur Gemini pour ce terme');
  }
  if (GEMINI_API_KEY) {
    const gemini = await callGemini(systemPrompt, userPrompt);
    if (gemini.ok) return { result: gemini.result, provider: 'gemini' };
  }
  return { result: null, provider: 'failed' };
}

// Commit + push périodique — sécurité maximale : même en cas d'arrêt
// brutal du run, la progression jusqu'ici est déjà sur GitHub.
function commitProgress(label) {
  try {
    execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' });
    execSync('git add terms.json terms/ manifest.json', { stdio: 'ignore' });
    execSync(`git commit -m "Encyclopedia progress: ${label}" --quiet`, { stdio: 'ignore' });
    execSync('git push --quiet', { stdio: 'ignore' });
    console.log(`  💾 Progression commitée et pushée (${label})`);
  } catch {
    // Rien à commit (aucun changement depuis le dernier commit) ou push
    // impossible temporairement — pas bloquant, le prochain commit
    // périodique ou le commit final de fin de step rattrapera.
  }
}

function shuffle(array) {
  // Fisher-Yates — mélange en place, uniforme
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// --- Priorisation par catégorie : ralentit (sans jamais bloquer) gaming en
// particulier, et accélère space/cybersecurity/company/smartphones. ---
const CATEGORY_CAPS = {
  gaming: 0.15,   // gaming ralenti fort (était à 25%)
  software: 0.25,
  hardware: 0.20,
};

// Catégories à faire passer en tête de liste systématiquement
const BOOST_CATEGORIES = ['space', 'cybersecurity', 'company', 'smartphone'];

// Heuristique légère pour deviner la catégorie probable d'un titre AVANT
// génération (juste pour la priorisation — la vraie catégorie finale reste
// toujours décidée par le LLM lors de la curation).
function guessCategoryFromTitle(title) {
  const t = title.toLowerCase();
  // Smartphones testé en premier (plus spécifique que "hardware")
  if (/\b(iphone|galaxy\s+(s|a|note|z|m)\d+|xperia|pixel\s*\d+|redmi|oneplus|nexus\s*\d+|moto\s*[gexz]\d*|htc\s+(one|desire|wildfire)|nokia\s+\d+|blackberry|huawei\s+(p|mate)\d+|honor\s*\d+|oppo\s+(find|reno)|vivo\s+[xv]\d+|lg\s+(g|v)\d+|smartphone)\b/.test(t)) return 'smartphone';
  if (/\b(space|spacex|starship|satellite|rocket|nasa|esa\b|orbit|mars|moon|lunar|astronaut|spacecraft|cosmonaut)\b/i.test(t)) return 'space';
  if (/\b(security|malware|virus|hack(er|ing)?|encrypt|cyber|exploit|firewall|breach|ransomware)\b/.test(t)) return 'cybersecurity';
  if (/\b(inc\.?|corporation|corp\.?|company|ltd|technologies|systems|labs?|holdings)\b/.test(t)) return 'company';
  if (/\b(video game|game|kart|quest|saga|rpg|fps|nintendo|playstation|xbox|arcade|esports?)\b/.test(t)) return 'gaming';
  if (/\b(software|framework|library|\bapi\b|sdk|compiler|linux|kernel|database|\bsql\b|open.source)\b/.test(t)) return 'software';
  if (/\b(processor|chip|\bcpu\b|\bgpu\b|motherboard|hardware|drive|memory|\bram\b|circuit|semiconductor)\b/.test(t)) return 'hardware';
  return null;
}

function countExistingCategories() {
  const counts = {};
  let total = 0;
  if (!fs.existsSync(OUTPUT_DIR)) return { counts, total };
  for (const file of fs.readdirSync(OUTPUT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
      const cat = entry.category || 'culture';
      counts[cat] = (counts[cat] || 0) + 1;
      total++;
    } catch {
      // fichier illisible, on l'ignore juste pour le comptage
    }
  }
  return { counts, total };
}

// Réordonne en 3 niveaux :
//   1. BOOST_CATEGORIES (space/cybersecurity/company/smartphone) -> en tête
//   2. Le reste (non concerné par un cap) -> priorité normale
//   3. Catégories au-delà de leur quota (surtout gaming) -> différé en fin
function prioritizeByCategory(remaining) {
  const { counts, total } = countExistingCategories();

  const isOverCap = (cat) => {
    const cap = CATEGORY_CAPS[cat];
    if (!cap || total === 0) return false;
    return (counts[cat] || 0) / total > cap;
  };

  const boosted = [];
  const normal = [];
  const deferred = [];

  for (const title of remaining) {
    const guessed = guessCategoryFromTitle(title);
    if (guessed && BOOST_CATEGORIES.includes(guessed)) {
      boosted.push(title);
    } else if (guessed && isOverCap(guessed)) {
      deferred.push(title);
    } else {
      normal.push(title);
    }
  }
  console.log(
    `Priorisation : ${boosted.length} accélérés (space/cybersecurity/company/smartphone), ${normal.length} normaux, ${deferred.length} différés (gaming surtout)`
  );
  return [...boosted, ...normal, ...deferred];
}

async function main() {
  if (!GEMINI_API_KEY && !MISTRAL_API_KEY) {
    console.error('Aucune clé API disponible (ni GEMINI_API_KEY ni MISTRAL_API_KEY).');
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

  const remaining = prioritizeByCategory(shuffle(terms.filter((t) => !processedSet.has(t))));
  console.log(`${remaining.length} terme(s) restant(s) sur ${terms.length} — ordre mélangé pour couvrir tout l'alphabet`);

  const startTime = Date.now();
  let lastCommitTime = Date.now();
  let sinceLastCommit = 0;
  let nextIndex = manifest.generated_count;

  for (const [i, title] of remaining.entries()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.log('\n⏰ Limite de temps interne atteinte (5h), arrêt propre pour ce run.');
      break;
    }

    console.log(`[${i + 1}/${remaining.length}] ${title} ...`);
    let provider = 'skip';
    try {
      const summaryEn = await fetchSummary(title);
      if (!summaryEn || summaryEn.extract.length < MIN_EXTRACT_LENGTH) {
        console.log('  ⏭ trop court / disambiguation, ignoré');
        processedSet.add(title);
        continue;
      }
      const extractFr = await fetchSummaryFr(title);

      const { result: curated, provider: usedProvider } = await curateTerm(title, summaryEn.extract, extractFr);
      provider = usedProvider;

      if (!curated || curated.skip) {
        console.log(`  ⏭ écarté par la curation [${provider}]`);
        processedSet.add(title);
        continue;
      }

      const image = summaryEn.image || fallbackIcon(curated.category);

      const entry = {
        category: curated.category || 'culture',
        title_en: curated.title_en,
        title_fr: curated.title_fr,
        text_en: curated.text_en,
        text_fr: curated.text_fr,
        image,
        wiki_url: summaryEn.wiki_url,
      };

      const filename = String(nextIndex).padStart(5, '0') + '.json';
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(entry));
      console.log(`  ✓ écrit ${filename} [${provider}]${!summaryEn.image ? ' (icône de secours)' : ''}`);

      nextIndex++;
      processedSet.add(title);
      sinceLastCommit++;
    } catch (err) {
      console.error(`  ✗ erreur: ${err.message}`);
      processedSet.add(title);
    }

    // Sauvegarde locale du manifest à chaque itération (léger, pas cher)
    manifest.processed_titles = Array.from(processedSet);
    manifest.generated_count = nextIndex;
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest));

    // Commit + push périodique (sécurité maximale contre les coupures)
    const timeToCommit = Date.now() - lastCommitTime > COMMIT_EVERY_MS;
    if (sinceLastCommit >= COMMIT_EVERY_N || timeToCommit) {
      commitProgress(`${nextIndex} articles au total`);
      lastCommitTime = Date.now();
      sinceLastCommit = 0;
    }

    // Throttle adapté au provider réellement utilisé :
    // Mistral (primaire, ~1 req/s) → pause courte
    // Gemini (secours, ~15 RPM) → pause plus longue pour rester safe
    if (provider === 'mistral') await sleep(1200);
    else if (provider === 'gemini') await sleep(4500);
    else await sleep(300);
  }

  manifest.processed_titles = Array.from(processedSet);
  manifest.generated_count = nextIndex;
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  commitProgress(`run terminé — ${nextIndex} articles au total`);

  console.log(`\n✅ Run terminé. ${nextIndex} article(s) généré(s) au total sur ${terms.length} termes candidats.`);
  console.log(
    processedSet.size < terms.length
      ? `Il reste ${terms.length - processedSet.size} terme(s) à traiter — relance le workflow pour continuer.`
      : `Tous les termes candidats ont été traités.`
  );
}

main();
