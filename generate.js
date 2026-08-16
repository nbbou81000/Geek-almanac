// Éphéméride Geek — génération complète en un seul run GitHub Actions
// Gemini (Flash-Lite) en primaire, Mistral en secours si Gemini échoue.
// Utilise fetch natif (Node 20+), aucune dépendance npm nécessaire.

const fs = require('fs');

const USER_AGENT = 'EphemerideGeek/1.0 (https://github.com/nbbou81000/Geek-almanac)';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const MISTRAL_MODEL = 'mistral-small-latest';
const OUTPUT_FILE = 'ephemeride.json';

const TECH_KEYWORDS = /computer|software|internet|hardware|robot|satellite|spacecraft|NASA|programming|algorithm|processor|semiconductor|Apple|Microsoft|Google|IBM|Intel|Amazon|video game|console|hacker|cyber|encryption|artificial intelligence|machine learning|website|browser|smartphone|telegraph|telephone|television|radio broadcast|electric|engine|invention|patent|laboratory|physicist|chemist|scientist|discover|launch|orbit|Mars|Moon|nuclear|laser|transistor|circuit|network|protocol|Wikipedia|Linux|Windows|iOS|Android/i;

function preFilter(events) {
  const matched = events.filter((ev) => TECH_KEYWORDS.test(ev.text));
  return matched.slice(0, 15);
}

function allDaysOfYear() {
  const days = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  for (let i = 0; i < 366; i++) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    days.push(`${mm}-${dd}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnThisDay(lang, mm, dd, attempt = 1) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    if (attempt <= 3) {
      const wait = attempt * 1500;
      console.warn(`  ⚠ ${lang} ${mm}/${dd} → HTTP ${res.status}, retry dans ${wait}ms (tentative ${attempt}/3)`);
      await sleep(wait);
      return fetchOnThisDay(lang, mm, dd, attempt + 1);
    }
    console.error(`  ✗ ${lang} ${mm}/${dd} → HTTP ${res.status} après 3 tentatives, jour ignoré`);
    return [];
  }
  const data = await res.json();
  return (data.events || []).map((ev) => {
    const page = (ev.pages || [])[0];
    return {
      year: ev.year,
      text: ev.text,
      wiki_title: page?.titles?.normalized || null,
      wiki_url: page?.content_urls?.desktop?.page || null,
      image: page?.thumbnail?.source || page?.originalimage?.source || null,
    };
  });
}

function buildPrompts(mm, dd, eventsEn, eventsFr) {
  const slim = (ev) => ({
    year: ev.year,
    text: ev.text.length > 200 ? ev.text.slice(0, 200) + '…' : ev.text,
    wiki_title: ev.wiki_title,
  });
  const slimEn = preFilter(eventsEn).map(slim);
  const slimFr = preFilter(eventsFr).map(slim);

  const systemPrompt = `Tu es le redacteur de "La Bible Geek", un almanach des grandes dates de la tech et de la culture geek (informatique, jeux video, internet, espace, sciences, hardware, langages de programmation, culture hacker...).

On te donne une liste d'evenements "on this day" (deja pre-filtres, potentiellement lies a la tech) tires de Wikipedia (EN et FR) pour une date donnee. Ta mission :
1. Parmi ces evenements, ne garde que ceux VRAIMENT lies a la tech/geek au sens large. Certains candidats peuvent etre des faux positifs (mot-cle present mais hors-sujet) : ignore-les.
2. Selectionne entre 1 et 4 evenements maximum, les plus emblematiques.
3. Pour chaque evenement selectionne, redige un texte COURT (1-2 phrases, ton vivant, une pointe d'humour si pertinent) en anglais ET en francais.
4. Reponds UNIQUEMENT en JSON valide, ce format exact, sans aucun texte avant/apres :

{"entries":[{"year":2007,"category":"hardware","title_en":"...","title_fr":"...","text_en":"...","text_fr":"...","wiki_ref":"titre_page_wikipedia"}]}

Si rien de vraiment geek/tech, reponds {"entries":[]}.
"category" doit etre une des valeurs suivantes: hardware, software, internet, gaming, space, science, company, culture.`;

  const userPrompt = `Date : ${mm}/${dd}\n\nEvenements EN :\n${JSON.stringify(
    slimEn
  )}\n\nEvenements FR :\n${JSON.stringify(slimFr)}`;

  return { systemPrompt, userPrompt, hasCandidates: slimEn.length > 0 || slimFr.length > 0 };
}

function parseJsonSafe(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.entries || [];
  } catch {
    return null;
  }
}

async function callGemini(systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });

  if (res.status === 429) {
    console.warn('  ⚠ Gemini 429 (quota atteint pour cet appel)');
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    console.warn(`  Gemini error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ok: false, rateLimited: false };
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, rateLimited: false };
  const entries = parseJsonSafe(text);
  if (entries === null) return { ok: false, rateLimited: false };
  return { ok: true, entries };
}

async function callMistral(systemPrompt, userPrompt) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (res.status === 429) {
    console.warn('  ⚠ Mistral 429 (quota atteint pour cet appel)');
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    console.warn(`  Mistral error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ok: false, rateLimited: false };
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) return { ok: false, rateLimited: false };
  const entries = parseJsonSafe(text);
  if (entries === null) return { ok: false, rateLimited: false };
  return { ok: true, entries };
}

async function curateContent(mm, dd, eventsEn, eventsFr) {
  const { systemPrompt, userPrompt, hasCandidates } = buildPrompts(mm, dd, eventsEn, eventsFr);
  if (!hasCandidates) return { entries: [], provider: 'skip' };

  if (GEMINI_API_KEY) {
    const gemini = await callGemini(systemPrompt, userPrompt);
    if (gemini.ok) return { entries: gemini.entries, provider: 'gemini' };
    console.warn('  → bascule sur Mistral pour ce jour');
  }

  if (MISTRAL_API_KEY) {
    const mistral = await callMistral(systemPrompt, userPrompt);
    if (mistral.ok) return { entries: mistral.entries, provider: 'mistral' };
  }

  console.error(`  ✗ Gemini et Mistral ont échoué pour ${mm}-${dd}, jour laissé vide`);
  return { entries: [], provider: 'failed' };
}

function attachMetadata(entries, eventsEn, eventsFr) {
  const all = [...eventsEn, ...eventsFr];
  return entries.map((entry) => {
    const match = all.find(
      (ev) =>
        ev.wiki_title === entry.wiki_ref ||
        ev.year === entry.year ||
        (ev.text &&
          entry.title_en &&
          ev.text.toLowerCase().includes(entry.title_en.toLowerCase().slice(0, 15)))
    );
    return {
      year: entry.year,
      category: entry.category || 'culture',
      title_en: entry.title_en,
      title_fr: entry.title_fr,
      text_en: entry.text_en,
      text_fr: entry.text_fr,
      image: match?.image || null,
      wiki_url: match?.wiki_url || null,
    };
  });
}

async function main() {
  if (!GEMINI_API_KEY && !MISTRAL_API_KEY) {
    console.error('Aucune clé API disponible (ni GEMINI_API_KEY ni MISTRAL_API_KEY).');
    process.exit(1);
  }

  let result = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      result = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    } catch {
      result = {};
    }
  }

  const days = allDaysOfYear();
  const remaining = days.filter((d) => !(d in result));
  console.log(`${remaining.length} jour(s) à traiter sur ${days.length}`);

  for (const [i, key] of remaining.entries()) {
    const [mm, dd] = key.split('-');
    console.log(`[${i + 1}/${remaining.length}] ${key} ...`);

    const [eventsEn, eventsFr] = await Promise.all([
      fetchOnThisDay('en', mm, dd),
      fetchOnThisDay('fr', mm, dd),
    ]);
    const { entries, provider } = await curateContent(mm, dd, eventsEn, eventsFr);
    result[key] = attachMetadata(entries, eventsEn, eventsFr);
    console.log(`  ✓ ${result[key].length} entrée(s) [${provider}]`);

    if (i % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    }

    await sleep(provider === 'gemini' || provider === 'mistral' ? 4500 : 300);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n✅ Terminé. ${Object.keys(result).length}/366 jours dans ${OUTPUT_FILE}`);
}

main();
