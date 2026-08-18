// Découpe ephemeride.json (573 Ko, un seul fichier) en 366 petits fichiers
// individuels (ephemeride/MM-DD.json) — nécessaire car TRMNL plafonne
// chaque réponse de Polling URL à 100 Ko, largement dépassé par le fichier
// unique.

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync('ephemeride.json', 'utf8'));
const outDir = 'ephemeride';
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
let maxSize = 0;
for (const [day, entries] of Object.entries(data)) {
  const json = JSON.stringify(entries);
  fs.writeFileSync(path.join(outDir, `${day}.json`), json);
  maxSize = Math.max(maxSize, Buffer.byteLength(json));
  count++;
}

console.log(`✅ ${count} fichiers jour écrits dans ${outDir}/`);
console.log(`Taille max d'un fichier jour : ${maxSize} octets (limite TRMNL : 100 000)`);
