'use client';
import { create } from 'zustand';
import { track } from '@/lib/analytics';

export interface Toast {
  id: number;
  text: string;
  tone?: 'default' | 'success' | 'error';
  action?: { label: string; onClick(): void };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>, ms?: number): void;
  dismiss(id: number): void;
}

let seq = 1;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t, ms = 3200) {
    const id = seq++;
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] });
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Fire-and-forget toast from anywhere. */
export function toast(text: string, tone: Toast['tone'] = 'default', action?: Toast['action']) {
  if (tone === 'error') track('error_toast', { text: text.slice(0, 160) });
  useToasts.getState().push({ text, tone, action });
}
