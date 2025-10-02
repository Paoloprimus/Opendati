// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CKANDataset = {
  title: string
  organization?: { title?: string, name?: string }
  holder_name?: string
  resources?: Array<{
    url?: string
    format?: string
    name?: string
    mimetype?: string
  }>
}

const UA = 'Opendati.it/1.4'

// ---------- logging helpers ----------
const log = (...a: any[]) => console.log('[CHAT]', ...a)
const logErr = (...a: any[]) => console.error('[CHAT][ERR]', ...a)

// ---------- keyword helpers ----------
function stripAccent(s: string) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function extractKeywords(question: string) {
  const q = question.toLowerCase()
  const baseSyn = ['reati', 'delitti', 'criminalità', 'crimini', 'reati denunciati']
  const topics = Array.from(new Set([...baseSyn, ...baseSyn.map(stripAccent)]))
  const city = /\bmilano\b/.test(q) ? 'Milano' : null

  const now = new Date()
  const endYear = now.getUTCFullYear()
  const startYear = endYear - 4

  return { city, topics, years: { startYear, endYear } }
}

// ---------- CKAN URL builders ----------
function buildCKANUrl(q: string, rows = 50, fq: string[] = [], sort = 'metadata_modified desc') {
  const base = 'https://www.dati.gov.it/api/3/action/package_search'
  const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join('')
  const sortParam = sort ? `&sort=${encodeURIComponent(sort)}` : ''
  return `${base}?q=${encodeURIComponent(q)}&rows=${rows}${fqParam}${sortParam}`
}

// Usa facet per scoprire quali campi/valori sono realmente disponibili
async function discoverFacets(sampleQ: string) {
  // ripetiamo facet.field più volte (compatibile CKAN)
  const base = 'https://www.dati.gov.it/api/3/action/package_search'
  const fields = ['organization', 'holder_name', 'publisher_name', 'tags', 'res_format']
  const facetParams = fields.map(f => `facet.field=${encodeURIComponent(f)}`).join('&')
  const url = `${base}?q=${encodeURIComponent(sampleQ)}&rows=0&${facetParams}&facet.limit=200`
  log('discover:facetURL', url)

  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
    if (!resp.ok) { log('discover:httpNotOk', resp.status); return null }
    const json = await resp.json()
    const facets = json?.result?.facets || {}
    log('discover:facetsKeys', Object.keys(facets))
    return facets as Record<string, { items: Array<{ name: string, count: number }> }>
  } catch (e) {
    logErr('discover:exception', e)
    return null
  }
}

// Costruisce varianti dinamiche in base ai facet reali
function buildVariants(topics: string[], city: string | null, facets: any) {
  const multi = topics.filter(t => t.includes(' '))
  const single = topics.filter(t => !t.includes(' '))
  const strictQ = [...single.map(s => `"${s}"`), ...multi.map(m => `"${m}"`)].join(' OR ')
  const looseQ  = [...single, ...multi.map(m => `"${m}"`)].join(' OR ')
  const cityStrict = city ? ` "${city}"` : ''
  const cityLoose  = city ? ` ${city}`   : ''

  const variants: Array<{ label: string, url: string }> = []

  // Base (senza fq)
  variants.push({ label: 'strict+city', url: buildCKANUrl(`${strictQ}${cityStrict}`, 50) })
  variants.push({ label: 'loose+city',  url: buildCKANUrl(`${looseQ}${cityLoose}`, 50) })
  variants.push({ label: 'strict',      url: buildCKANUrl(strictQ, 50) })
  variants.push({ label: 'loose',       url: buildCKANUrl(looseQ, 50) })

  // Se il portale indicizza queste facet, aggiungiamo fq mirati
  const facetHas = (k: string) => facets && facets[k] && Array.isArray(facets[k].items)

  // Trova valori utili dalle facet (slug o label)
  const pickFacetValue = (key: string, includes: string[]) => {
    if (!facetHas(key)) return null
    const items = facets[key].items as Array<{ name: string, count: number }>
    const hit = items.find(it => includes.some(s => it.name.toLowerCase().includes(s)))
    return hit?.name || null
  }

  // organization (slug) per ISTAT / Interno / Milano
  const orgIstat   = pickFacetValue('organization', ['istat'])
  const orgInterno = pickFacetValue('organization', ['interno'])
  const orgMilano  = pickFacetValue('organization', ['milano'])

  // holder_name (label) per robustezza
  const holdIstat   = pickFacetValue('holder_name', ['istat'])
  const holdInterno = pickFacetValue('holder_name', ['interno'])
  const holdMilano  = pickFacetValue('holder_name', ['milano', 'comune di milano'])

  // Publisher (alcuni portali usano questo)
  const pubMilano = pickFacetValue('publisher_name', ['milano'])

  // Res format preferiti
  const hasCSV  = pickFacetValue('res_format', ['csv'])
  const hasJSON = pickFacetValue('res_format', ['json'])

  // Costruisci varianti fq in ordine di confidenza
  const addFQ = (label: string, q: string, fq: string[]) =>
    variants.push({ label, url: buildCKANUrl(q, 50, fq) })

  if (orgMilano)   addFQ('loose+org:milano', `${looseQ}${cityLoose}`, [`organization:${orgMilano}`])
  if (holdMilano)  addFQ('loose+holder:milano', `${looseQ}${cityLoose}`, [`holder_name:"${holdMilano}"`])
  if (pubMilano)   addFQ('loose+publisher:milano', `${looseQ}${cityLoose}`, [`publisher_name:"${pubMilano}"`])

  if (orgIstat)    addFQ('loose+org:istat', `${looseQ}${cityLoose}`, [`organization:${orgIstat}`])
  else if (holdIstat) addFQ('loose+holder:istat', `${looseQ}${cityLoose}`, [`holder_name:"${holdIstat}"`])

  if (orgInterno)  addFQ('loose+org:interno', `${looseQ}${cityLoose}`, [`organization:${orgInterno}`])
  else if (holdInterno) addFQ('loose+holder:interno', `${looseQ}${cityLoose}`, [`holder_name:"${holdInterno}"`])

  // Se il portale ci dice che JSON/CSV sono presenti, proviamo un bias sul formato
  if (hasJSON) addFQ('loose+format:json', `${looseQ}${cityLoose}`, [`res_format:JSON`])
  if (hasCSV)  addFQ('loose+format:csv',  `${looseQ}${cityLoose}`, [`res_format:CSV`])

  return variants
}

// ---------- resource helpers ----------
function pickBestResources(ds: CKANDataset) {
  const res = ds.resources || []
  const score = (r: any) => {
    const fmt = (r.format || r.mimetype || '').toString().toLowerCase()
    const url = (r.url || '').toLowerCase()
    if (fmt.includes('json') || url.endsWith('.json')) return 3
    if (fmt.includes('csv') || url.endsWith('.csv'))  return 2
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

// autodetect delimitatore CSV
function splitCSVLine(line: string, headerLine: string) {
  const counts = {
    ',': (headerLine.match(/,/g) || []).length,
    ';': (headerLine.match(/;/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length
  }
  const delim = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0] as ','|';'|'\t'
  return line.split(delim)
}

async function fetchSampleData(url: string, expect: 'json'|'csv', maxBytes = 1_000_000) {
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
      const arr = (json.data || json.records || json.result || [])
      return { rows: Array.isArray(arr) ? arr.slice(0, 20) : [], note: 'json_obj_sample' }
    } catch {
      return { rows: [], note: 'json_parse_error' }
    }
  }

  // CSV
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 101)
  if (lines.length < 2) return { rows: [], note: 'csv_too_short' }
  const headers = splitCSVLine(lines[0], lines[0]).map(h => h.trim())
  const rows = lines.slice(1).map(line => {
    const values = splitCSVLine(line, lines[0])
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => (obj[h || `col_${i+1}`] = (values[i] || '').trim()))
    return obj
  })
  return { rows: rows.slice(0, 20), note: 'csv_sample' }
}

// ---------- handler ----------
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

    // 2) Keywords
    const { topics, city, years } = extractKeywords(question)
    log('extractKeywords', { city, topicsCount: topics.length, years })

    // 3) Discovery facet → varianti dinamiche
    const discoveryQ = city ? `${topics.join(' ')} ${city}` : topics.join(' ')
    const facets = await discoverFacets(discoveryQ)
    const variants = buildVariants(topics, city, facets)
    log('search:variantsCount', variants.length)

    let realDatasets: CKANDataset[] = []
    let realData: any[] = []

    // 4) Ricerche in sequenza
    try {
      let results: CKANDataset[] = []

      for (const v of variants) {
        log('search:try', v.label, v.url)
        const dsResp = await fetch(v.url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
        if (!dsResp.ok) { log('search:httpNotOk', dsResp.status); continue }
        const json = await dsResp.json()
        const count = json?.result?.count ?? 0
        results = json?.result?.results || []
        log('search:count', { label: v.label, count, results: results.length })
        if (count > 0 && results.length > 0) break
      }

      if (results.length > 0) {
        realDatasets = results.slice(0, 6)
        log('datasets:selected', { n: realDatasets.length })

        // 5) Cerca una risorsa leggibile (JSON/CSV) e campiona
        outer:
        for (const ds of realDatasets) {
          const candidates = pickBestResources(ds)
          log('resources:candidates', { title: ds.title, n: candidates.length })
          for (const r of candidates) {
            const url = r.url as string
            const low = (r.format || r.mimetype || url).toString().toLowerCase()
            const expect: 'json'|'csv'|null =
              low.includes('json') || url.endsWith('.json') ? 'json' :
              (low.includes('csv') || url.endsWith('.csv')) ? 'csv' : null
            if (!expect) continue

            log('resource:fetchSample', { fmt: expect, url })
            const sample = await fetchSampleData(url, expect)
            log('resource:sample', { rows: sample.rows.length, note: sample.note })
            if (sample.rows && sample.rows.length) {
              const filtered = sample.rows.filter((row: any) => {
                const s = JSON.stringify(row).toLowerCase()
                const cityOk = city ? s.includes(city.toLowerCase()) : true
                const yearMatch = s.match(/\b(20\d{2}|19\d{2})\b/)
                const yOk = yearMatch ? (parseInt(yearMatch[0], 10) >= years.startYear) : true
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

    // 6) Nessun dato reale → messaggio secco
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

    // 7) Dati reali → analisi con OpenAI
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

    let parsedResponse: any
    try { parsedResponse = JSON.parse(content) }
    catch {
      parsedResponse = { answer: content, data: [], sources: ['opendata.gov.it'] }
    }

    if (realDatasets.length > 0) {
      parsedResponse.realDatasets = realDatasets.map(ds => ({
        title: ds.title,
        source: ds.organization?.title || ds.holder_name || ds.organization?.name,
        resources: ds.resources?.length || 0
      }))
    }

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
        await supabase.from('queries')
          .update({ status: 'failed', response: { error: 'Errore di elaborazione' } })
          .eq('id', query.id)
      } catch (dbError) { logErr('handler:storeFail', dbError) }
    }
    return NextResponse.json(
      { error: 'Errore nell\'elaborazione della richiesta',
        answer: 'Per ora non riesco a scovare dati utili, scusa.', data: [], sources: [] },
      { status: 500 }
    )
  }
}
