// Éphéméride Geek — génération complète en un seul run GitHub Actions
// Utilise fetch natif (Node 20+), aucune dépendance npm nécessaire.

const fs = require('fs');

const USER_AGENT = 'EphemerideGeek/1.0 (GitHub Actions; contact: nico)';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OUTPUT_FILE = 'ephemeride.json';

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
  const systemPrompt = `Tu es le redacteur de "La Bible Geek", un almanach des grandes dates de la tech et de la culture geek (informatique, jeux video, internet, espace, sciences, hardware, langages de programmation, culture hacker...).

On te donne une liste d'evenements "on this day" tires de Wikipedia (EN et FR) pour une date donnee. Ta mission :
1. Repere UNIQUEMENT les evenements lies a la tech/geek au sens large.
2. Ignore tout le reste (politique, guerres, sport, faits divers non-tech).
3. Selectionne entre 1 et 4 evenements maximum, les plus emblematiques.
4. Pour chaque evenement selectionne, redige un texte COURT (1-2 phrases, ton vivant, une pointe d'humour si pertinent) en anglais ET en francais.
5. Reponds UNIQUEMENT en JSON valide, ce format exact :

{"entries":[{"year":2007,"category":"hardware","title_en":"...","title_fr":"...","text_en":"...","text_fr":"...","wiki_ref":"titre_page_wikipedia"}]}

Si rien de geek/tech, reponds {"entries":[]}.
"category" doit etre une des valeurs suivantes: hardware, software, internet, gaming, space, science, company, culture.`;

  const userPrompt = `Date : ${mm}/${dd}\n\nEvenements EN :\n${JSON.stringify(
    eventsEn
  )}\n\nEvenements FR :\n${JSON.stringify(eventsFr)}`;

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
