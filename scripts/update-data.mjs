import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectRoot, "data");
const skipGeometry = process.argv.includes("--skip-geometry");
const dryRun = process.argv.includes("--dry-run");
const changedFiles = [];

const STATE_IDS = Array.from({ length: 16 }, (_, index) => String(index + 1).padStart(2, "0"));

const MONTHS = {
  januar: 1, februar: 2, "märz": 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12
};

const PARTY_ALIASES = new Map([
  ["afd", "AfD"], ["cdu", "CDU"], ["csu", "CSU"], ["cdu/csu", "CDU/CSU"],
  ["spd", "SPD"], ["grüne", "Greens"], ["bündnis 90/die grünen", "Greens"],
  ["die linke", "Left"], ["linke", "Left"], ["fdp", "FDP"], ["fdp/dvp", "FDP"],
  ["bsw", "BSW"], ["freie wähler", "Free Voters"], ["bvb/fw", "Free Voters"],
  ["ssw", "SSW"], ["biw", "BIW"], ["bündnis deutschland", "BIW"],
  ["sonstige", "Others"], ["übrige", "Others"]
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function serializeJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function writeJsonIfChanged(filename, value) {
  const output = serializeJson(value);
  const filePath = path.join(dataDir, filename);
  let current = null;

  try {
    current = serializeJson(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (current === output) return false;
  changedFiles.push(filename);
  if (!dryRun) await writeFile(filePath, output);
  return true;
}

function byResult(left, right) {
  return right.value - left.value || (left.party < right.party ? -1 : left.party > right.party ? 1 : 0);
}

async function mapInBatches(items, batchSize, callback) {
  const output = [];
  for (let index = 0; index < items.length; index += batchSize) {
    output.push(...await Promise.all(items.slice(index, index + batchSize).map(callback)));
  }
  return output;
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&ndash;|&minus;|&#8722;/g, "–")
    .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeParty(value) {
  const cleaned = decodeHtml(value).replace(/\*+$/, "").trim();
  return PARTY_ALIASES.get(cleaned.toLocaleLowerCase("de")) || cleaned;
}

function parseGermanNumber(value) {
  const normalized = decodeHtml(value).replace(/\./g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseDateFromCaption(captionMarkup) {
  const matches = [...captionMarkup.matchAll(/am\s+(\d{1,2})\.?\s+([A-Za-zÄÖÜäöüß]+)\s+(\d{4})/gi)];
  const match = matches.at(-1);
  if (!match) throw new Error(`Could not parse election date from: ${decodeHtml(captionMarkup)}`);
  const month = MONTHS[match[2].toLocaleLowerCase("de")];
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function decimalFromGroup(cells, group) {
  const candidates = cells
    .filter((cell) => cell.className.includes(group))
    .map((cell) => decodeHtml(cell.html))
    .filter((value) => /^\d+,\d+$/.test(value));
  return candidates.length ? parseGermanNumber(candidates[0]) : null;
}

function countFromGroup(cells, group) {
  const candidate = cells
    .filter((cell) => cell.className.includes(group))
    .map((cell) => decodeHtml(cell.html))
    .find((value) => /^\d{1,3}(?:\.\d{3})*$/.test(value));
  return candidate ? parseGermanNumber(candidate) : null;
}

function parseElectionPage(html, id) {
  const tableMatch = html.match(/<table\s+class="[^"]*table-stimmen[^"]*"[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error(`No result table found for state ${id}`);
  const table = tableMatch[0];
  const captionMarkup = table.match(/<caption>([\s\S]*?)<\/caption>/i)?.[1] || "";
  const rawResults = [];
  let turnout = null;
  const voteGroup = /class="[^"]*colgroup-2[^"]*"[^>]*>\s*%\s*<\/th>/i.test(table)
    ? "colgroup-2"
    : "colgroup-1";

  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const labelMatch = row.match(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/i);
    if (!labelMatch) continue;
    const label = decodeHtml(labelMatch[1]);
    const cells = [...row.matchAll(/<td\s+([^>]*)>([\s\S]*?)<\/td>/gi)].map((match) => ({
      className: match[1].match(/class="([^"]*)"/i)?.[1] || "",
      html: match[2]
    }));

    if (label.startsWith("Wählende") || label.startsWith("Wähler")) {
      turnout = decimalFromGroup(cells, "colgroup-1");
      continue;
    }
    if (/^(Wahlberechtigte|Ungültige|Gültige|Abgegebene|Gesamtstimmen)/.test(label)) continue;
    const votes = countFromGroup(cells, voteGroup);
    if (votes === null) continue;
    rawResults.push({ party: normalizeParty(label), votes });
  }

  const validVotes = rawResults.reduce((total, item) => total + item.votes, 0);
  const results = rawResults
    .map(({ party, votes }) => ({ party, value: Math.round((votes / validVotes) * 1000) / 10 }))
    .filter((item) => item.value >= 0.1)
    .sort(byResult);

  return {
    date: parseDateFromCaption(captionMarkup),
    turnout,
    provisional: false,
    results,
    source: `https://www.bundeswahlleiterin.de/en/service/landtagswahlen/land-${Number(id)}.html`
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "politik-atlas-data-updater/1.0" } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function saxonyAnhaltResult() {
  const source = "https://wahlergebnisse.sachsen-anhalt.de/wahlen/lt26/downloads/Ergebnisse_Land_RKR_WKR_LT_2026.csv";
  const csv = await fetchText(source);
  const lines = csv.trim().split(/\r?\n/).map(parseCsvLine);
  const header = lines[0];
  const row = lines.find((values) => values[2] === "LAN" && values[3] === "15" && values[5] === "");
  if (!row) throw new Error("No state-total row in the Sachsen-Anhalt result CSV");
  const record = Object.fromEntries(header.map((name, index) => [name, row[index]]));
  const validVotes = Number(record["F.Gültige.Zweitstimmen"]);
  const partyColumns = header.filter((name) => /^F\d+\./.test(name));
  const results = partyColumns
    .map((column) => ({
      party: normalizeParty(column.replace(/^F\d+\./, "")),
      value: Math.round((Number(record[column]) / validVotes) * 1000) / 10
    }))
    .filter((item) => item.value >= 0.1)
    .sort(byResult);

  return {
    date: "2026-09-06",
    turnout: Math.round((Number(record["B.Wähler"]) / Number(record["A.Wahlberechtigte"])) * 1000) / 10,
    provisional: true,
    results,
    source: "https://wahlergebnisse.sachsen-anhalt.de/wahlen/lt26/downloads.html"
  };
}

async function updateElectionResults() {
  const results = await mapInBatches(STATE_IDS, 4, async (id) => {
    if (id === "15") return [id, await saxonyAnhaltResult()];
    const url = `https://www.bundeswahlleiterin.de/service/landtagswahlen/land-${Number(id)}.html`;
    return [id, parseElectionPage(await fetchText(url), id)];
  });
  const states = Object.fromEntries(results);
  for (const [id, result] of Object.entries(states)) {
    const total = result.results.reduce((sum, item) => sum + item.value, 0);
    if (total < 99 || total > 101.5 || !result.results.length) {
      throw new Error(`Election result validation failed for state ${id}: ${total.toFixed(1)}%`);
    }
  }
  await writeJsonIfChanged("election-results.json", { states });
}

function squaredDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = end;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyLine(points, tolerance = 0.0025) {
  if (points.length <= 3) return points;
  const sqTolerance = tolerance * tolerance;
  const markers = new Uint8Array(points.length);
  const stack = [[0, points.length - 1]];
  markers[0] = markers[points.length - 1] = 1;
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = sqTolerance;
    let split = 0;
    for (let index = first + 1; index < last; index += 1) {
      const distance = squaredDistance(points[index], points[first], points[last]);
      if (distance > maxDistance) {
        split = index;
        maxDistance = distance;
      }
    }
    if (split) {
      markers[split] = 1;
      stack.push([first, split], [split, last]);
    }
  }
  return points.filter((_, index) => markers[index]);
}

function simplifyRing(ring) {
  const rounded = ring.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]);
  const open = rounded.slice(0, -1);
  if (open.length < 4) return rounded;
  const simplified = simplifyLine([...open, open[0]]);
  if (simplified.length < 4) return rounded;
  simplified[simplified.length - 1] = simplified[0];
  return simplified;
}

function simplifyGeometry(geometry) {
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  }
  return {
    ...geometry,
    coordinates: geometry.coordinates.map((polygon) => polygon.map(simplifyRing))
  };
}

async function updateGeometry() {
  const url = "https://sgx.geodatenzentrum.de/wfs_vg250?service=WFS&version=2.0.0&request=GetFeature&typeNames=vg250_lan&outputFormat=application%2Fjson&srsName=EPSG%3A4326";
  const payload = await fetchJson(url);
  const output = {
    type: "FeatureCollection",
    features: payload.features
      .filter((feature) => feature.properties.gf === 4)
      .map((feature) => ({
        type: "Feature",
        properties: {
          id: String(feature.properties.ars).padStart(2, "0"),
          ars: String(feature.properties.ars).padStart(2, "0"),
          gen: feature.properties.gen
        },
        geometry: simplifyGeometry(feature.geometry)
      }))
      .sort((left, right) => left.properties.id < right.properties.id ? -1 : left.properties.id > right.properties.id ? 1 : 0)
  };
  await writeJsonIfChanged("states.geojson", output);
}

async function updatePollFallback() {
  const payload = await fetchJson("https://api.dawum.de/newest_surveys.json");
  const { Database, Parliaments, Parties, Surveys } = payload;
  await writeJsonIfChanged("polls.json", { Database, Parliaments, Parties, Surveys });
}

await mkdir(dataDir, { recursive: true });
await Promise.all([updatePollFallback(), updateElectionResults(), ...(skipGeometry ? [] : [updateGeometry()])]);
console.log(`${dryRun ? "Would update" : "Updated"}: ${changedFiles.length ? changedFiles.join(", ") : "no data changes"}${skipGeometry ? " (geometry skipped)" : ""}.`);
