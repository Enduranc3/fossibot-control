/**
 * Series colours (CSS variables from styles.css). Checked with the dataviz palette validator against the
 * card surface #131718 in dark mode: in/out pass the adjacent CVD and normal-vision checks; soc is only
 * ever drawn alone; outage is the reserved red (spec §9), drawn as a 12 % wash with its own legend entry.
 */
export const COLORS = {
  soc: 'var(--chart-soc)',
  in: 'var(--chart-in)',
  out: 'var(--chart-out)',
  outage: 'var(--chart-outage)',
} as const;
