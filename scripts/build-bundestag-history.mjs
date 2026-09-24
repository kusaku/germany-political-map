import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "data", "bundestag-results.json");

const YEARS = [
  [1990, "1990-12-02", "https://www.bundeswahlleiterin.de/dam/jcr/3df6fb85-6ca6-4e49-bba6-4deb7e97a98d/btw90_kerg.csv"],
  [1994, "1994-10-16", "https://www.bundeswahlleiterin.de/en/dam/jcr/47f614ca-530c-40d2-bfca-84cccc3174f3/btw94_kerg.csv"],
  [1998, "1998-09-27", "https://www.bundeswahlleiterin.de/dam/jcr/cc590bfb-29b5-4f1f-a28b-1d352726b496/btw98_kerg.csv"],
  [2002, "2002-09-22", "https://www.bundeswahlleiterin.de/dam/jcr/ebcc973a-c60c-422a-a6e4-8c8626d13777/btw02_kerg.csv"],
  [2005, "2005-09-18", "https://www.bundeswahlleiterin.de/dam/jcr/01e65a67-6d5b-47ee-b8ec-0fd243493ebc/btw05_kerg.csv"],
  [2009, "2009-09-27", "https://www.bundeswahlleiterin.de/dam/jcr/0d80891b-aa0b-443b-9a45-007d28a9b817/btw09_kerg.csv"]
];

const MODERN_YEARS = [
  [2013, "2013-09-22"], [2017, "2017-09-24"], [2021, "2021-09-26"], [2025, "2025-02-23"]
];

const STATE_CODES = {
  SH: "01", HH: "02", NI: "03", HB: "04", NW: "05", HE: "06", RP: "07", BW: "08",
  BY: "09", SL: "10", BE: "11", BB: "12", MV: "13", SN: "14", ST: "15", TH: "16"
};

const PARTY_ALIASES = new Map([
  ["afd", "AfD"], ["cdu", "CDU"], ["csu", "CSU"], ["spd", "SPD"],
  ["f.d.p.", "FDP"], ["fdp", "FDP"], ["fdp/dvp", "FDP"],
  ["die grünen", "Greens"], ["grüne", "Greens"], ["grünen", "Greens"],
  ["bündnis 90/die grünen", "Greens"], ["bündnis 90/grüne", "Greens"], ["b90/gr.", "Greens"],
  ["pds", "Left"], ["die linke", "Left"], ["linke", "Left"],
  ["freiewähler", "Free Voters"], ["freie wähler", "Free Voters"],
  ["sonstige", "Others"], ["übrige", "Others"], ["andere", "Others"]
]);

const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;
const byResult = (left, right) => right.value - left.value || left.party.localeCompare(right.party);

function normalizeParty(value = "") {
  const cleaned = String(value).replace(/\*+$/u, "").trim();
  return PARTY_ALIASES.get(cleaned.toLocaleLowerCase("de")) || cleaned || "Others";
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
      } else quoted = !quoted;
    } else if (character === ";" && !quoted) {
      values.push(current);
      current = "";
    } else current += character;
  }
  values.push(current);
  return values;
}

function htmlDecode(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
}

async function fetchResponse(url) {
  const response = await fetch(url, { headers: { "user-agent": "politik-atlas-history/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}

async function fetchLegacyCsv(url) {
  return new TextDecoder("windows-1252").decode(await (await fetchResponse(url)).arrayBuffer());
}

function legacyResults(text) {
  const rows = text.split(/\r?\n/).map(parseCsvLine);
  const headerIndex = rows.findIndex((row) => /^(Wahlkreis|Nr)$/u.test(row[0]?.replace(/^\uFEFF/u, "").trim()));
  if (headerIndex < 0) throw new Error("Missing historic CSV header");
  const headings = rows[headerIndex].map((value) => value.trim());
  const groupHeadings = headings.map((heading, index) => heading || (index ? undefined : heading));
  for (let index = 1; index < groupHeadings.length; index += 1) groupHeadings[index] ||= groupHeadings[index - 1];
  const subheadings = rows[headerIndex + 1].map((value) => value.trim());
  const finality = rows[headerIndex + 2].map((value) => value.trim());
  const hasFinality = finality.includes("Endgültig");
  const electorate = groupHeadings.findIndex((heading, index) => heading === "Wahlberechtigte" && (!hasFinality || finality[index] === "Endgültig"));
  const voters = groupHeadings.findIndex((heading, index) => heading === "Wähler" && (!hasFinality || finality[index] === "Endgültig"));
  const valid = groupHeadings.findIndex((heading, index) => heading === "Gültige" && subheadings[index] === "Zweitstimmen" && (!hasFinality || finality[index] === "Endgültig"));
  const partyColumns = groupHeadings
    .map((party, index) => ({ party, index }))
    .filter(({ party, index }) => party && index > valid && subheadings[index] === "Zweitstimmen" && (!hasFinality || finality[index] === "Endgültig"));
  if ([electorate, voters, valid].some((index) => index < 0)) throw new Error(`Incomplete historic CSV header: ${headings.slice(0, 18).join(" | ")}`);

  const totals = Object.fromEntries(Object.values(STATE_CODES).map((id) => [id, { electorate: 0, voters: 0, valid: 0, parties: new Map() }]));
  for (const row of rows.slice(headerIndex + (hasFinality ? 3 : 2))) {
    const stateKey = row[2]?.trim();
    const numericState = Number(stateKey);
    const state = STATE_CODES[stateKey]
      || (numericState >= 1 && numericState <= 16 ? String(numericState).padStart(2, "0") : null)
      || (numericState >= 901 && numericState <= 916 ? String(numericState - 900).padStart(2, "0") : null);
    if (!state || !/^\d+$/u.test(row[0]?.trim() || "")) continue;
    const target = totals[state];
    if (!target) continue;
    target.electorate += Number(row[electorate].replace(/\./g, "")) || 0;
    target.voters += Number(row[voters].replace(/\./g, "")) || 0;
    target.valid += Number(row[valid].replace(/\./g, "")) || 0;
    for (const { party, index } of partyColumns) {
      const votes = Number(row[index].replace(/\./g, "")) || 0;
      if (!votes) continue;
      const canonical = normalizeParty(party);
      target.parties.set(canonical, (target.parties.get(canonical) || 0) + votes);
    }
  }

  const states = Object.fromEntries(Object.entries(totals).map(([id, total]) => [id, {
    turnout: round1(total.voters / total.electorate * 100),
    results: [...total.parties]
      .map(([party, votes]) => ({ party, value: round1(votes / total.valid * 100) }))
      .filter((item) => item.value >= 0.1)
      .sort(byResult)
  }]));
  const national = { electorate: 0, voters: 0, valid: 0, parties: new Map() };
  Object.values(totals).forEach((total) => {
    national.electorate += total.electorate; national.voters += total.voters; national.valid += total.valid;
    total.parties.forEach((votes, party) => national.parties.set(party, (national.parties.get(party) || 0) + votes));
  });
  return { states, national: {
    turnout: round1(national.voters / national.electorate * 100),
    results: [...national.parties].map(([party, votes]) => ({ party, value: round1(votes / national.valid * 100) })).filter((item) => item.value >= 0.1).sort(byResult)
  } };
}

function modernResults(html) {
  const encoded = html.match(/<figure id="zweitstimmen-prozente\d+"[\s\S]*?data-chartdata="([^"]+)"/i)?.[1];
  if (!encoded) throw new Error("Missing second-vote chart");
  const data = JSON.parse(htmlDecode(encoded)).data || [];
  const results = new Map();
  for (const item of data) {
    const value = Number(item.value);
    if (!Number.isFinite(value) || value < 0.1) continue;
    const party = normalizeParty(item.label);
    results.set(party, round1((results.get(party) || 0) + value));
  }
  return [...results].map(([party, value]) => ({ party, value })).sort(byResult);
}

function modernTurnout(html) {
  const row = html.match(/<tr[^>]*>[\s\S]*?<th[^>]*>\s*(?:Wählende|Wähler)\s*<\/th>([\s\S]*?)<\/tr>/i)?.[1];
  const value = row?.replace(/<[^>]+>/g, " ").match(/\d+,\d+/)?.[0];
  return value ? round1(Number(value.replace(",", "."))) : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function build() {
  const elections = {};
  for (const [year, date, csv] of YEARS) {
    const { states, national } = legacyResults(await fetchLegacyCsv(csv));
    elections[year] = {
      date,
      label: `${year} Bundestag election`,
      source: `https://www.bundeswahlleiterin.de/bundestagswahlen/${year}.html`, national,
      states
    };
  }
  for (const [year, date] of MODERN_YEARS) {
    const [records, nationalHtml] = await Promise.all([Promise.all(Object.values(STATE_CODES).map(async (id) => {
      const html = await (await fetchResponse(`https://www.bundeswahlleiterin.de/bundestagswahlen/${year}/ergebnisse/bund-99/land-${Number(id)}.html`)).text();
      return [id, { turnout: modernTurnout(html), results: modernResults(html) }];
    })), (await fetchResponse(`https://www.bundeswahlleiterin.de/bundestagswahlen/${year}/ergebnisse/bund-99.html`)).text()]);
    elections[year] = {
      date,
      label: `${year} Bundestag election`,
      source: `https://www.bundeswahlleiterin.de/bundestagswahlen/${year}/ergebnisse.html`,
      national: { turnout: modernTurnout(nationalHtml), results: modernResults(nationalHtml) },
      states: Object.fromEntries(records)
    };
  }

  for (const [year, election] of Object.entries(elections)) {
    for (const [id, result] of Object.entries(election.states)) {
      const total = result.results.reduce((sum, item) => sum + item.value, 0);
      if (total < 99 || total > 101 || !result.results.length) throw new Error(`${year}/${id}: invalid total ${total}`);
    }
  }

  const content = `${JSON.stringify(canonicalize({ elections, source: "Federal Returning Officer · second votes" }), null, 2)}\n`;
  let previous = "";
  try { previous = `${JSON.stringify(canonicalize(JSON.parse(await readFile(output, "utf8"))), null, 2)}\n`; } catch {}
  if (content === previous) return console.log("bundestag-results.json unchanged");
  await writeFile(output, content);
  console.log("wrote data/bundestag-results.json");
}

build().catch((error) => { console.error(error); process.exitCode = 1; });
