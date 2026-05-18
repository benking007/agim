import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

/**
 * Tailwind 3 theme for agim web v2.
 *
 * Design tokens are HSL channels in CSS custom properties (see
 * `src/styles/tokens.css`). Tailwind references them via `hsl(var(...))`
 * so the same utility class produces light / dark output depending on
 * `[data-theme="dark"]` on the html element.
 *
 * The token names match the prior `_shell.css` --ag-* scheme so the
 * shadcn pieces we drop in later can reference the same theme values
 * via Tailwind utilities (no second source of truth).
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        bg:        'hsl(var(--ag-bg))',
        surface:   'hsl(var(--ag-surface))',
        'surface-2': 'hsl(var(--ag-surface-2))',
        // Borders
        border:    'hsl(var(--ag-border))',
        'border-strong': 'hsl(var(--ag-border-strong))',
        // Text
        text: {
          DEFAULT: 'hsl(var(--ag-text))',
          dim:     'hsl(var(--ag-text-dim))',
          muted:   'hsl(var(--ag-text-muted))',
        },
        // Brand / semantic
        accent: {
          DEFAULT: 'hsl(var(--ag-accent))',
          fg:      'hsl(var(--ag-accent-fg))',
          hover:   'hsl(var(--ag-accent-hover))',
          bg:      'hsl(var(--ag-accent-bg))',
        },
        success: {
          DEFAULT: 'hsl(var(--ag-success))',
          bg:      'hsl(var(--ag-success-bg))',
        },
        warning: {
          DEFAULT: 'hsl(var(--ag-warning))',
          bg:      'hsl(var(--ag-warning-bg))',
        },
        danger: {
          DEFAULT: 'hsl(var(--ag-danger))',
          bg:      'hsl(var(--ag-danger-bg))',
        },
        info: {
          DEFAULT: 'hsl(var(--ag-info))',
          bg:      'hsl(var(--ag-info-bg))',
        },
      },
      spacing: {
        // 4px scale aligned with the prior shell tokens.
        '0.5': '2px', '1': '4px', '1.5': '6px', '2': '8px',
        '3': '12px',  '4': '16px', '5': '20px', '6': '24px',
        '7': '32px',  '8': '48px', '9': '64px',
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '6px',
        lg: '10px',
        xl: '14px',
      },
      fontSize: {
        xs:   ['11px', { lineHeight: '14px' }],
        sm:   ['12px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '20px' }],
        md:   ['15px', { lineHeight: '22px' }],
        lg:   ['18px', { lineHeight: '26px' }],
        xl:   ['22px', { lineHeight: '30px' }],
        '2xl':['28px', { lineHeight: '36px' }],
      },
      boxShadow: {
        sm: 'var(--ag-shadow-sm)',
        DEFAULT: 'var(--ag-shadow-md)',
        md: 'var(--ag-shadow-md)',
        lg: 'var(--ag-shadow-lg)',
      },
      keyframes: {
        // Radix popover / dropdown / select / tooltip overlay animations.
        // tailwindcss-animate ships `data-state` driven utilities that
        // expect these names; the Tailwind `animate-in / animate-out`
        // helpers fall back to these for any component the plugin
        // doesn't already cover.
        'accordion-down': {
          from: { height: '0' },
          to:   { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to:   { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
      },
      // Mobile-friendly height units. `100dvh` honors the actual visible
      // viewport (excluding mobile URL bar / on-screen keyboard) where
      // available, with `100vh` as the desktop fallback.
      height: {
        'screen-dvh': ['100vh', '100dvh'] as unknown as string,
      },
      minHeight: {
        'screen-dvh': ['100vh', '100dvh'] as unknown as string,
      },
      // safe-area-inset utilities — used as `pt-safe`, `pb-safe` etc.
      // Concrete classes are defined in styles/globals.css @layer utilities.
    },
    container: {
      center: true,
      padding: {
        DEFAULT: '16px',
        sm: '24px',
        lg: '32px',
      },
      screens: {
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1400px',
      },
    },
    screens: {
      // Mobile-first; the existing pages all assume desktop. We add an
      // explicit `xs` for very narrow phones so layouts can degrade
      // further (drawer overlays instead of side-by-side, etc.).
      xs: '380px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config
