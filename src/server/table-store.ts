import type {
  BeliefRevision,
  DinerFeedback,
  DinerProfile,
  FulfillmentStatus,
  GroupMealSummary,
  Recommendation,
  Restaurant,
} from "@/domain/contracts";
import { demoRestaurants as restaurantCatalog } from "@/data/restaurant-catalog";
import { memoryGateway, resetStore } from "@/features/memory";
import { RuleBasedNegotiationEngine } from "@/features/negotiation/engine";
import type { Phase } from "@/lib/phase";
import type { CheckoutResult, CheckoutSession } from "@/features/checkout/contract";
import { createCheckoutSession, simulatePayment } from "@/features/checkout/simulator";
import type { FeedbackMemoryUpdate, FulfillmentStep } from "@/features/fulfillment/contract";
import {
  buildMealOutcome,
  confirmFeedbackMemoryUpdate,
  createFulfillmentTimeline,
} from "@/features/fulfillment/simulator";

/**
 * Server-side table state, now backed by the real MemoryGateway (Person 1)
 * and NegotiationEngine (Person 2) instead of fixed fixtures. What remains
 * a stand-in here is only the *table* concept itself (a shareable link with
 * seated diners, phase timing, checkout/fulfillment/feedback) — an
 * in-memory Map on the Next.js server process, lost on restart and unsafe
 * across multiple instances. Diner beliefs and meal history now live in
 * `@/features/memory`'s own store, not here.
 *
 * All tables recall against the SAME persistent group id (GROUP_ID), not
 * the table's own (per-link, freshly random) id. The table id is just this
 * browser session's shareable link; the group is the recurring
 * Alex/Sam/Jordan/Priya cast whose beliefs and meal history are meant to
 * persist across separate sittings — that is what makes group history and
 * the fresh-session proof genuine rather than reset-per-link.
 *
 * A table starts with nobody seated. Whoever creates it shares the link and
 * joins like everyone else via the identity picker — there is no hardcoded
 * "these three start seated, this one joins later." Any diner joining after
 * the first triggers the same rebalance path; the first diner to join just
 * establishes the initial recommendation.
 */

const GROUP_ID = "demo-group";
const ALL_DINER_IDS = ["alex", "sam", "jordan", "priya"];

const negotiationEngine = new RuleBasedNegotiationEngine();

export interface TableState {
  id: string;
  intent: string;
  seatedDinerIds: string[];
  phase: Phase;
  recommendation: Recommendation | null;
  previousRecommendation: Recommendation | null;
  revision: BeliefRevision | null;
  errorMessage: string | null;
  approved: boolean;
  approvedVersion: number | null;
  checkout: CheckoutSession | null;
  lastPaymentResult: CheckoutResult | null;
  fulfillmentStatus: FulfillmentStatus | null;
  feedback: DinerFeedback[];
  memoryUpdate: FeedbackMemoryUpdate | null;
  updatedAt: number;
}

export interface TableSnapshot extends TableState {
  diners: DinerProfile[];
  fulfillmentTimeline: FulfillmentStep[] | null;
}

const tables = new Map<string, TableState>();

function makeTableId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function schedule(id: string, delayMs: number, mutate: (table: TableState) => void): void {
  setTimeout(() => {
    const table = tables.get(id);
    if (!table) return;
    mutate(table);
    table.updatedAt = Date.now();
  }, delayMs);
}

/** Same as `schedule`, but for a mutation that itself needs to await the gateway/engine. */
function scheduleAsync(
  id: string,
  delayMs: number,
  run: (table: TableState) => Promise<void>,
): void {
  setTimeout(() => {
    const table = tables.get(id);
    if (!table) return;
    run(table)
      .catch((error: unknown) => {
        // Backstop only — runRebalance and reviseJordanBelief already turn
        // expected failures into phase/errorMessage themselves.
        table.phase = "error";
        table.errorMessage = error instanceof Error ? error.message : "Something went wrong.";
      })
      .finally(() => {
        table.updatedAt = Date.now();
      });
  }, delayMs);
}

function restaurantById(id: string): Restaurant | null {
  return restaurantCatalog.find((r) => r.id === id) ?? null;
}

function restaurantFor(recommendation: Recommendation): Restaurant | null {
  return restaurantById(recommendation.restaurantId);
}

/**
 * The one rebalance path, per docs/TEAM_PLAN.md: both "a diner joined" and
 * "a belief was revised" just mean "recall fresh context, re-run
 * negotiation, diff against the previous version." Recalls only active
 * beliefs (the gateway's guarantee) and lets the negotiation engine's own
 * NoFeasibleRestaurantError (checked by name, not `instanceof` — see note
 * below) become the explicit "no feasible result" phase rather than
 * fabricating a recommendation.
 */
async function runRebalance(table: TableState): Promise<void> {
  try {
    const context = await memoryGateway.recallGroupContext(
      GROUP_ID,
      table.seatedDinerIds,
      table.intent,
    );
    const recommendation = await negotiationEngine.rebalance({
      context,
      restaurants: restaurantCatalog,
      previousRecommendation: table.recommendation ?? undefined,
    });
    table.previousRecommendation = table.recommendation;
    table.recommendation = recommendation;
    table.phase = "ready";
    table.errorMessage = null;
  } catch (error) {
    // Person 2's engine (src/features/negotiation/engine.ts) throws its own
    // NoFeasibleRestaurantError, a *different class* than the same-named one
    // Person 4 added to negotiation/contract.ts. Checking by `.name` instead
    // of `instanceof` works no matter which of the two ever ends up thrown.
    if (error instanceof Error && error.name === "NoFeasibleRestaurantError") {
      table.phase = "no_feasible_result";
      table.errorMessage = error.message;
    } else {
      table.phase = "error";
      table.errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    }
  }
}

export function createTable(intent: string): TableState {
  const id = makeTableId();
  const table: TableState = {
    id,
    intent,
    seatedDinerIds: [],
    phase: "idle",
    recommendation: null,
    previousRecommendation: null,
    revision: null,
    errorMessage: null,
    approved: false,
    approvedVersion: null,
    checkout: null,
    lastPaymentResult: null,
    fulfillmentStatus: null,
    feedback: [],
    memoryUpdate: null,
    updatedAt: Date.now(),
  };
  tables.set(id, table);
  return table;
}

/**
 * A diner opens the shared link and claims their seat. Idempotent for
 * diners already seated. The first diner to join establishes the initial
 * recommendation (recall/negotiate timing); every diner after that
 * triggers the same rebalance path used for a belief revision — there is
 * nothing hardcoded about who starts seated or who joins later. Whoever
 * creates the table, and whoever they invite, in whatever order, all go
 * through this one path.
 */
export function joinTable(id: string, dinerId: string): TableState | null {
  const table = tables.get(id);
  if (!table) return null;
  if (table.approved) return table;
  if (!ALL_DINER_IDS.includes(dinerId)) return table;
  if (table.seatedDinerIds.includes(dinerId)) return table;

  const isFirstDiner = table.seatedDinerIds.length === 0;
  table.seatedDinerIds = [...table.seatedDinerIds, dinerId];
  table.updatedAt = Date.now();

  if (isFirstDiner) {
    table.phase = "recalling";
    schedule(id, 600, (t) => {
      t.phase = "negotiating";
    });
    scheduleAsync(id, 1300, (t) => runRebalance(t));
  } else {
    table.phase = "recalling";
    schedule(id, 400, (t) => {
      t.phase = "rebalancing";
    });
    scheduleAsync(id, 1050, (t) => runRebalance(t));
  }

  return table;
}

/**
 * Jordan corrects his own belief from his own device. The revision is
 * written through the real MemoryGateway (so it persists independent of
 * this table, and the previous/current pair for the audit UI comes
 * straight from the gateway's own supersession logic), then the same
 * rebalance path re-runs.
 */
export function reviseJordanBelief(id: string): TableState | null {
  const table = tables.get(id);
  if (!table) return null;
  if (table.approved) return table;
  if (!table.seatedDinerIds.includes("jordan")) return table;
  if (table.revision) return table;

  table.phase = "revising_belief";
  table.updatedAt = Date.now();

  scheduleAsync(id, 550, async (t) => {
    const revision = await memoryGateway.reviseBelief({
      dinerId: "jordan",
      sessionId: id,
      kind: "allergy",
      value: "shellfish",
      correctionText: "Actually I'm allergic to shellfish.",
    });
    t.revision = revision;
    t.phase = "recalling";
  });
  schedule(id, 950, (t) => {
    t.phase = "rebalancing";
  });
  scheduleAsync(id, 1600, (t) => runRebalance(t));

  return table;
}

/**
 * Approving locks the table: no further joins or belief revisions, and
 * the recommendation version at this moment becomes the only one
 * checkout will accept. Errors here are reported via a discriminated
 * return rather than a thrown exception, since API routes need to map
 * "not ready yet" to a 409 without a try/catch at every call site.
 */
export function approveTable(id: string): { ok: true; table: TableState } | { ok: false; reason: string } {
  const table = tables.get(id);
  if (!table) return { ok: false, reason: "Table not found." };
  if (table.phase !== "ready" || !table.recommendation) {
    return { ok: false, reason: "No ready recommendation to approve yet." };
  }
  table.approved = true;
  table.approvedVersion = table.recommendation.version;
  table.updatedAt = Date.now();
  return { ok: true, table };
}

/**
 * Creates the checkout session from the table's approved recommendation
 * — never from a hardcoded fixture — so the split always matches what
 * this specific group actually negotiated.
 */
export function startCheckout(id: string): { ok: true; table: TableState } | { ok: false; reason: string } {
  const table = tables.get(id);
  if (!table) return { ok: false, reason: "Table not found." };
  if (!table.approved || !table.recommendation || table.approvedVersion === null) {
    return { ok: false, reason: "Approve a recommendation before checkout." };
  }
  if (table.checkout) return { ok: true, table };

  const session = createCheckoutSession({
    recommendation: table.recommendation,
    latestApprovedVersion: table.approvedVersion,
  });

  // Person 4's simulator labels "main" line items with the raw dishId
  // (it has no restaurant to resolve names against). Relabel with the
  // actual dish name here, since we do have the restaurant.
  const restaurant = restaurantFor(table.recommendation);
  if (restaurant) {
    const dishNameById = new Map(restaurant.menu.map((dish) => [dish.id, dish.name]));
    session.dinerCharges = session.dinerCharges.map((charge) => ({
      ...charge,
      lineItems: charge.lineItems.map((item) =>
        item.kind === "main" && dishNameById.has(item.label)
          ? { ...item, label: dishNameById.get(item.label)! }
          : item,
      ),
    }));
  }

  table.checkout = session;
  table.updatedAt = Date.now();
  return { ok: true, table };
}

/**
 * Simulates payment. "Processing" is set immediately so pollers see it,
 * then the real transition lands shortly after (matching the rest of
 * this store's phase-timing feel).
 *
 * Guards against a quirk in Person 4's simulatePayment: its failCheckout
 * helper forces the returned session to status "failed" even for the
 * "already paid" / "already processing" rejection branches. Applying
 * that blindly would let a duplicate Pay click flip a genuinely
 * completed payment back to "failed". So once a session has already
 * settled (paid or mid-processing), we keep it as the source of truth
 * and only surface the rejection result — we never overwrite it.
 */
export function payForTable(
  id: string,
  options?: { forceFailure?: boolean },
): { ok: true; table: TableState } | { ok: false; reason: string } {
  const table = tables.get(id);
  if (!table) return { ok: false, reason: "Table not found." };
  if (!table.checkout) return { ok: false, reason: "Start checkout before paying." };

  const alreadySettled = table.checkout.status === "paid" || table.checkout.status === "processing";

  if (alreadySettled) {
    const transition = simulatePayment({ session: table.checkout });
    table.lastPaymentResult = transition.result;
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  const sessionForAttempt = table.checkout;
  table.checkout = { ...table.checkout, status: "processing" };
  table.updatedAt = Date.now();

  schedule(id, 700, (t) => {
    const transition = simulatePayment({
      session: sessionForAttempt,
      forceFailure: options?.forceFailure,
    });
    t.checkout = transition.completedSession;
    t.lastPaymentResult = transition.result;

    if (transition.result.status === "paid") {
      t.fulfillmentStatus = "submitted";
      const restaurant = t.recommendation ? restaurantFor(t.recommendation) : null;
      if (restaurant && t.recommendation) {
        const steps: FulfillmentStatus[] = [
          "accepted",
          "preparing",
          "ready",
          "out_for_delivery",
          "completed",
        ];
        steps.forEach((status, index) => {
          schedule(id, 900 * (index + 1), (tt) => {
            tt.fulfillmentStatus = status;
          });
        });
      }
    }
  });

  return { ok: true, table };
}

/**
 * One diner submits their own feedback. Only allowed once fulfillment has
 * completed. Once every seated diner has responded, builds the
 * MealOutcome and writes it back through the real MemoryGateway (scoped
 * to the persistent GROUP_ID, not this table's own id) — so a later
 * fresh-session lookup, or even a brand-new table with the same group,
 * genuinely reflects it. This is async because the plan requires waiting
 * for confirmed save before showing "memory updated."
 */
export async function submitFeedback(
  id: string,
  dinerId: string,
  liked: boolean,
  note?: string,
): Promise<{ ok: true; table: TableState } | { ok: false; reason: string }> {
  const table = tables.get(id);
  if (!table) return { ok: false, reason: "Table not found." };
  if (table.fulfillmentStatus !== "completed") {
    return { ok: false, reason: "Feedback opens once fulfillment is completed." };
  }
  if (!table.seatedDinerIds.includes(dinerId)) {
    return { ok: false, reason: "This diner is not at the table." };
  }
  const selection = table.recommendation?.selections.find((s) => s.dinerId === dinerId);
  if (!selection) return { ok: false, reason: "No selection on file for this diner." };

  const withoutExisting = table.feedback.filter((f) => f.dinerId !== dinerId);
  table.feedback = [...withoutExisting, { dinerId, dishId: selection.dishId, liked, note }];
  table.updatedAt = Date.now();

  const allResponded = table.seatedDinerIds.every((seatedId) =>
    table.feedback.some((f) => f.dinerId === seatedId),
  );

  if (allResponded && table.recommendation && !table.memoryUpdate) {
    const completedAt = new Date().toISOString();
    const outcome = buildMealOutcome({
      groupId: GROUP_ID,
      recommendation: table.recommendation,
      feedback: table.feedback,
      completedAt,
      currentStatus: table.fulfillmentStatus,
    });
    await memoryGateway.saveMealOutcome(outcome);
    table.memoryUpdate = confirmFeedbackMemoryUpdate({ outcome, savedAt: completedAt });
    table.updatedAt = Date.now();
  }

  return { ok: true, table };
}

export async function getTable(id: string): Promise<TableSnapshot | null> {
  const table = tables.get(id);
  if (!table) return null;
  const context = await memoryGateway.recallGroupContext(GROUP_ID, table.seatedDinerIds, table.intent);
  const restaurant = table.recommendation ? restaurantFor(table.recommendation) : null;
  const fulfillmentTimeline =
    table.recommendation && restaurant && table.fulfillmentStatus
      ? createFulfillmentTimeline(table.recommendation, restaurant, table.fulfillmentStatus)
      : null;
  return {
    ...table,
    diners: context.diners,
    fulfillmentTimeline,
  };
}

export async function getAllDinerProfiles(): Promise<DinerProfile[]> {
  const context = await memoryGateway.recallGroupContext(GROUP_ID, ALL_DINER_IDS, "");
  return context.diners;
}

export async function getDinerProfile(id: string): Promise<DinerProfile | null> {
  const context = await memoryGateway.recallGroupContext(GROUP_ID, [id], "");
  return context.diners[0] ?? null;
}

/**
 * The mock gateway's recall stores each meal's restaurant as its id (see
 * mock-gateway.ts's `restaurant: o.restaurantId`), not a display name.
 * Resolved here against the catalog for anything rendering this list.
 */
export async function getGroupHistory(): Promise<GroupMealSummary[]> {
  const context = await memoryGateway.recallGroupContext(GROUP_ID, ALL_DINER_IDS, "");
  return context.history.map((meal) => ({
    ...meal,
    restaurant: restaurantById(meal.restaurant)?.name ?? meal.restaurant,
  }));
}

/** Demo-rehearsal reset: clears every table and restores seed beliefs/history. */
export function resetAll(): void {
  resetStore();
  tables.clear();
}
