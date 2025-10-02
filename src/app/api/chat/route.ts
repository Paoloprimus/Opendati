// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

/**
 * Forziamo runtime Node e risposta dinamica (niente cache di build).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** CKAN base (quella che nel debug ha dato risultati) */
const CKAN_BASE = 'https://www.dati.gov.it/opendata/api/3/action'

type CKANDataset = {
  title: string
  organization?: { title?: string; name?: string }
  holder_name?: string
  resources?: Array<{
    url?: string
    format?: string
    name?: string
    mimetype?: string
  }>
}

const UA = 'Opendati.it/1.5'

// ------------------------------
// Logging helpers
// ------------------------------
const log = (...a: any[]) => console.log('[CHAT]', ...a)
const logErr = (...a: any[]) => console.error('[CHAT][ERR]', ...a)

// ------------------------------
// Keyword helpers
// ------------------------------
function stripAccent(s: string) {
  // Compatibile anche con target TS < ES2018
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Estrae geo/tema/periodo con euristiche snelle (senza LLM).
 * NB: “ultimi 5 anni” = [Y-4..Y]. Gli anni precisi li filtriamo dopo nei record.
 */
function extractKeywords(question: string) {
  const q = question.toLowerCase()

  // Termini “secchi” (niente wildcard) + variant senza accento
  const baseSyn = [
    'delitti denunciati',
    'reati denunciati',
    'delitti',
    'reati',
    'criminalità',
    'criminalita',
    'crimini'
  ]
  const topics = Array.from(new Set([...baseSyn, ...baseSyn.map(stripAccent)]))

  const city = /\bmilano\b/.test(q) ? 'Milano' : null

  const now = new Date()
  const endYear = now.getUTCFullYear()
  const startYear = endYear - 4

  return { city, topics, years: { startYear, endYear } }
}

/**
 * Costruisce URL di package_search con eventuali filtri facet (fq)
 */
function buildCKANUrl(q: string, rows = 50, fq: string[] = [], sort = 'metadata_modified desc') {
  const base = `${CKAN_BASE}/package_search`
  const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join('')
  const sortParam = sort ? `&sort=${encodeURIComponent(sort)}` : ''
  return `${base}?q=${encodeURIComponent(q)}&rows=${rows}${fqParam}${sortParam}`
}

/**
 * Genera varianti di ricerca:
 * - per ciascun termine (no OR globale)
 * - termine + città (se disponibile)
 * - bias su publisher noti (ISTAT/Interno)
 * - bias su Milano come organization/holder (se city=Milano)
 */
function buildSearchVariants(topics: string[], city: string | null) {
  const variants: { label: string; url: string }[] = []
  const withCity = (term: string) => (city ? `${term} ${city}` : term)

  // 1) solo termine
  for (const term of topics) {
    variants.push({ label: `term:${term}`, url: buildCKANUrl(term, 50) })
  }

  // 2) termine + città
  for (const term of topics) {
    variants.push({ label: `term+city:${term}`, url: buildCKANUrl(withCity(term), 50) })
  }

  // 3) bias publisher nazionali
  for (const term of topics) {
    variants.push({ label: `istat:${term}`, url: buildCKANUrl(withCity(term), 50, [`holder_name:"ISTAT"`]) })
    variants.push({
      label: `interno:${term}`,
      url: buildCKANUrl(withCity(term), 50, [`holder_name:"Ministero dell'Interno"`])
    })
  }

  // 4) bias Comune di Milano (se geo=Milano)
  if (city === 'Milano') {
    for (const term of topics) {
      variants.push({
        label: `holder:comune-mi:${term}`,
        url: buildCKANUrl(withCity(term), 50, [`holder_name:"COMUNE DI MILANO"`])
      })
      variants.push({
        label: `org:comune-mi:${term}`,
        url: buildCKANUrl(withCity(term), 50, [`organization:comune-di-milano`])
      })
    }
  }

  return variants
}

// ------------------------------
// Resource helpers
// ------------------------------
/** Preferisci JSON > CSV; scarta altri formati */
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
    headers.forEach((h, i) => (obj[h || `col_${i + 1}`] = (values[i] || '').trim()))
    return obj
  })
  return { rows: rows.slice(0, 20), note: 'csv_sample' }
}

// ------------------------------
// Handler principale
// ------------------------------
export async function POST(request: NextRequest) {
  let query: any = null

  try {
    log('request:start', { ts: new Date().toISOString() })
    const { question, userId = null } = await request.json()
    log('request:payload', { hasUserId: !!userId, qLen: (question || '').length })

    // 1) Log della query
    const { data: queryData, error } = await supabase
      .from('queries')
      .insert({ user_id: userId, question, status: 'processing' })
      .select()
      .single()
    if (error) throw error
    query = queryData
    log('db:inserted', { queryId: query.id })

    // 2) Ricerca su CKAN con varianti più robuste (niente wildcard)
    const { topics, city, years } = extractKeywords(question)
    log('extractKeywords', { city, topics, years })
    const variants = buildSearchVariants(topics, city)
    log('search:variantsCount', variants.length)

    let realDatasets: CKANDataset[] = []
    let realData: any[] = []

    try {
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

      if (results.length > 0) {
        realDatasets = results.slice(0, 6)
        log('datasets:selected', { n: realDatasets.length })

        // 3) Campiona una risorsa JSON/CSV
        outer: for (const ds of realDatasets) {
          const candidates = pickBestResources(ds)
          log('resources:candidates', { title: ds.title, n: candidates.length })
          for (const r of candidates) {
            const url = r.url as string
            const low = (r.format || r.mimetype || url).toString().toLowerCase()
            const expect: 'json' | 'csv' | null =
              low.includes('json') || url.endsWith('.json') ? 'json'
              : low.includes('csv') || url.endsWith('.csv') ? 'csv'
              : null
            if (!expect) continue

            log('resource:fetchSample', { fmt: expect, url })
            const sample = await fetchSampleData(url, expect)
            log('resource:sample', { rows: sample.rows.length, note: sample.note })
            if (sample.rows && sample.rows.length) {
              // Filtro euristico: città + anni >= startYear (se presenti nei record)
              const filtered = sample.rows.filter((row: any) => {
                const s = JSON.stringify(row).toLowerCase()
                const cityOk = city ? s.includes(city.toLowerCase()) : true
                const yearMatch = s.match(/\b(20\d{2}|19\d{2})\b/)
                const yOk = yearMatch ? parseInt(yearMatch[0], 10) >= years.startYear : true
                return cityOk && yOk
              })
              realData = (filtered.length ? filtered : sample.rows).slice(0, 20)
              log('resource:keptRows', { rows: realData.length })
              break outer
            }
          }
        }
      } else {
        log('search:noResults')
      }
    } catch (e) {
      logErr('search:exception', e)
    }

    // 4) Nessun dato reale → risposta secca (no esempi)
    if (realData.length === 0) {
      const responsePayload = {
        answer: 'Per ora non riesco a scovare dati utili, scusa.',
        data: [],
        sources: [],
        realDatasets: realDatasets.map(ds => ({
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

    // 5) Dati reali → analisi con OpenAI (solo NLP sui dati reali campionati)
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

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
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
      cache: 'no-store' as const
    })

    if (!openaiResponse.ok) throw new Error(`OpenAI API error: ${openaiResponse.status}`)
    const openaiData = await openaiResponse.json()
    const content = openaiData.choices[0].message.content

    // Parsing robusto
    let parsedResponse: any
    try {
      parsedResponse = JSON.parse(content)
    } catch {
      parsedResponse = { answer: content, data: [], sources: ['opendata.gov.it'] }
    }

    // Allego i dataset usati
    if (realDatasets.length > 0) {
      parsedResponse.realDatasets = realDatasets.map(ds => ({
        title: ds.title,
        source: ds.organization?.title || ds.holder_name || ds.organization?.name,
        resources: ds.resources?.length || 0
      }))
    }

    // 6) Persistenza e risposta
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
