import { motion } from 'framer-motion'
import { Film } from 'lucide-react'
import './Header.css'

export default function Header() {
  return (
    <motion.header
      className="header"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="header-left">
        <div className="logo-mark"><Film size={17} strokeWidth={1.5} /></div>
        <span className="logo-name">视频工作台</span>
      </div>
    </motion.header>
  )
}
