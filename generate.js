// Éphéméride Geek — génération complète en un seul run GitHub Actions
// Utilise fetch natif (Node 20+), aucune dépendance npm nécessaire.

const fs = require('fs');

const USER_AGENT = 'EphemerideGeek/1.0 (GitHub Actions; contact: nico)';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant'; // quota tier gratuit bien plus généreux que le 70B
const OUTPUT_FILE = 'ephemeride.json';

// Mots-clés pour pré-filtrer les événements avant même l'appel Groq —
// réduit fortement le volume envoyé (donc les tokens consommés) sur les
// jours chargés (parfois 50-65 événements bruts côté Wikipedia).
const TECH_KEYWORDS = /computer|software|internet|hardware|robot|satellite|spacecraft|NASA|programming|algorithm|processor|semiconductor|Apple|Microsoft|Google|IBM|Intel|Amazon|video game|console|hacker|cyber|encryption|artificial intelligence|machine learning|website|browser|smartphone|telegraph|telephone|television|radio broadcast|electric|engine|invention|patent|laboratory|physicist|chemist|scientist|discover|launch|orbit|Mars|Moon|nuclear|laser|transistor|circuit|network|protocol|Wikipedia|Linux|Windows|iOS|Android/i;

function preFilter(events) {
  const matched = events.filter((ev) => TECH_KEYWORDS.test(ev.text));
  // Cap à 15 candidats max même si plus matchent, pour borner les tokens
  return matched.slice(0, 15);
}

function allDaysOfYear() {
  const days = [];
  const d = new Date(Date.UTC(2024, 0, 1)); // année bissextile
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

async function fetchOnThisDay(lang, mm, dd) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
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

async function curateWithGroq(mm, dd, eventsEn, eventsFr) {
  // Ne garder que les champs utiles + texte tronqué, pour limiter les tokens
  const slim = (ev) => ({
    year: ev.year,
    text: ev.text.length > 200 ? ev.text.slice(0, 200) + '…' : ev.text,
    wiki_title: ev.wiki_title,
  });
  const slimEn = preFilter(eventsEn).map(slim);
  const slimFr = preFilter(eventsFr).map(slim);

  if (slimEn.length === 0 && slimFr.length === 0) {
    return []; // rien de tech-plausible détecté, on économise l'appel Groq
  }

  const systemPrompt = `Tu es le redacteur de "La Bible Geek", un almanach des grandes dates de la tech et de la culture geek (informatique, jeux video, internet, espace, sciences, hardware, langages de programmation, culture hacker...).

On te donne une liste d'evenements "on this day" (deja pre-filtres, potentiellement lies a la tech) tires de Wikipedia (EN et FR) pour une date donnee. Ta mission :
1. Parmi ces evenements, ne garde que ceux VRAIMENT lies a la tech/geek au sens large (informatique, jeux video, internet, espace, sciences, hardware, langages, culture hacker). Certains candidats peuvent etre des faux positifs (mot-cle present mais hors-sujet) : ignore-les.
2. Selectionne entre 1 et 4 evenements maximum, les plus emblematiques.
3. Pour chaque evenement selectionne, redige un texte COURT (1-2 phrases, ton vivant, une pointe d'humour si pertinent) en anglais ET en francais.
4. Reponds UNIQUEMENT en JSON valide, ce format exact :

{"entries":[{"year":2007,"category":"hardware","title_en":"...","title_fr":"...","text_en":"...","text_fr":"...","wiki_ref":"titre_page_wikipedia"}]}

Si rien de vraiment geek/tech, reponds {"entries":[]}.
"category" doit etre une des valeurs suivantes: hardware, software, internet, gaming, space, science, company, culture.`;

  const userPrompt = `Date : ${mm}/${dd}\n\nEvenements EN :\n${JSON.stringify(
    slimEn
  )}\n\nEvenements FR :\n${JSON.stringify(slimFr)}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (res.status === 429) {
    console.error('  ⚠ Quota Groq atteint (429). Arrêt propre — relance le workflow demain pour continuer.');
    throw new Error('RATE_LIMIT');
  }
  if (!res.ok) {
    console.warn(`  Groq error ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    return parsed.entries || [];
  } catch {
    return [];
  }
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
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY manquant (vérifie le secret GitHub Actions).');
    process.exit(1);
  }

  // Reprend un fichier existant s'il y en a un (permet de relancer le
  // workflow sans tout refaire si jamais il avait déjà partiellement tourné)
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
    try {
      const [eventsEn, eventsFr] = await Promise.all([
        fetchOnThisDay('en', mm, dd),
        fetchOnThisDay('fr', mm, dd),
      ]);
      const raw = await curateWithGroq(mm, dd, eventsEn, eventsFr);
      result[key] = attachMetadata(raw, eventsEn, eventsFr);
      console.log(`  ✓ ${result[key].length} entrée(s)`);
    } catch (err) {
      if (err.message === 'RATE_LIMIT') {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
        console.log(`\n⏸ Arrêt à cause du quota Groq. ${Object.keys(result).length}/366 jours faits jusqu'ici.`);
        console.log('Relance le workflow demain (le quota se réinitialise à minuit UTC) pour continuer — la reprise est automatique.');
        process.exit(0);
      }
      console.error(`  ✗ Erreur sur ${key}: ${err.message}`);
      result[key] = [];
    }

    // Sauvegarde tous les 10 jours (sécurité si le run est interrompu)
    if (i % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    }
    await sleep(200); // reste correct vis-à-vis des APIs
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n✅ Terminé. ${Object.keys(result).length}/366 jours dans ${OUTPUT_FILE}`);
}

main();
