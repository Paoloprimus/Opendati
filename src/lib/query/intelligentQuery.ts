/* 
  intelligentQuery.ts
  — Estrae entità utili (geo/tema/tempo) da una domanda in linguaggio naturale
  — Normalizza il tema (sinonimi → etichette canoniche)
  — Costruisce un “piano di query” CKAN (più URL ordinati per priorità)
  — Pensato per dati.gov.it (CKAN). Non interroga la rete: prepara soltanto.
*/

export type NormalizedQuery = {
  original: string
  // Geo
  geo: {
    city?: string
    province?: string
    region?: string
    nation?: string
  }
  // Tempo
  years: number[]             // es. [2019,2020,2021,2022,2023]
  // Tema canonico + sinonimi
  topic: {
    canonical: string         // es. "reati"
    synonyms: string[]        // es. ["delitti","criminalità","crimini","reati denunciati"]
  }
  // Note di confidenza/limiti
  notes?: string[]
}

export type CKANQueryVariant = {
  label: string               // descrizione umana della variante
  url: string                 // URL completo package_search (senza fetch)
  rationale: string           // perché provarla (per debug/telemetria)
  priority: number            // 1 = più alta
}

export type CKANQueryPlan = {
  baseQuery: string           // es. "\"reati\" OR \"delitti\" \"Milano\""
  filters: string[]           // fq=... che verranno usati
  variants: CKANQueryVariant[]
}

export type IQResult = {
  normalized: NormalizedQuery
  ckan: CKANQueryPlan
}

/* --------------------------
   0) Ontologia minima temi
   -------------------------- */
const TOPIC_ONTOLOGY: Record<string, string[]> = {
  reati: ['reati', 'delitti', 'criminalità', 'crimini', 'reati denunciati'],
  // estendibile: incidenti_stradali, bilancio, popolazione, ecc.
}

/* --------------------------
   1) Utility: anni dall'espressione "ultimi N anni"
   -------------------------- */
function computeLastNYears(n: number, endYear = new Date().getFullYear()): number[] {
  const start = endYear - (n - 1)
  const arr: number[] = []
  for (let y = start; y <= endYear; y++) arr.push(y)
  return arr
}

/* --------------------------
   2) Fallback locale (regex) se LLM non disponibile
   -------------------------- */
function localHeuristics(question: string): Partial<NormalizedQuery> {
  const q = question.toLowerCase()

  // Geo molto basilare (puoi sostituire con un dizionario IT o NER in futuro)
  const geo: NormalizedQuery['geo'] = {}
  if (/\bmilano\b/.test(q)) geo.city = 'Milano'

  // Anni espliciti
  const explicitYears = Array.from(q.matchAll(/\b(19|20)\d{2}\b/g)).map(m => parseInt(m[0], 10))

  // "ultimi N anni"
  let lastN: number | null = null
  const m = q.match(/ultim[oi]?\s+(\d+)\s+anni/)
  if (m) lastN = parseInt(m[1], 10)

  const years = explicitYears.length
    ? explicitYears
    : lastN
      ? computeLastNYears(lastN)
      : []

  // Tema: prova a mappare sui sinonimi
  let canonical = 'generico'
  let synonyms: string[] = []
  for (const [canon, syns] of Object.entries(TOPIC_ONTOLOGY)) {
    if (syns.some(s => q.includes(s))) {
      canonical = canon
      synonyms = syns
      break
    }
  }

  return {
    geo,
    years,
    topic: { canonical, synonyms }
  }
}

/* --------------------------
   3) Prompt LLM di estrazione
   -------------------------- */
function buildExtractionPrompt(question: string) {
  // Richiediamo JSON rigido per evitare free text
  return `Estrai dal testo le seguenti informazioni come JSON valido (senza commenti):
{
  "geo": { "city": "", "province": "", "region": "", "nation": "" },
  "years": [/* elenco anni, se indica "ultimi N anni" restituisci gli anni espansi */],
  "topic": { "canonical": "", "synonyms": [] },
  "notes": []
}

Regole:
- "topic.canonical" deve essere una parola italiana semplice (es. "reati", "incidenti stradali", "popolazione").
- "topic.synonyms": includi varianti utili per la ricerca CKAN (es. "delitti","criminalità","crimini").
- Se il testo dice "ultimi 5 anni", calcola gli anni espliciti fino all'anno corrente.
- Se non sai provincia/region, lascia stringa vuota.
- Niente testo extra fuori dal JSON.

Testo:
"${question}"`;
}

/* --------------------------
   4) Chiamata LLM (OpenAI Chat Completions)
   -------------------------- */
async function llmExtract(question: string): Promise<Partial<NormalizedQuery> | null> {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'Sei un estrattore di entità per ricerche open-data. Rispondi solo con JSON.' },
          { role: 'user', content: buildExtractionPrompt(question) }
        ],
        temperature: 0.1,
        max_tokens: 600
      })
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const content: string = data?.choices?.[0]?.message?.content || ''
    try {
      const parsed = JSON.parse(content)
      return parsed
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/* --------------------------
   5) Normalizzazione finale (LLM + fallback + ontologia interna)
   -------------------------- */
function normalizeTopic(topic: { canonical?: string; synonyms?: string[] } | undefined): {canonical: string; synonyms: string[]} {
  const rawCanon = (topic?.canonical || '').toLowerCase().trim()
  // Mappa in base all'ontologia nota
  for (const [canon, syns] of Object.entries(TOPIC_ONTOLOGY)) {
    if (canon === rawCanon || syns.includes(rawCanon)) {
      return { canonical: canon, synonyms: syns }
    }
  }
  // Se il canone non è noto ma coincide con uno dei sinonimi conosciuti:
  for (const [canon, syns] of Object.entries(TOPIC_ONTOLOGY)) {
    if ((topic?.synonyms || []).some(s => syns.includes(s.toLowerCase()))) {
      return { canonical: canon, synonyms: syns }
    }
  }
  // fallback
  return {
    canonical: rawCanon || 'generico',
    synonyms: topic?.synonyms || (rawCanon ? [rawCanon] : [])
  }
}

/* --------------------------
   6) Costruttore piano CKAN
   -------------------------- */
function buildCKANUrl(q: string, rows = 12, fq: string[] = []): string {
  const base = 'https://www.dati.gov.it/opendata/api/3/action/package_search'
  const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join('')
  return `${base}?q=${encodeURIComponent(q)}&rows=${rows}${fqParam}`
}

function buildCKANPlan(n: NormalizedQuery): CKANQueryPlan {
  // q: "syn1" OR "syn2" ... + città se presente
  const syn = n.topic.synonyms.length ? n.topic.synonyms : [n.topic.canonical]
  const quotedSyn = syn.map(s => `"${s}"`).join(' OR ')
  const geoBit = n.geo.city ? ` "${n.geo.city}"` : ''
  const baseQuery = `${quotedSyn}${geoBit}`.trim()

  // anni come stringa per debug (CKAN indicizza testo metadati; gli anni aiutano se compaiono in title/description)
  const yearsStr = n.years.length ? n.years.join(' OR ') : ''

  // Filtri fq tipici:
  const fqMilanoHolder = n.geo.city === 'Milano' ? [`holder_name:"COMUNE DI MILANO"`] : []
  const fqOrgMilano = n.geo.city === 'Milano' ? [`organization:comune-di-milano`] : []

  // Varianti ordinate (provane più d’una)
  const variants: CKANQueryVariant[] = [
    {
      label: 'Comune di Milano (holder), sinonimi tema + città',
      url: buildCKANUrl(`${baseQuery}${yearsStr ? ' ' + yearsStr : ''}`, 12, [...fqMilanoHolder]),
      rationale: 'Spesso i dataset civici sono pubblicati a nome del Comune.',
      priority: 1
    },
    {
      label: 'Comune di Milano (organization), sinonimi tema + città',
      url: buildCKANUrl(`${baseQuery}${yearsStr ? ' ' + yearsStr : ''}`, 12, [...fqOrgMilano]),
      rationale: 'Alcuni cataloghi usano organization anziché holder_name.',
      priority: 2
    },
    {
      label: 'Nazionale (ISTAT/Interno), sinonimi tema + città nel q',
      url: buildCKANUrl(`${baseQuery}${yearsStr ? ' ' + yearsStr : ''}`, 12, [
        `holder_name:"ISTAT"`, `holder_name:"Ministero dell'Interno"`
      ]),
      rationale: 'Crimini spesso pubblicati da ISTAT o Ministero dell’Interno.',
      priority: 3
    },
    {
      label: 'Solo testo (sinonimi + città + anni), nessun fq',
      url: buildCKANUrl(`${baseQuery}${yearsStr ? ' ' + yearsStr : ''}`, 12),
      rationale: 'Fallback generico su metadati indicizzati.',
      priority: 4
    }
  ]

  return {
    baseQuery,
    filters: [...fqMilanoHolder, ...fqOrgMilano, `holder_name:"ISTAT"`, `holder_name:"Ministero dell'Interno"`],
    variants: variants.sort((a,b) => a.priority - b.priority)
  }
}

/* --------------------------
   7) Metodo principale: fa tutto
   -------------------------- */
export async function intelligentQueryPlan(question: string): Promise<IQResult> {
  // a) prova LLM
  const llm = await llmExtract(question)

  // b) fallback locale
  const local = localHeuristics(question)

  // c) merge (LLM ha priorità; poi integriamo dove mancano campi)
  const geo = {
    city: llm?.geo?.city || local.geo?.city || '',
    province: llm?.geo?.province || '',
    region: llm?.geo?.region || '',
    nation: llm?.geo?.nation || 'Italia'
  }
  const years = (llm?.years && llm.years.length ? llm.years : (local.years || []))
    // dedup + sort
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a,b) => a - b)

  const topicNorm = normalizeTopic(llm?.topic || (local as any).topic)

  const normalized: NormalizedQuery = {
    original: question,
    geo,
    years,
    topic: topicNorm,
    notes: []
  }

  // d) piano CKAN
  const ckan = buildCKANPlan(normalized)
  return { normalized, ckan }
}
