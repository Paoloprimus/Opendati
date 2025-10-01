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

    // 2. Chiama OpenAI
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
            content: `Sei un assistente che analizza dati pubblici italiani. 
                     Fornisci risposte strutturate in JSON con questo formato:
                     {
                       "answer": "risposta testuale",
                       "data": [{"regione": "Lombardia", "valore": 100}],
                       "sources": ["fonte1", "fonte2"]
                     }
                     Usa dati realistici ma chiarisci che sono esempi.`
          },
          {
            role: 'user',
            content: question
          }
        ],
        temperature: 0.3,
        max_tokens: 1000
      })
    })

    const openaiData = await openaiResponse.json()
    const content = openaiData.choices[0].message.content

    // 3. Parsing risposta JSON
    let parsedResponse
    try {
      parsedResponse = JSON.parse(content)
    } catch {
      parsedResponse = {
        answer: content,
        data: [],
        sources: ["OpenAI"]
      }
    }

    // 4. Aggiorna query con risposta OpenAI
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
      queryId: query.id
    })
    
  } catch (error) {
    console.error('Chat API error:', error)
    return NextResponse.json(
      { error: 'Errore nell\'elaborazione della richiesta' },
      { status: 500 }
    )
  }
}
