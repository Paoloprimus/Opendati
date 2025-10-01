import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function POST(request: NextRequest) {
  try {
    const { question, userId = null } = await request.json()

    // 1. Salva query nel database
    const { data: query, error } = await supabase
      .from('queries')
      .insert({
        user_id: userId,
        question,
        status: 'processing'
      })
      .select()
      .single()

    if (error) throw error

    // 2. Cerca dataset reali su opendata.gov.it
    let realDatasets: any[] = []
    let realData: any[] = []
    
    try {
      const datasetsResponse = await fetch(
        `https://www.dati.gov.it/opendata/api/3/action/package_search?q=${encodeURIComponent(question)}&rows=5`,
        {
          headers: {
            'User-Agent': 'Opendati.it/1.0'
          }
        }
      )

      if (datasetsResponse.ok) {
        const datasetsData = await datasetsResponse.json()
        
        if (datasetsData.success && datasetsData.result.results.length > 0) {
          realDatasets = datasetsData.result.results.slice(0, 2) // Prendi 2 dataset più rilevanti
          
          // Prova a scaricare dati dal primo dataset
          const dataset = realDatasets[0]
          if (dataset.resources && dataset.resources.length > 0) {
            const resource = dataset.resources[0]
            if (resource.url) {
              // Scarica i dati (solo per risorse piccole)
              const dataResponse = await fetch(resource.url)
              if (dataResponse.ok) {
                const dataText = await dataResponse.text()
                
                // Analizza CSV semplice
                if (resource.format?.toLowerCase() === 'csv' && dataText.length < 100000) {
                  const lines = dataText.split('\n').slice(0, 20) // Prime 20 righe
                  const headers = lines[0]?.split(',') || []
                  
                  realData = lines.slice(1).map(line => {
                    const values = line.split(',')
                    const row: any = {}
                    headers.forEach((header, index) => {
                      row[header.trim()] = values[index]?.trim() || ''
                    })
                    return row
                  }).filter(row => Object.keys(row).length > 0 && Object.values(row).some(v => v !== ''))
                }
              }
            }
          }
        }
      }
    } catch (datasetError) {
      console.log('Ricerca dataset fallita:', datasetError)
      // Continua con OpenAI comunque
    }

    // 3. Prepara prompt per OpenAI con dati reali o esempi
    const hasRealData = realData.length > 0
    const systemPrompt = hasRealData ? 
      `Sei un assistente che analizza dati pubblici italiani REALI.
       Ecco dati reali da opendata.gov.it da utilizzare:
       ${JSON.stringify(realData.slice(0, 10))}
       
       Formato risposta JSON:
       {
         "answer": "analisi testuale basata sui dati reali",
         "data": [dati estratti o elaborati],
         "sources": ["nome dataset reale", "opendata.gov.it"]
       }
       
       Se i dati non sono sufficienti, integra con conoscenza generale ma indica chiaramente quali parti sono basate sui dati reali.` :
      
      `Sei un assistente che analizza dati pubblici italiani.
       Non ho trovato dataset specifici per questa domanda, quindi fornisci una risposta informativa con dati realistici.
       
       Formato risposta JSON:
       {
         "answer": "risposta testuale che chiarisce che sono dati di esempio",
         "data": [dati realistici di esempio],
         "sources": ["Dati di esempio", "Conoscenza generale"]
       }
       
       Chiarisci sempre quando usi dati di esempio.`

    // 4. Chiama OpenAI
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: question
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    })

    if (!openaiResponse.ok) {
      throw new Error(`OpenAI API error: ${openaiResponse.status}`)
    }

    const openaiData = await openaiResponse.json()
    const content = openaiData.choices[0].message.content

    // 5. Parsing risposta JSON
    let parsedResponse
    try {
      parsedResponse = JSON.parse(content)
    } catch {
      parsedResponse = {
        answer: content,
        data: [],
        sources: hasRealData ? ["opendata.gov.it"] : ["OpenAI"]
      }
    }

    // 6. Aggiungi info dataset reali se disponibili
    if (realDatasets.length > 0) {
      parsedResponse.realDatasets = realDatasets.map(ds => ({
        title: ds.title,
        source: ds.organization?.title || ds.holder_name,
        resources: ds.resources?.length || 0
      }))
    }

    // 7. Aggiorna query con risposta
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
      hasRealData: hasRealData
    })
    
  } catch (error) {
    console.error('Chat API error:', error)
    
    // Salva errore nel database
    try {
      await supabase
        .from('queries')
        .update({
          status: 'failed',
          response: { error: 'Errore di elaborazione' }
        })
        .eq('id', query?.id)
    } catch (dbError) {
      console.error('Errore salvataggio fallimento:', dbError)
    }

    return NextResponse.json(
      { 
        error: 'Errore nell\'elaborazione della richiesta',
        answer: "Mi dispiace, c'è stato un errore tecnico. Riprova più tardi.",
        data: [],
        sources: []
      },
      { status: 500 }
    )
  }
}
