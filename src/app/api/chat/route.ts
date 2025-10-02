// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

type CKANDataset = {
  title: string
  organization?: { title?: string }
  holder_name?: string
  resources?: Array<{
    url?: string
    format?: string
    name?: string
    mimetype?: string
  }>
}

const UA = 'Opendati.it/1.2'

// ------------------------------
//  Helpers: estrazione keyword
// ------------------------------
function extractKeywords(question: string) {
  const q = question.toLowerCase()
  const crimeSyn = ['reati', 'delitti', 'criminalità', 'crimini', 'reati denunciati']
  const city = /\bmilano\b/.test(q) ? 'Milano' : null

  // Ultimi 5 anni: [Y-4 .. Y]
  const now = new Date()
  const endYear = now.getUTCFullYear()
  const startYear = endYear - 4

  return {
    city,
    topics: crimeSyn,
    years: { startYear, endYear },
    ckanQ: `${crimeSyn.map(s => `"${s}"`).join(' OR ')}${city ? ` "${city}"` : ''}`.trim()
  }
}

// Costruisce URL CKAN con filtri opzionali (fq)
function buildCKANUrl(q: string, rows = 12, fq: string[] = []) {
  const base = 'https://www.dati.gov.it/opendata/api/3/action/package_search'
  const fqParam = fq.map(f => `&fq=${encodeURIComponent(f)}`).join('')
  return `${base}?q=${encodeURIComponent(q)}&rows=${rows}${fqParam}`
}

// Genera un set di URL da provare (Comune di Milano, ISTAT/Interno, fallback)
function buildSearchUrls(ckanQ: string, city: string | null) {
  const urls: string[] = []
  if (city === 'Milano') {
    urls.push(buildCKANUrl(ckanQ, 12, ['holder_name:"COMUNE DI MILANO"']))
    urls.push(buildCKANUrl(ckanQ, 12, ['organization:comune-di-milano']))
  }
  // Nazionale (reati): ISTAT o Ministero dell'Interno
  urls.push(buildCKANUrl(ckanQ, 12, ['holder_name:"ISTAT"']))
  urls.push(buildCKANUrl(ckanQ, 12, ['holder_name:"Ministero dell\'Interno"']))
  // Fallback solo testo
  urls.push(buildCKANUrl(ckanQ, 12))
  return urls
}

// Preferisci risorse JSON > CSV > XLS/XLSX; scarta il resto
function pickBestResources(ds: CKANDataset) {
  const res = ds.resources || []
  const score = (r: any) => {
    const fmtSrc = (r.format || r.mimetype || '').toString().toLowerCase()
    const url = (r.url || '').toLowerCase()
    const fmt =
      fmtSrc ||
      (url.endsWith('.json') ? 'json' :
       url.endsWith('.csv') ? 'csv' :
       url.endsWith('.xlsx') || url.endsWith('.xls') ? 'xlsx' : '')
    if (fmt.includes('json') || fmt === 'json') return 3
    if (fmt.includes('csv') || fmt === 'csv') return 2
    if (fmt.includes('xls')) return 2
    return 0
  }
  return res
    .map(r => ({ ...r, __score: score(r) }))
    .filter(r => r.__score > 0 && r.url)
    .sort((a, b) => b.__score - a.__score)
}

async function headInfo(url: string) {
  try {
    const resp = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } })
    const type = resp.headers.get('content-type') || ''
    const len = parseInt(resp.headers.get('content-length') || '0', 10)
    return { ok: resp.ok, contentType: type, contentLength: isNaN(len) ? 0 : len }
  } catch {
    return { ok: false, contentType: '', contentLength: 0 }
  }
}

// CSV: autodetect delimitatore (',' ';' '\t')
function splitCSVLine(line: string, headerLine: string) {
  const counts = {
    ',': (headerLine.match(/,/g) || []).length,
    ';': (headerLine.match(/;/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length
  }
  const delim = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0] as ','|';'|'\t'
  return line.split(delim)
}

// Scarica un campione JSON/CSV/XLSX (limite 1 MB)
async function fetchSampleData(url: string, expect: 'json'|'csv'|'xlsx', maxBytes = 1_000_000) {
  const h = await headInfo(url)
  if (h.ok && h.contentLength && h.contentLength > maxBytes) {
    return { rows: [], note: 'skipped_large_file' }
  }
  const resp = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!resp.ok) return { rows: [], note: 'fetch_failed' }

  const buf = Buffer.from(await resp.arrayBuffer())
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf

  if (expect === 'json') {
    try {
      const text = slice.toString('utf-8')
      const json = JSON.parse(text)
      if (Array.isArray(json)) return { rows: json.slice(0, 20), note: 'json_array_sample' }
      const arr = (json.data || json.records || json.result || [])
      return { rows: Array.isArray(arr) ? arr.slice(0, 20) : [], note: 'json_obj_sample' }
    } catch {
      return { rows: [], note: 'json_parse_error' }
    }
  }

  if (expect === 'csv') {
    const text = slice.toString('utf-8')
    const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 101) // fino a 100 righe
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

  // XLS/XLSX
  if (expect === 'xlsx') {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(slice, { type: 'buffer' })
      const first = wb.SheetNames[0]
      const sheet = wb.Sheets[first]
      const arr = XLSX.utils.sheet_to_json<any>(sheet, { header: 1 }) as any[][]
      if (!arr || arr.length < 2) return { rows: [], note: 'xlsx_too_short' }
      const headers = (arr[0] || []).map((h, i) => (String(h || `col_${i+1}`)).trim())
      const rows = arr.slice(1, 101).map(row => {
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => (obj[h] = (row[i] ?? '').toString().trim()))
        return obj
      })
      return { rows: rows.slice(0, 20), note: 'xlsx_sample' }
    } catch {
      return { rows: [], note: 'xlsx_parse_error' }
    }
  }

  return { rows: [], note: 'unsupported_format' }
}

// ------------------------------
//  Handler principale
// ------------------------------
export async function POST(request: NextRequest) {
  let query: any = null

  try {
    const { question, userId = null } = await request.json()

    // 1) Logga la query
    const { data: queryData, error } = await supabase
      .from('queries')
      .insert({ user_id: userId, question, status: 'processing' })
      .select()
      .single()
    if (error) throw error
    query = queryData

    // 2) Ricerca dataset reali su dati.gov.it (keyword migliorate + fq)
    const { ckanQ, city, years } = extractKeywords(question)
    let realDatasets: CKANDataset[] = []
    let realData: any[] = []

    try {
      const urls = buildSearchUrls(ckanQ, city)
      let results: CKANDataset[] = []

      // prova varianti in sequenza finché trovi risultati
      for (const searchUrl of urls) {
        console.log('[CHAT] CKAN search URL:', searchUrl)
        const dsResp = await fetch(searchUrl, { headers: { 'User-Agent': UA } })
        if (!dsResp.ok) continue
        const json = await dsResp.json()
        results = json?.result?.results || []
        if (results.length > 0) {
          break
        }
      }

      if (results.length > 0) {
        realDatasets = results.slice(0, 6) // espandi un po' il ventaglio

        // Prova più dataset/risorse finché trovi righe campionabili
        outer:
        for (const ds of realDatasets) {
          const candidates = pickBestResources(ds)
          for (const r of candidates) {
            const url = r.url as string
            const low = (r.format || r.mimetype || url).toString().toLowerCase()
            let expect: 'json'|'csv'|'xlsx'|null = null
            if (low.includes('json') || url.toLowerCase().endsWith('.json')) expect = 'json'
            else if (low.includes('csv') || url.toLowerCase().endsWith('.csv')) expect = 'csv'
            else if (low.includes('xls')) expect = 'xlsx'

            if (!expect) continue

            const sample = await fetchSampleData(url, expect)
            if (sample.rows && sample.rows.length) {
              // Filtro euristico: occorrenze città + anni
              const filtered = sample.rows.filter((row: any) => {
                const s = JSON.stringify(row).toLowerCase()
                const cityOk = city ? s.includes(city.toLowerCase()) : true
                const yearMatch = s.match(/\b(20\d{2}|19\d{2})\b/)
                const yOk = yearMatch ? (parseInt(yearMatch[0], 10) >= years.startYear) : true
                return cityOk && yOk
              })
              realData = (filtered.length ? filtered : sample.rows).slice(0, 20)
              break outer
            }
          }
        }
      }
    } catch (e) {
      console.log('Ricerca dataset fallita:', e)
    }

    // 3) Se NON ho dati reali → niente OpenAI, niente esempi
    if (realData.length === 0) {
      const responsePayload = {
        answer: 'Per ora non riesco a scovare dati utili, scusa.',
        data: [],
        sources: [],
        realDatasets: realDatasets.map(ds => ({
          title: ds.title,
          source: ds.organization?.title || ds.holder_name,
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
          status: 'completed' // completed ma senza dati
        })
        .eq('id', query.id)

      return NextResponse.json({ ...responsePayload, queryId: query.id })
    }

    // 4) Se ho dati reali → usa OpenAI per analisi (NLP sui dati reali)
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
      })
    })

    if (!openaiResponse.ok) {
      throw new Error(`OpenAI API error: ${openaiResponse.status}`)
    }

    const openaiData = await openaiResponse.json()
    const content = openaiData.choices[0].message.content

    // 5) Parsing JSON dall'output LLM
    let parsedResponse: any
    try {
      parsedResponse = JSON.parse(content)
    } catch {
      parsedResponse = {
        answer: content,
        data: [],
        sources: ['opendata.gov.it']
      }
    }

    // 6) Info dataset reali usati
    if (realDatasets.length > 0) {
      parsedResponse.realDatasets = realDatasets.map(ds => ({
        title: ds.title,
        source: ds.organization?.title || ds.holder_name,
        resources: ds.resources?.length || 0
      }))
    }

    // 7) Persisti e rispondi
    await supabase
      .from('queries')
      .update({
        response: parsedResponse,
        sources: parsedResponse.sources,
        data_points: parsedResponse.data?.length || 0,
        status: 'completed'
      })
      .eq('id', query.id)

    return NextResponse.json({
      ...parsedResponse,
      queryId: query.id,
      hasRealData: true
    })

  } catch (error) {
    console.error('Chat API error:', error)
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
        console.error('Errore salvataggio fallimento:', dbError)
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
