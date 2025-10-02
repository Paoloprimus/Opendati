// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { intelligentQueryPlan } from '@/lib/query/intelligentQuery' // LLM pre-analisi query

/**
 * Esegui sempre lato Node e in modo dinamico (no cache di build).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** CKAN base usata nei test di debug (funziona) */
const CKAN_BASE = 'https://www.dati.gov.it/opendata/api/3/action'

type CKANTag = { name?: string; display_name?: string }
type CKANGroup = { name?: string; title?: string }

type CKANDataset = {
  title: string
  notes?: string
  organization?: { title?: string; name?: string }
  holder_name?: string
  groups?: CKANGroup[]
  tags?: CKANTag[]
  resources?: Array<{
    url?: string
    format?: string
    name?: string
    mimetype?: string
  }>
}

const UA = 'Opendati.it/2.0'

// ---------------------------------
// Logging helpers
// ---------------------------------
const log = (...a: any[]) => console.log('[CHAT]', ...a)
const logErr = (...a: any[]) => console.error('[CHAT][ERR]', ...a)

// ---------------------------------
// Retry helper per OpenAI (429/5xx)
// ---------------------------------
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, baseDelayMs = 400) {
  let lastErr: any = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init)
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`status ${res.status}`)
      } else {
        return res
      }
    } catch (e) {
      lastErr = e
    }
    const sleep = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 150)
    await new Promise(r => setTimeout(r, sleep))
  }
  throw lastErr
}

// ---------------------------------
// Keyword helpers (fallback locale)
// ---------------------------------
function stripAccent(s: string) {
  // Compatibile con target TS < ES2018 (niente \p{Diacritic})
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Euristiche minime locali usate come fallback */
function fallbackExtractKeywords(question: string) {
  const q = question.toLowerCase()
  const baseSyn = [
    'delitti denunciati',
    'reati denunciati',
    'delitti',
    'reati',
    'criminalità',
    'criminalita',
    'crimini',
    'sicurezza',
    'ordine pubblico',
    'giustizia'
  ]
  const topics = Array.from(new Set([...baseSyn, ...baseSyn.map(stripAccent)]))
  const city = /\bmilano\b/.test(q) ? 'Milano' : null

  const now = new Date()
  const endYear = now.getUTCFullYear()
  const startYear = endYear - 4
  return { city, topics, years: { startYear, endYear } }
}

/** URL di package_search con eventuali filtri facet (fq) */
function buildCKANUrl(q: string, rows = 50, fq: string[] = [], sort = 'metadata_modified desc') {
  const base = `${CKAN_BASE}/package_search`
  const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join('')
  const sortParam = sort ? `&sort=${encodeURIComponent(sort)}` : ''
  return `${base}?q=${encodeURIComponent(q)}&rows=${rows}${fqParam}${sortParam}`
}

/**
 * Varianti “euristiche” (no OR globale): termine secco, termine+città, ISTAT/Interno, Comune di Milano.
 * Usate insieme alle varianti generate dall’LLM.
 */
function buildHeuristicVariants(topics: string[], city: string | null) {
  const variants: { label: string; url: string }[] = []
  const withCity = (term: string) => (city ? `${term} ${city}` : term)

  for (const term of topics) {
    variants.push({ label: `h:term:${term}`, url: buildCKANUrl(term, 50) })
    variants.push({ label: `h:term+city:${term}`, url: buildCKANUrl(withCity(term), 50) })
    variants.push({ label: `h:istat:${term}`, url: buildCKANUrl(withCity(term), 50, [`holder_name:"ISTAT"`]) })
    variants.push({
      label: `h:interno:${term}`,
      url: buildCKANUrl(withCity(term), 50, [`holder_name:"Ministero dell'Interno"`])
    })
  }

  if (city === 'Milano') {
    for (const term of topics) {
      variants.push({
        label: `h:holder:comune-mi:${term}`,
        url: buildCKANUrl(withCity(term), 50, [`holder_name:"COMUNE DI MILANO"`])
      })
      variants.push({
        label: `h:org:comune-mi:${term}`,
        url: buildCKANUrl(withCity(term), 50, [`organization:comune-di-milano`])
      })
    }
  }
  return variants
}

// ---------------------------------
// Broad fallback “Milano” con ranking tema
// ---------------------------------
function scoreDatasetForCrime(ds: CKANDataset): number {
  const text = `${ds.title || ''} ${ds.notes || ''}`.toLowerCase()
  const tags = (ds.tags || []).map(t => (t.display_name || t.name || '').toLowerCase())
  const groups = (ds.groups || []).map(g => (g.title || g.name || '').toLowerCase())
  const org = `${ds.organization?.title || ''} ${ds.holder_name || ''} ${ds.organization?.name || ''}`.toLowerCase()

  let score = 0
  const bump = (n: number) => (score += n)

  const strong = ['delitti denunciati', 'reati denunciati', 'reati', 'delitti', 'criminalità', 'criminalita', 'crimini']
  const medium = ['sicurezza', 'ordine pubblico', 'giustizia', 'polizia', 'carabinieri']

  if (strong.some(k => text.includes(k))) bump(6)
  if (medium.some(k => text.includes(k))) bump(3)
  if (tags.some(t => strong.includes(t))) bump(4)
  if (tags.some(t => medium.includes(t))) bump(2)
  if (groups.some(g => strong.includes(g))) bump(4)
  if (groups.some(g => medium.includes(g))) bump(2)
  if (org.includes('interno')) bump(3)
  if (org.includes('istat')) bump(2)
  if (org.includes('comune di milano') || org.includes('comune-milano')) bump(2)

  const resources = ds.resources || []
  const hasJSON = resources.some(
    r => (r.format || r.mimetype || '').toLowerCase().includes('json') || (r.url || '').toLowerCase().endsWith('.json')
  )
  const hasCSV = resources.some(
    r => (r.format || r.mimetype || '').toLowerCase().includes('csv') || (r.url || '').toLowerCase().endsWith('.csv')
  )
  if (hasJSON) bump(2)
  if (hasCSV) bump(2)

  return score
}

async function broadMilanoCandidates(rows = 100) {
  const url = buildCKANUrl('Milano', rows)
  log('broad:try', url)
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
  if (!r.ok) {
    log('broad:httpNotOk', r.status)
    return []
  }
  const j = await r.json()
  const results: CKANDataset[] = j?.result?.results || []
  const ranked = results
    .map(ds => ({ ds, score: scoreDatasetForCrime(ds) }))
    .sort((a, b) => b.score - a.score)
  log('broad:rankTop', ranked.slice(0, 5).map(x => ({ title: x.ds.title, score: x.score })))
  return ranked
    .filter(x => x.score > 0)
    .slice(0, 12)
    .map(x => x.ds)
}

// ---------------------------------
// Resource helpers
// ---------------------------------
function pickBestResources(ds: CKANDataset) {
  const res = ds.resources || []
  const score = (r: any) => {
    const fmt = (r.format || r.mimetype || '').toString().toLowerCase()
    const url = (r.url || '').toLowerCase()
    if (fmt.includes('json') || url.endsWith('.json')) return 3
    if (fmt.includes('csv') || url.endsWith('.csv')) return 2
    return 0
  }
  return res
    .map(r => ({ ...r, __score: score(r) }))
    .filter(r => r.__score > 0 && r.url)
    .sort((a, b) => b.__score - a.__score)
}

async function headInfo(url: string) {
  try {
    const resp = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, cache: 'no-store' as const })
    const type = resp.headers.get('content-type') || ''
    const len = parseInt(resp.headers.get('content-length') || '0', 10)
    return { ok: resp.ok, contentType: type, contentLength: isNaN(len) ? 0 : len }
  } catch {
    return { ok: false, contentType: '', contentLength: 0 }
  }
}

/** CSV: autodetect delimitatore (',' ';' '\t') */
function splitCSVLine(line: string, headerLine: string) {
  const counts = {
    ',': (headerLine.match(/,/g) || []).length,
    ';': (headerLine.match(/;/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as ',' | ';' | '\t'
  return line.split(delim)
}

/** Scarica un campione JSON/CSV (limite 1 MB) */
async function fetchSampleData(url: string, expect: 'json' | 'csv', maxBytes = 1_000_000) {
  const h = await headInfo(url)
  if (h.ok && h.contentLength && h.contentLength > maxBytes) {
    return { rows: [], note: 'skipped_large_file' }
  }
  const resp = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
  if (!resp.ok) return { rows: [], note: 'fetch_failed' }

  const buf = Buffer.from(await resp.arrayBuffer())
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf
  const text = slice.toString('utf-8')

  if (expect === 'json') {
    try {
      const json = JSON.parse(text)
      if (Array.isArray(json)) return { rows: json.slice(0, 20), note: 'json_array_sample' }
      const arr = json.data || json.records || json.result || []
      return { rows: Array.isArray(arr) ? arr.slice(0, 20) : [], note: 'json_obj_sample' }
    } catch {
      return { rows: [], note: 'json_parse_error' }
    }
  }

  // CSV con autodetect
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 101)
  if (lines.length < 2) return { rows: [], note: 'csv_too_short' }
  const headers = splitCSVLine(lines[0], lines[0]).map(h => h.trim())
  const rows = lines.slice(1).map(line => {
    const values = splitCSVLine(line, lines[0])
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => (obj[h] = (values[i] || '').trim()))
    return obj
  })
  return { rows: rows.slice(0, 20), note: 'csv_sample' }
}

// ---------------------------------
// Handler principale
// ---------------------------------
export async function POST(request: NextRequest) {
  let query: any = null

  try {
    log('request:start', { ts: new Date().toISOString() })
    const { question, userId = null } = await request.json()
    log('request:payload', { hasUserId: !!userId, qLen: (question || '').length })

    // 1) Log DB
    const { data: queryData, error } = await supabase
      .from('queries')
      .insert({ user_id: userId, question, status: 'processing' })
      .select()
      .single()
    if (error) throw error
    query = queryData
    log('db:inserted', { queryId: query.id })

    // 2) 🧠 Pre-analisi con LLM (intelligentQueryPlan) + fallback locale
    const fb = fallbackExtractKeywords(question)
    let city = fb.city
    let topics = fb.topics
    let years = fb.years
    let plan: any = null

    try {
      plan = await intelligentQueryPlan(question)
      city = plan?.normalized?.geo?.city || city
      const syn = plan?.normalized?.topic?.synonyms?.length
        ? plan.normalized.topic.synonyms
        : [plan?.normalized?.topic?.canonical].filter(Boolean)
      topics = Array.from(new Set([...(syn || []), ...(topics || [])].filter(Boolean)))
      if (Array.isArray(plan?.normalized?.years) && plan.normalized.years.length) {
        const ys = plan.normalized.years as number[]
        years = { startYear: Math.min(...ys), endYear: Math.max(...ys) }
      }
    } catch (e) {
      logErr('iq:exception', e)
    }

    // 3) Varianti: prima LLM (se presenti), poi euristiche. Dedup su URL.
    const iqVariants: Array<{ label: string; url: string }> =
      (plan?.ckan?.variants || []).map((v: any) => ({ label: `iq:${v.label}`, url: v.url })) ?? []

    const hVariants = buildHeuristicVariants(topics, city || null)
    const all = [...iqVariants, ...hVariants]
    const seen = new Set<string>()
    const variants = all.filter(v => (seen.has(v.url) ? false : (seen.add(v.url), true)))
    log('search:variantsCount', variants.length)

    // 4) Esegui ricerche in sequenza
    let results: CKANDataset[] = []

    for (const v of variants) {
      log('search:try', v.label, v.url)
      const dsResp = await fetch(v.url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
      if (!dsResp.ok) {
        log('search:httpNotOk', dsResp.status)
        continue
      }
      const json = await dsResp.json()
      const count = json?.result?.count ?? 0
      results = json?.result?.results || []
      log('search:count', { label: v.label, count, results: results.length })
      if (count > 0 && results.length > 0) break
    }

    // 5) Fallback ampio Milano con ranking tema crimine/sicurezza
    if (!results || results.length === 0) {
      const broad = await broadMilanoCandidates(100)
      if (broad.length > 0) {
        results = broad
        log('broad:useCandidates', results.length)
      } else {
        log('broad:noCandidates')
      }
    }

    // 6) Se abbiamo risultati, prova a campionare risorse pertinenti
    let realDatasets: CKANDataset[] = []
    let realData: any[] = []

    if (results.length > 0) {
      realDatasets = results.slice(0, 12)
      log('datasets:selected', { n: realDatasets.length })

      // ------ BLOCCO CAMPIONAMENTO (accetta "dataset-level Milano + anni") ------
      outer: for (const ds of realDatasets) {
        const candidates = pickBestResources(ds)
        log('resources:candidates', { title: ds.title, n: candidates.length })

        // Heuristics dataset-level (città/anni)
        const dsText = `${ds.title || ''} ${ds.notes || ''} ${ds.organization?.title || ''} ${ds.holder_name || ''} ${ds.organization?.name || ''}`.toLowerCase()
        const dsCityOk = city ? dsText.includes((city || '').toLowerCase()) : true

        // risorsa su host Comune di Milano => Milano
        const hasMilanoHost = (ds.resources || []).some(r => {
          try {
            const u = new URL(r.url || '')
            return u.hostname.includes('dati.comune.milano.it')
          } catch {
            return false
          }
        })

        // hint anni dal titolo/notes
        const dsYears = Array.from(dsText.matchAll(/\b(19|20)\d{2}\b/g)).map(m => parseInt(m[0], 10))
        const dsMaxYear = dsYears.length ? Math.max(...dsYears) : null
        const dsYearOk = dsMaxYear !== null
          ? (dsMaxYear >= years.startYear && dsMaxYear <= years.endYear) || dsMaxYear >= years.startYear
          : false

        for (const r of candidates) {
          const url = r.url as string
          const low = (r.format || r.mimetype || url).toString().toLowerCase()
          const expect: 'json' | 'csv' | null =
            low.includes('json') || url.endsWith('.json')
              ? 'json'
              : low.includes('csv') || url.endsWith('.csv')
              ? 'csv'
              : null
          if (!expect) continue

          log('resource:fetchSample', { fmt: expect, url })
          const sample = await fetchSampleData(url, expect)
          log('resource:sample', { rows: sample.rows.length, note: sample.note })
          if (!(sample.rows && sample.rows.length)) continue

          // helper: almeno un anno nel range nel campione
          const hasYearInRange = (rows: any[]) =>
            rows.some(rw => {
              const m = JSON.stringify(rw).match(/\b(20\d{2}|19\d{2})\b/)
              if (!m) return false
              const y = parseInt(m[0], 10)
              return y >= years.startYear && y <= years.endYear
            })

          if (city) {
            // 1) preferisci righe che contengono "milano"
            const filteredCity = sample.rows.filter((row: any) =>
              JSON.stringify(row).toLowerCase().includes((city || '').toLowerCase())
            )
            if (filteredCity.length && hasYearInRange(filteredCity)) {
              realData = filteredCity.slice(0, 20)
              log('resource:keptRows', { rows: realData.length, reason: 'row city+year matched' })
              break outer
            }

            // 2) se il dataset è chiaramente di Milano (org/host), accetta il campione
            //    purché il campione o l'hint dataset-level indichi anni nel range
            const cityByDataset = dsCityOk || hasMilanoHost
            if (cityByDataset && (hasYearInRange(sample.rows) || dsYearOk)) {
              realData = sample.rows.slice(0, 20)
              log('resource:keptRows', { rows: realData.length, reason: 'dataset-level Milano + year matched (sample or hint)' })
              break outer
            }

            log('resource:skipIrrelevant', {
              reason: 'no-city-match-and/no-year',
              city,
              url
            })
            continue
          }

          // Se NON c’è città, richiedi almeno un anno recente nel campione o nell’hint
          if (hasYearInRange(sample.rows) || dsYearOk) {
            realData = sample.rows.slice(0, 20)
            log('resource:keptRows', { rows: realData.length, reason: 'year matched (sample or hint)' })
            break outer
          }

          log('resource:skipIrrelevant', { reason: 'no-year-in-range', start: years.startYear, url })
          continue
        }
      }
      // ------ FINE BLOCCO CAMPIONAMENTO ------
    } else {
      log('search:noResults')
    }

    // 7) Nessun dato reale pertinente → risposta secca
    if (realData.length === 0) {
      const responsePayload = {
        answer: 'Per ora non riesco a scovare dati utili, scusa.',
        data: [],
        sources: [],
        realDatasets: (realDatasets || []).map(ds => ({
          title: ds.title,
          source: ds.organization?.title || ds.holder_name || ds.organization?.name,
          resources: ds.resources?.length || 0
        })),
        hasRealData: false
      }

      await supabase
        .from('queries')
        .update({
          response: responsePayload,
          sources: responsePayload.sources,
          data_points: 0,
          status: 'completed'
        })
        .eq('id', query.id)

      log('response:noRealData', { queryId: query.id })
      return NextResponse.json({ ...responsePayload, queryId: query.id })
    }

    // 8) Dati reali → analisi con OpenAI (retry) + fallback locale se LLM KO
    const systemPrompt = `Sei un assistente che analizza dati pubblici italiani REALI.
Ecco un campione (max 20 righe) estratto da risorse open data:
${JSON.stringify(realData, null, 2)}

Requisiti risposta (JSON valido):
{
  "answer": "analisi testuale basata sui dati reali (cita Milano e periodo se presenti)",
  "data": [eventuali statistiche di sintesi],
  "sources": ["nome dataset reale o ente", "opendata.gov.it"]
}
Se mancano campi fondamentali (es. anni o comune), esplicitalo nel testo.`

    let parsedResponse: any | null = null
    let llmOk = false

    try {
      const openaiResponse = await fetchWithRetry(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: question }
            ],
            temperature: 0.2,
            max_tokens: 1500
          }),
          cache: 'no-store'
        },
        3,
        400
      )

      if (openaiResponse.ok) {
        const openaiData = await openaiResponse.json()
        const content = openaiData?.choices?.[0]?.message?.content ?? ''
        try {
          parsedResponse = JSON.parse(content)
        } catch {
          parsedResponse = { answer: content, data: [], sources: ['opendata.gov.it'] }
        }
        llmOk = true
      } else {
        logErr('openai:fail', openaiResponse.status)
      }
    } catch (e) {
      logErr('openai:exception', e)
    }

    // Fallback locale se l'LLM non è disponibile
    if (!llmOk || !parsedResponse) {
      const yearsInSample = Array.from(
        new Set(
          realData.flatMap((row: any) => {
            const m = JSON.stringify(row).match(/\b(19|20)\d{2}\b/g) || []
            return m.map(Number)
          })
        )
      ).sort((a, b) => a - b)

      parsedResponse = {
        answer:
          `Ho trovato dati reali pertinenti${
            yearsInSample.length ? ` (anni nel campione: ${yearsInSample.slice(0, 6).join(', ')}${yearsInSample.length > 6 ? '…' : ''})` : ''
          }. L'analisi automatica non è disponibile al momento.`,
        data: [],
        sources: ['opendata.gov.it']
      }
    }

    // Allego i dataset usati
    if (realDatasets.length > 0) {
      parsedResponse.realDatasets = realDatasets.map(ds => ({
        title: ds.title,
        source: ds.organization?.title || ds.holder_name || ds.organization?.name,
        resources: ds.resources?.length || 0
      }))
    }

    // 9) Persistenza e risposta finale
    await supabase
      .from('queries')
      .update({
        response: parsedResponse,
        sources: parsedResponse.sources,
        data_points: parsedResponse.data?.length || 0,
        status: 'completed'
      })
      .eq('id', query.id)

    log('response:ok', { queryId: query.id, dataPoints: parsedResponse.data?.length || 0 })
    return NextResponse.json({ ...parsedResponse, queryId: query.id, hasRealData: true })
  } catch (error) {
    logErr('handler:exception', error)
    if (query) {
      try {
        await supabase
          .from('queries')
          .update({
            status: 'failed',
            response: { error: 'Errore di elaborazione' }
          })
          .eq('id', query.id)
      } catch (dbError) {
        logErr('handler:storeFail', dbError)
      }
    }
    return NextResponse.json(
      {
        error: 'Errore nell\'elaborazione della richiesta',
        answer: 'Per ora non riesco a scovare dati utili, scusa.',
        data: [],
        sources: []
      },
      { status: 500 }
    )
  }
}
