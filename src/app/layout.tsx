import './globals.css'

export const metadata = {
  title: 'Opendati.it - I dati pubblici, risposte pronte',
  description: 'Trasformiamo i dati pubblici italiani in risposte semplici',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  )
}
