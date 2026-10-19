'use client';
// "This world's chats ▾": switch between this world's threads, start a new chat, or jump to a
// recent chat in another world.
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/Button';
import { Menu, type MenuEntry } from '@/components/ui/Menu';
import { listChats } from '@/lib/local';
import type { ChatThread } from '@/lib/types';
import { getWorldNames } from '@/state/ui';

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ChatSwitcher({
  threads,
  threadId,
  chatKey,
  canStartNew,
  onSwitch,
  onNew,
  onOpenOther,
}: {
  threads: ChatThread[];
  threadId: string;
  chatKey: string;
  /** False while the current chat is already empty (nothing to start fresh from). */
  canStartNew: boolean;
  onSwitch(id: string): void;
  onNew(): void;
  onOpenOther(worldId: string, threadId: string): void;
}) {
  const current = threads.find((t) => t.id === threadId);
  const title = current && current.title !== 'New chat' ? current.title : 'New chat';

  const items = (): MenuEntry[] => {
    const entries: MenuEntry[] = [{ kind: 'label', label: "This world's chats" }];
    for (const t of threads.slice(0, 8)) {
      entries.push({ label: t.title || 'New chat', icon: 'chat', hint: timeAgo(t.updatedAt), checked: t.id === threadId, onSelect: () => onSwitch(t.id) });
    }
    entries.push({ label: 'New chat', icon: 'plus', onSelect: onNew, disabled: !canStartNew });

    // One entry per other world: its most recent chat.
    const names = getWorldNames();
    const seen = new Set<string>();
    const others: ChatThread[] = [];
    for (const t of listChats()) {
      if (t.worldId === chatKey || t.worldId === 'new' || seen.has(t.worldId)) continue;
      seen.add(t.worldId);
      others.push(t);
      if (others.length >= 5) break;
    }
    if (others.length) {
      entries.push({ kind: 'separator' }, { kind: 'label', label: 'Recent chats in other worlds' });
      for (const t of others) {
        entries.push({
          label: t.title || 'Chat',
          icon: 'globe',
          stacked: true,
          hint: `${names[t.worldId] ?? 'A world'} · ${timeAgo(t.updatedAt)}`,
          onSelect: () => onOpenOther(t.worldId, t.id),
        });
      }
    }
    return entries;
  };

  return (
    <div className="flex items-center gap-1 px-3 pb-1">
      <Menu
        items={items}
        width={292}
        className="min-w-0 flex-1"
        renderTrigger={(p, open) => (
          <button
            type="button"
            {...p}
            className={`flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors ${open ? 'bg-[var(--hover)] text-ink' : 'text-ink-2 hover:bg-[var(--hover)] hover:text-ink'}`}
          >
            <span className="truncate">{title}</span>
            <Icon name="chevron-down" size={14} className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      />
      <IconButton icon="plus" label="New chat" size={36} onClick={onNew} disabled={!canStartNew} className="text-ink-3" />
    </div>
  );
}
