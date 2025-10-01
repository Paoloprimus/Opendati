import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()

    // 1. Controlla cache prima
    const { data: cached } = await supabase
      .from('datasets_cache')
      .select('*')
      .eq('search_term', query.toLowerCase())
      .single()

    if (cached) {
      // Aggiorna hit count e last_accessed
      await supabase
        .from('datasets_cache')
        .update({
          hit_count: cached.hit_count + 1,
          last_accessed: new Date().toISOString()
        })
        .eq('id', cached.id)

      return NextResponse.json({ datasets: cached.datasets, cached: true })
    }

    // 2. Se non in cache, cerca (simulazione per ora)
    const mockDatasets = [
      {
        id: 'dataset-1',
        title: 'Posti letto ospedalieri per regione',
        description: 'Dati sulla capacità ricettiva ospedaliera',
        source: 'Ministero della Salute',
        url: 'https://www.dati.salute.gov.it/dati/'
      }
    ]

    // 3. Salva in cache
    await supabase
      .from('datasets_cache')
      .insert({
        search_term: query.toLowerCase(),
        datasets: mockDatasets
      })

    return NextResponse.json({ datasets: mockDatasets, cached: false })
    
  } catch (error) {
    return NextResponse.json(
      { error: 'Errore nella ricerca dataset' },
      { status: 500 }
    )
  }
}
