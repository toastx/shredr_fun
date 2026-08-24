import { useCallback, useEffect, useRef, useState } from "react";
import { shredrClient, type PendingAction } from "../lib";

/**
 * Finds cycles that died mid-flight and finishes them.
 *
 * A shred spans several transactions across two layers. If the tab closes
 * between them the funds are still on-chain but nothing points at them, so
 * every entry point that signs a user in has to check — recovery wired into
 * one page only helps users who happen to visit that page.
 *
 * Surfaces what it found before acting, then proceeds: resuming spends relayer
 * SOL and emits base-layer transactions, which the user should see rather than
 * discover in their history.
 */
export interface PendingRecovery {
  /** What was found, while it is being worked through. Null when idle. */
  plans: PendingAction[] | null;
  busy: boolean;
  /** Set when some, but not all, plans succeeded. */
  error: string | null;
  /**
   * Safe to call after `initFromSignature`; a no-op if nothing is pending.
   *
   * `onSettled` is passed per call rather than held in a ref, so the hook
   * never writes during render and `run` keeps a stable identity.
   */
  run: (onSettled?: () => void | Promise<void>) => Promise<void>;
}

export function usePendingRecovery(): PendingRecovery {
  const [plans, setPlans] = useState<PendingAction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (onSettled?: () => void | Promise<void>) => {
    try {
      const pending = await shredrClient.planPending();
      if (!mounted.current || pending.length === 0) return;

      setPlans(pending);
      setBusy(true);

      const results = await shredrClient.resumePending(pending);
      if (!mounted.current) return;

      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(
          `Recovered ${results.length - failed.length}/${results.length} pending deposit(s); ` +
            `${failed.length} still need attention.`,
        );
      }

      await onSettled?.();
    } catch (err) {
      // Recovery is opportunistic — a failure here must not block a sign-in
      // that otherwise worked.
      console.warn("[usePendingRecovery] failed:", err);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setPlans(null);
      }
    }
  }, []);

  return { plans, busy, error, run };
}
