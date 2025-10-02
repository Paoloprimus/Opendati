import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UA = 'Opendati.it/debug'

const BASE = 'https://www.dati.gov.it/opendata/api/3/action'

async function getJSON(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' as const })
  const ok = r.ok
  let json:any = null
  try { json = await r.json() } catch {}
  return { ok, status: r.status, json }
}

export async function GET() {
  const calls = {
    status: `${BASE}/status_show`,
    milano: `${BASE}/package_search?q=milano&rows=1`,
    reati:  `${BASE}/package_search?q=reat*%20OR%20delitt*%20OR%20crimin*&rows=1`,
    empty:  `${BASE}/package_search?q=*:*&rows=0` // se il backend usa Solr, dovrebbe dare un count > 0
  }

  const results:any = {}
  for (const [k, url] of Object.entries(calls)) {
    const { ok, status, json } = await getJSON(url)
    results[k] = {
      ok, status,
      count: json?.result?.count ?? null,
      success: json?.success ?? null,
      sampleTitle: json?.result?.results?.[0]?.title ?? null
    }
  }
  return NextResponse.json({ results })
}
