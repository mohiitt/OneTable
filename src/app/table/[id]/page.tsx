"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { DinerProfile } from "@/domain/contracts";
import { BeliefRevisionPanel } from "@/components/BeliefRevisionPanel";
import { CheckoutPanel } from "@/components/CheckoutPanel";
import { DinerRoster } from "@/components/DinerRoster";
import { FeedbackForm } from "@/components/FeedbackForm";
import { FulfillmentTimeline } from "@/components/FulfillmentTimeline";
import { IdentityPicker } from "@/components/IdentityPicker";
import { RecommendationCard } from "@/components/RecommendationCard";
import { ShareLink } from "@/components/ShareLink";
import { StatusBanner } from "@/components/StatusBanner";
import { useTablePolling } from "@/components/use-table-polling";
import { demoRestaurants } from "@/data/restaurant-catalog";
import {
  approveTableRequest,
  fetchAllDiners,
  joinTableRequest,
  payTableRequest,
  resetDemo,
  reviseJordanRequest,
  startCheckoutRequest,
  submitFeedbackRequest,
} from "@/lib/api";
import {
  clearClaim,
  getClaim,
  getServerClaimSnapshot,
  setClaim,
  subscribeClaim,
} from "@/lib/table-claim";

const BUSY_PHASES = new Set(["recalling", "negotiating", "revising_belief", "rebalancing"]);

export default function TablePage() {
  const params = useParams<{ id: string }>();
  const tableId = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();

  const { table, notFound } = useTablePolling(tableId);
  const [allDiners, setAllDiners] = useState<DinerProfile[]>([]);
  const [claiming, setClaiming] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const you = useSyncExternalStore(
    subscribeClaim,
    () => getClaim(tableId),
    getServerClaimSnapshot,
  );

  useEffect(() => {
    fetchAllDiners().then(setAllDiners);
  }, [tableId]);

  if (notFound) {
    return (
      <main>
        <section className="workspace">
          <p className="inlineHint">
            This table link doesn&apos;t exist (maybe the demo was restarted).{" "}
            <Link href="/">Create a new table</Link>.
          </p>
        </section>
      </main>
    );
  }

  if (!table) {
    return (
      <main>
        <section className="workspace">
          <StatusBanner phase="recalling" />
        </section>
      </main>
    );
  }

  const pick = async (dinerId: string) => {
    setClaiming(true);
    if (!table.seatedDinerIds.includes(dinerId)) {
      await joinTableRequest(tableId, dinerId);
    }
    setClaim(tableId, dinerId);
    setClaiming(false);
  };

  const switchProfile = () => {
    clearClaim(tableId);
  };

  const busy = actionBusy || BUSY_PHASES.has(table.phase);

  const runAction = async (request: () => Promise<{ error: string | null }>) => {
    setActionBusy(true);
    setActionError(null);
    const result = await request();
    if (result.error) setActionError(result.error);
    setActionBusy(false);
  };

  const correctJordanBelief = () => runAction(() => reviseJordanRequest(tableId));
  const approve = () => runAction(() => approveTableRequest(tableId));
  const startCheckout = () => runAction(() => startCheckoutRequest(tableId));
  const pay = () => runAction(() => payTableRequest(tableId));
  const submitFeedback = (liked: boolean, note?: string) =>
    you ? runAction(() => submitFeedbackRequest(tableId, you, liked, note)) : undefined;

  const restart = async () => {
    await resetDemo();
    clearClaim(tableId);
    router.push("/");
  };

  const restaurant = table.recommendation
    ? demoRestaurants.find((r) => r.id === table.recommendation?.restaurantId)
    : undefined;
  const yourSelection = table.recommendation?.selections.find((s) => s.dinerId === you);
  const yourDish = restaurant?.menu.find((d) => d.id === yourSelection?.dishId) ?? null;
  const missingDiners = allDiners.filter((d) => !table.seatedDinerIds.includes(d.id));

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            1T
          </span>
          <div>
            <strong>OneTable</strong>
            <span>MenuSifu Track 1</span>
          </div>
        </div>
        <span className="status">table {tableId}</span>
      </header>

      <section className="workspace">
        {!you ? (
          <>
            <div className="intro intro--compact">
              <p className="eyebrow">Join this table</p>
              <h1>Who are you?</h1>
            </div>
            <IdentityPicker
              diners={allDiners}
              seatedIds={table.seatedDinerIds}
              onPick={pick}
              busy={claiming}
            />
          </>
        ) : (
          <>
            <div className="intro intro--compact">
              <p className="eyebrow">Live table</p>
              <h1>Recommendation</h1>
            </div>

            <ShareLink tableId={tableId} />

            <StatusBanner phase={table.phase} message={table.errorMessage} />

            <section className="panel" aria-labelledby="roster-title">
              <div className="panelHeading">
                <div>
                  <p className="eyebrow">Table</p>
                  <h2 id="roster-title">Diners</h2>
                </div>
                <span>{table.seatedDinerIds.length} of 4 seated</span>
              </div>
              <div className="panelBody">
                <DinerRoster diners={table.diners} presentIds={table.seatedDinerIds} youId={you} />
              </div>
            </section>

            {table.recommendation && (
              <RecommendationCard
                recommendation={table.recommendation}
                previousRecommendation={table.previousRecommendation}
                restaurants={demoRestaurants}
                diners={table.diners}
              />
            )}

            {table.revision && (
              <BeliefRevisionPanel
                revision={table.revision}
                diner={table.diners.find((d) => d.id === "jordan")}
              />
            )}

            {!table.approved && missingDiners.length > 0 && (
              <p className="inlineHint">
                Waiting for {missingDiners.map((d) => d.name).join(", ")} to join — share the
                table link above with them.
              </p>
            )}

            {actionError && <p className="checkoutFailed">{actionError}</p>}

            {!table.approved && (
              <div className="actionRow">
                {you === "jordan" && !table.revision && (
                  <button
                    type="button"
                    className="secondaryButton"
                    onClick={correctJordanBelief}
                    disabled={busy}
                  >
                    Correct my belief to shellfish allergy
                  </button>
                )}
                <button
                  type="button"
                  className="primaryButton"
                  onClick={approve}
                  disabled={busy || table.phase !== "ready"}
                >
                  Approve & continue
                </button>
              </div>
            )}

            {table.approved && !table.checkout && (
              <div className="actionRow">
                <button type="button" className="primaryButton" onClick={startCheckout} disabled={busy}>
                  Start checkout
                </button>
              </div>
            )}

            {table.checkout && (
              <CheckoutPanel
                session={table.checkout}
                lastResult={table.lastPaymentResult}
                diners={table.diners}
                canPay={table.checkout.status === "idle" || table.checkout.status === "failed"}
                paying={actionBusy}
                onPay={pay}
              />
            )}

            {table.fulfillmentTimeline && <FulfillmentTimeline steps={table.fulfillmentTimeline} />}

            {table.fulfillmentStatus === "completed" && (
              <FeedbackForm
                you={you}
                yourDishName={yourDish?.name ?? null}
                seatedDinerIds={table.seatedDinerIds}
                diners={table.diners}
                feedback={table.feedback}
                busy={actionBusy}
                onSubmit={submitFeedback}
              />
            )}

            {table.memoryUpdate?.status === "saved" && (
              <div className="freshSessionNote">
                Memory updated. Open{" "}
                <Link href={`/diner/${you}`} target="_blank">
                  your profile in a new tab
                </Link>{" "}
                to see this persist in a fresh session.
              </div>
            )}

            <div className="actionRow">
              <button type="button" className="secondaryButton" onClick={switchProfile}>
                Not you? Switch profile
              </button>
              <button type="button" className="secondaryButton" onClick={restart}>
                Restart demo
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
