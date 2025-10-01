import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()

    // Simulazione ricerca dataset opendata
    const mockDatasets = [
      {
        id: 'dataset-1',
        title: 'Posti letto ospedalieri per regione',
        description: 'Dati sulla capacità ricettiva ospedaliera',
        source: 'Ministero della Salute',
        url: 'https://www.dati.salute.gov.it/dati/...'
      },
      {
        id: 'dataset-2', 
        title: 'Popolazione residente per regione',
        description: 'Dati demografici ISTAT',
        source: 'ISTAT',
        url: 'https://www.istat.it/dati/...'
      }
    ]

    return NextResponse.json({ datasets: mockDatasets })
  } catch (error) {
    return NextResponse.json(
      { error: 'Errore nella ricerca dataset' },
      { status: 500 }
    )
  }
}
