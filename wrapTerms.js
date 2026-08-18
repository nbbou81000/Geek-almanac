// Enveloppe chaque terms/NNNNN.json existant dans {"entries": [...]}
// — même correctif que pour ephemeride.json : TRMNL accède mal aux
// propriétés d'un objet JSON brut à la racine (IDX_0.title_en direct),
// mais fonctionne bien via une boucle for sur un tableau.

const fs = require('fs');
const path = require('path');

const dir = 'terms';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

let count = 0;
let alreadyWrapped = 0;
let errors = 0;

for (const f of files) {
  const filePath = path.join(dir, f);
  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (content.entries) {
      alreadyWrapped++;
      continue; // déjà au bon format, on ne touche pas
    }

    const wrapped = { entries: [content] };
    fs.writeFileSync(filePath, JSON.stringify(wrapped));
    count++;
  } catch (err) {
    console.error(`Erreur sur ${f}: ${err.message}`);
    errors++;
  }

  if (count % 1000 === 0 && count > 0) {
    console.log(`  ${count} fichiers enveloppés...`);
  }
}

console.log(`\n✅ Terminé. ${count} fichiers enveloppés, ${alreadyWrapped} déjà au bon format, ${errors} erreurs.`);
