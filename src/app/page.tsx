import { ChatInput } from '../components/ChatInput'

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-16">
        <div className="text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Opendati.it
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            i dati a nostra disposizione
          </p>
          
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-lg shadow-lg p-8">
              <p className="text-gray-500 mb-4">
                Chiedimi qualsiasi cosa sui dati italiani...
              </p>
              
              <ChatInput />
              
              <div className="mt-6 text-sm text-gray-400">
                <p>Esempi:</p>
                <p>"Confronta la spesa turistica di Venezia e Roma"</p>
                <p>"Mostrami l'andamento dei reati a Milano ultimi 5 anni"</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
