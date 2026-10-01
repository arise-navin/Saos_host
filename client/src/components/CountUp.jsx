import { useEffect, useRef } from 'react';
import { useInView, useMotionValue, useSpring } from 'motion/react';

/*
 * COUNT UP — after React Bits' CountUp (reactbits.dev/text-animations/count-up).
 *
 * Counts from `from` to `to` with a spring once the number scrolls into view,
 * and again from where it stands whenever `to` changes (a new scan). Shows as
 * many decimals as `to` has, so 44.9 counts 0.0 → 44.9, not 0 → 45.
 * Reduced motion: the final number, no animation.
 */
export default function CountUp({ to, from = 0, duration = 1.4, className = '' }) {
  const ref = useRef(null);
  const decimals = (String(to).split('.')[1] || '').length;
  const motionValue = useMotionValue(from);
  const spring = useSpring(motionValue, {
    damping: 20 + 40 * (1 / duration),
    stiffness: 100 * (1 / duration),
  });
  const inView = useInView(ref, { once: true, margin: '0px' });

  const format = (v) => Number(v).toFixed(decimals);

  // The first paint shows `from`; text is written directly, not through state,
  // so the spring does not re-render React on every frame.
  useEffect(() => {
    if (ref.current) ref.current.textContent = format(from);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!inView) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      spring.jump(Number(to));
      if (ref.current) ref.current.textContent = format(to);
      return;
    }
    motionValue.set(Number(to));
  }, [inView, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => spring.on('change', (v) => {
    if (ref.current) ref.current.textContent = format(v);
  }), [spring, decimals]); // eslint-disable-line react-hooks/exhaustive-deps

  return <span ref={ref} className={className} aria-label={String(to)} />;
}
