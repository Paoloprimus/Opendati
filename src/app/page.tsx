export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-16">
        <div className="text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Opendati.it
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            I dati pubblici, risposte pronte
          </p>
          
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-lg shadow-lg p-8">
              <p className="text-gray-500 mb-4">
                Chiedimi qualsiasi cosa sui dati italiani...
              </p>
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-gray-400">
                Input chat (coming soon)
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
