import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'pantheon-yellow':       '#EFD01B',
        'pantheon-yellow-dark':  '#C9AE00',
        'pantheon-bg':           '#0C0C0C',
        'pantheon-bg-card':      '#141414',
        'pantheon-bg-elevated':  '#1C1C1C',
        'pantheon-bg-console':   '#0A0A0A',
        'pantheon-border':       '#272727',
        'pantheon-border-hi':    '#383838',
        'pantheon-text':         '#E8E8E8',
        'pantheon-text-muted':   '#7A7A7A',
        'pantheon-text-dim':     '#4A4A4A',
        'pantheon-success':      '#22C55E',
        'pantheon-success-dim':  '#15803D',
        'pantheon-error':        '#EF4444',
        'pantheon-error-dim':    '#991B1B',
        'pantheon-warning':      '#F97316',
        'pantheon-info':         '#60A5FA',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%':       { opacity: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        blink:      'blink 1s step-end infinite',
        'fade-in':  'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.3s ease-out',
      },
    },
  },
  plugins: [],
}

export default config
