"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DinerProfile } from "@/domain/contracts";
import { DinerRoster } from "@/components/DinerRoster";
import { createTableRequest, fetchAllDiners, resetDemo } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [diners, setDiners] = useState<DinerProfile[]>([]);
  const [intent, setIntent] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchAllDiners().then(setDiners);
  }, []);

  const createTable = async () => {
    setCreating(true);
    const result = await createTableRequest(intent);
    if (result) {
      router.push(`/table/${result.id}`);
      return;
    }
    setCreating(false);
  };

  const restart = async () => {
    await resetDemo();
    setDiners(await fetchAllDiners());
  };

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
        <span className="status">create table</span>
      </header>

      <section className="workspace">
        <div className="intro">
          <p className="eyebrow">Group dining agent</p>
          <h1>One table. Current beliefs. One order.</h1>
          <p>
            OneTable recalls each diner&apos;s active constraints before it
            negotiates. Create a table, join as whichever diner you are, then
            share the link with whoever else you want at the table — the
            order rebalances every time someone new joins.
          </p>
        </div>

        <section className="panel" aria-labelledby="diners-title">
          <div className="panelHeading">
            <div>
              <p className="eyebrow">Remembered diners</p>
              <h2 id="diners-title">Who OneTable already knows</h2>
            </div>
            <span>{diners.length} of 4 loaded</span>
          </div>
          <div className="panelBody">
            <DinerRoster diners={diners} presentIds={[]} />
          </div>
        </section>

        <section className="panel" aria-labelledby="intent-title">
          <div className="panelHeading">
            <div>
              <p className="eyebrow">Dining intent</p>
              <h2 id="intent-title">What is the table looking for?</h2>
            </div>
          </div>
          <div className="panelBody">
            <input
              className="intentInput"
              type="text"
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              placeholder="quick lunch, around $20 each"
              aria-label="Dining intent"
            />
            <button
              type="button"
              className="primaryButton"
              onClick={createTable}
              disabled={creating}
            >
              {creating ? "Creating…" : "Create table"}
            </button>
            <p className="inlineHint">
              Creates an empty table and gives you a link. You&apos;ll pick who you
              are first, then share the link with anyone else you want at the
              table.
            </p>
          </div>
        </section>

        <div className="actionRow">
          <button type="button" className="secondaryButton" onClick={restart}>
            Restart demo
          </button>
        </div>
      </section>
    </main>
  );
}
