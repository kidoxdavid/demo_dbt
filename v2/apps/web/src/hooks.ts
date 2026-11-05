import { useEffect, useState } from 'react';
/** Desktop layout from 900px up. Phones and small tablets get the app-style layout. */
export function useDesktop() {
  const q = '(min-width: 900px)'; const [d, set] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return d;
}
