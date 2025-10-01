'use client'

interface ChatResponseProps {
  answer: string
  data: Array<{[key: string]: string | number}>
  sources: string[]
}

export function ChatResponse({ answer, data, sources }: ChatResponseProps) {
  return (
    <div className="mt-6 p-4 bg-gray-50 rounded-lg">
      <h3 className="font-semibold mb-2">Risposta:</h3>
      <p className="text-gray-700 mb-4">{answer}</p>
      
      {data.length > 0 && (
        <div className="mb-4">
          <h4 className="font-medium mb-2">Dati:</h4>
          <div className="bg-white rounded border">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  {Object.keys(data[0]).map(key => (
                    <th key={key} className="p-2 text-left">{key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, index) => (
                  <tr key={index} className="border-t">
                    {Object.values(row).map((value, i) => (
                      <td key={i} className="p-2">{String(value)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      
      {sources.length > 0 && (
        <div>
          <h4 className="font-medium mb-1">Fonti:</h4>
          <ul className="text-sm text-gray-600">
            {sources.map((source, index) => (
              <li key={index}>• {source}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
