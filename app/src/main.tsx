import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installThreeConsoleFilter } from './lib/threeConsoleFilter'

installThreeConsoleFilter()

const root = createRoot(document.getElementById('root')!)

async function bootstrap() {
  const { default: App } = await import('./App.tsx')

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
