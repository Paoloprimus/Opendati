import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { question } = await request.json()

    // Simulazione risposta (sostituire con OpenAI + opendata)
    const mockResponse = {
      answer: "Questa è una risposta simulata. Integreremo OpenAI e API opendata qui.",
      data: [
        { regione: "Lombardia", valore: 100 },
        { regione: "Lazio", valore: 85 }
      ],
      sources: ["Ministero Salute 2023"]
    }

    return NextResponse.json(mockResponse)
  } catch (error) {
    return NextResponse.json(
      { error: 'Errore nell\'elaborazione della richiesta' },
      { status: 500 }
    )
  }
}
