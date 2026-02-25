import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export function initReveal(): void {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced) {
    // Skip animations — just make everything visible immediately
    document.querySelectorAll('.reveal').forEach((el) => {
      (el as HTMLElement).style.opacity = '1';
      (el as HTMLElement).style.transform = 'none';
    });
    return;
  }

  const ctx = gsap.context(() => {
    // General .reveal elements: fade + slide up
    gsap.utils.toArray<HTMLElement>('.reveal').forEach((el) => {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: el,
          start: 'top 85%',
          once: true,
        },
      });
    });

    // Architecture rows: staggered within each .arch-list
    document.querySelectorAll('.arch-list').forEach((list) => {
      const items = list.querySelectorAll('.arch-item');
      if (items.length === 0) return;

      gsap.set(items, { opacity: 0, y: 20 });
      gsap.to(items, {
        opacity: 1,
        y: 0,
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.1,
        scrollTrigger: {
          trigger: list,
          start: 'top 85%',
          once: true,
        },
      });
    });

    // Pipeline steps: staggered sequential entrance
    const pipelineSteps = gsap.utils.toArray<HTMLElement>('.pipeline-step');
    if (pipelineSteps.length > 0) {
      gsap.set(pipelineSteps, { opacity: 0, y: 20 });
      gsap.to(pipelineSteps, {
        opacity: 1,
        y: 0,
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.12,
        scrollTrigger: {
          trigger: pipelineSteps[0].parentElement,
          start: 'top 85%',
          once: true,
        },
      });
    }

    // Trust cards: staggered grid entrance
    const trustCards = gsap.utils.toArray<HTMLElement>('.trust-card');
    if (trustCards.length > 0) {
      gsap.set(trustCards, { opacity: 0, y: 20 });
      gsap.to(trustCards, {
        opacity: 1,
        y: 0,
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.08,
        scrollTrigger: {
          trigger: trustCards[0].parentElement,
          start: 'top 85%',
          once: true,
        },
      });
    }

    // Secrets terminal: line-by-line typing effect
    const termLines = gsap.utils.toArray<HTMLElement>('.secrets-demo-body .term-line');
    if (termLines.length > 0) {
      gsap.set(termLines, { opacity: 0, x: -8 });
      gsap.to(termLines, {
        opacity: 1,
        x: 0,
        duration: 0.3,
        ease: 'power2.out',
        stagger: 0.06,
        scrollTrigger: {
          trigger: '.secrets-demo',
          start: 'top 85%',
          once: true,
        },
      });
    }
  });

  // Cleanup on page navigation (Astro view transitions)
  document.addEventListener('astro:before-swap', () => {
    ctx.revert();
  }, { once: true });
}
