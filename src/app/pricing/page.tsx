import type { Metadata } from 'next';
import Shell from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Plans',
  description: 'Orb is free to try. Credits pay for the AI that builds your worlds: 300 a month free, 2,000 with Pro.',
};

export default function PricingPage() {
  return <Shell mode="plans" />;
}
