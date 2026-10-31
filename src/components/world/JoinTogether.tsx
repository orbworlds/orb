'use client';
// Opened with a world owner's invite (SPEC §2 "Making a world together"): signed in, the person
// comes in at once; signed out, they sign in (or make an account) first.
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';
import { AccountCard, useMe } from '@/components/orb/AccountCard';
import { apiMessage, toast } from '@/state/toast';
import { useTogether } from '@/state/together';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';

export function JoinTogether() {
  const invite = useTogether((s) => s.invite);
  const shown = useWorld((s) => s.world?.id ?? null);
  const { signedIn, status } = useMe();
  const worldId = invite?.worldId ?? shown;

  useEffect(() => {
    if (invite && worldId && signedIn) void join(worldId, invite.token);
  }, [invite, worldId, signedIn]);

  const asking = !!invite && !!worldId && status !== 'loading' && !signedIn;
  const cancel = () => useTogether.setState({ invite: null });
  return (
    <Modal open={asking} onClose={cancel} title="Make it together" width={420}>
      {asking && <AccountCard variant="inline" where="together" reason="Sign in to change this world together" onCancel={cancel} />}
    </Modal>
  );
}

async function join(worldId: string, token: string): Promise<void> {
  useTogether.setState({ invite: null });
  try {
    const { world } = await api.joinWorld(worldId, token);
    const ws = useWorld.getState();
    if (ws.world?.id === world.id) await ws.refresh();
    else await ws.loadWorld(world.id);
    if (!world.invited) return; // its owner, opening their own invite
    toast(`You can change “${world.name}” now, together with ${world.authorName || 'its maker'}.`, 'success');
    useUi.getState().openPanel('chat');
  } catch (e) {
    toast(apiMessage(e, 'Couldn’t join this world. Try again in a moment.'), 'error');
  }
}
