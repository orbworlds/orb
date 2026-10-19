// The on-screen keyboard. iOS Safari doesn't shrink the layout when it opens (Android does, with
// `interactive-widget=resizes-content` in the viewport tag): the visual viewport shrinks instead,
// and anything fixed to the bottom of the screen ends up under the keyboard. This keeps two CSS
// variables on <html> for what's actually visible: --kb (how far the keyboard covers the layout's
// bottom edge) and --vvh (the visible height).

export function trackVisualViewport(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement.style;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.setProperty('--kb', `${kb}px`);
      root.setProperty('--vvh', `${Math.round(vv.height)}px`);
    });
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
