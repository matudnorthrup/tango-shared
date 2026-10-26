import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'tango-voice': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { app: string };
      'tango-switcher': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { current: string };
    }
  }
}
