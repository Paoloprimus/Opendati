'use client'

import { useState } from 'react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { ChatResponse } from './ChatResponse'

interface ApiResponse {
  answer: string
  data: Array<{[key: string]: string | number}>
  sources: string[]
  queryId: string
}

export function ChatInput() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<ApiResponse | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim()) return

    setLoading(true)
    setResponse(null)
    
    try {
      const apiResponse = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      })
      
      if (!apiResponse.ok) throw new Error('API error')
      
      const data: ApiResponse = await apiResponse.json()
      setResponse(data)
      
    } catch (error) {
      console.error('Errore:', error)
      setResponse({
        answer: "Mi dispiace, c'è stato un errore. Riprova più tardi.",
        data: [],
        sources: [],
        queryId: 'error'
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="Es: Quali regioni hanno più posti letto ospedalieri?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={loading}
          />
          <Button type="submit" disabled={loading}>
            {loading ? '...' : 'Chiedi'}
          </Button>
        </div>
      </form>

      {loading && (
        <div className="text-center py-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="text-gray-500 mt-2">Sto analizzando i dati...</p>
        </div>
      )}

      {response && <ChatResponse {...response} />}
    </div>
  )
}
