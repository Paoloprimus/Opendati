export interface ChatResponse {
  answer: string
  data: Array<{
    [key: string]: string | number
  }>
  sources: string[]
}

export interface Dataset {
  id: string
  title: string
  description: string
  source: string
  url: string
}

export interface AnalysisResult {
  summary: string
  results: Array<{
    [key: string]: string | number
  }>
  chartData: {
    labels: string[]
    values: number[]
  }
}
