import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()

    // Cerca su opendata.gov.it
    const searchResponse = await fetch(
      `https://www.dati.gov.it/opendata/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=10`,
      {
        headers: {
          'User-Agent': 'Opendati.it/1.0'
        }
      }
    )

    if (!searchResponse.ok) {
      throw new Error('OpenData API error')
    }

    const searchData = await searchResponse.json()

    if (!searchData.success) {
      return NextResponse.json({ datasets: [] })
    }

    // Processa risultati
    const datasets = searchData.result.results.map((dataset: any) => ({
      id: dataset.id,
      title: dataset.title,
      description: dataset.notes || 'Nessuna descrizione',
      source: dataset.organization?.title || dataset.holder_name || 'Fonte sconosciuta',
      url: `https://www.dati.gov.it/opendata/api/3/action/package_show?id=${dataset.id}`,
      formats: dataset.resources?.map((r: any) => r.format) || [],
      resources: dataset.resources?.length || 0
    }))

    // Salva in cache
    await supabase
      .from('datasets_cache')
      .insert({
        search_term: query.toLowerCase(),
        datasets: datasets
      })

    return NextResponse.json({ datasets })

  } catch (error) {
    console.error('OpenData search error:', error)
    return NextResponse.json(
      { error: 'Errore nella ricerca dati reali' },
      { status: 500 }
    )
  }
}
