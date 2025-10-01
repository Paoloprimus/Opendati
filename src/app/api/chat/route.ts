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
        status: 'completed'
      })
      .select()
      .single()

    if (error) throw error

    // 2. Simulazione risposta (per ora)
    const mockResponse = {
      answer: "Questa è una risposta simulata. Integreremo OpenAI e API opendata qui.",
      data: [
        { regione: "Lombardia", valore: 100 },
        { regione: "Lazio", valore: 85 }
      ],
      sources: ["Ministero Salute 2023"]
    }

    // 3. Aggiorna query con risposta
    await supabase
      .from('queries')
      .update({
        response: mockResponse,
        sources: mockResponse.sources,
        data_points: mockResponse.data.length
      })
      .eq('id', query.id)

    return NextResponse.json({
      ...mockResponse,
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
