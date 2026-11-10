import type { Metadata } from 'next';
import Shell from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Plans',
  description: 'Orb is free to try. Credits pay for the AI that builds your worlds: 70 a week free, 460 with Pro.',
};

export default function PricingPage() {
  return <Shell mode="plans" />;
}
