import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { datasetUrl, resourceIndex = 0 } = await request.json()

    // Ottieni metadati dataset
    const datasetResponse = await fetch(datasetUrl)
    const datasetData = await datasetResponse.json()

    if (!datasetData.success) {
      throw new Error('Dataset not found')
    }

    const dataset = datasetData.result
    const resource = dataset.resources[resourceIndex]

    if (!resource || !resource.url) {
      throw new Error('Resource not available')
    }

    // Scarica i dati (primi 100KB per test)
    const dataResponse = await fetch(resource.url)
    const dataText = await dataResponse.text()

    // Analizza dati (semplice per CSV)
    let parsedData = []
    if (resource.format?.toLowerCase() === 'csv') {
      const lines = dataText.split('\n').slice(0, 50) // Prime 50 righe
      const headers = lines[0]?.split(',') || []
      
      parsedData = lines.slice(1).map(line => {
        const values = line.split(',')
        const row: any = {}
        headers.forEach((header, index) => {
          row[header.trim()] = values[index]?.trim() || ''
        })
        return row
      }).filter(row => Object.keys(row).length > 0)
    }

    return NextResponse.json({
      dataset: {
        title: dataset.title,
        description: dataset.notes,
        source: dataset.organization?.title
      },
      resource: {
        name: resource.name,
        format: resource.format,
        url: resource.url
      },
      data: parsedData,
      sampleSize: parsedData.length
    })

  } catch (error) {
    console.error('Download dataset error:', error)
    return NextResponse.json(
      { error: 'Errore nel download dati' },
      { status: 500 }
    )
  }
}
