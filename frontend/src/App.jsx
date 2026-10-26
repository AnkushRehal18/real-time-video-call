import { useState } from 'react'
import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'
import VideoScreen from './components/videScreen'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
    <VideoScreen/>
    </>
  )
}

export default App
