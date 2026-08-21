import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { getSession } from "../lib/session";
import {
  fetchPlans,
  formatPrice,
  yearlySaving,
  type Interval,
  type Plan,
} from "../lib/billing";

export function meta() {
  return [
    { title: "Pricing · Forma" },
    {
      name: "description",
      content:
        "Start free with your last 50 games. Go Pro for your whole history and deep engine review.",
    },
  ];
}

interface PricingData {
  plans: Plan[];
  signedIn: boolean;
}

/**
 * No `currentPlan`, and no checkout.
 *
 * `currentPlan` came off the session's `subscription` block, which came off the
 * prototype `/me`. `/v1` publishes no per-user entitlement, so nothing here can
 * tell a subscriber from anyone else, and the "Your current plan" marker is not
 * drawn rather than drawn on a guess.
 *
 * The catalogue's `checkoutAvailable` is read on the server and not branched on
 * here, because it answers a different question: whether the *API* holds Stripe
 * keys, not whether this client has a route to start a payment. It does not —
 * `/v1` has no checkout endpoint at all — so the Pro control is unavailable
 * whatever that flag says, and the card states the reason.
 */
export async function clientLoader(): Promise<PricingData> {
  const [catalogue, session] = await Promise.all([fetchPlans(), getSession()]);
  return {
    plans: catalogue.plans,
    signedIn: Boolean(session),
  };
}

const FAQ = [
  {
    q: "What happens if I cancel?",
    a: "Nothing is deleted. You drop back to the 50-game window and the rest is hidden, not removed. Resubscribe and it is all there.",
  },
  {
    q: "Do you need my chess password?",
    a: "No. Forma reads public game archives using your username. It cannot play moves on your behalf.",
  },
  {
    q: "How long does the first analysis take?",
    a: "A few hundred games takes a couple of minutes. Larger histories finish in the background.",
  },
  {
    q: "Is there an annual discount?",
    a: "Yes, annual billing costs less than paying monthly. Coaches working with several players should email us.",
  },
];

function PlanCard({
  plan,
  interval,
  signedIn,
  current = false,
}: {
  plan: Plan;
  interval: Interval;
  signedIn: boolean;
  /** Nothing sets this while `/v1` publishes no entitlement. See the loader. */
  current?: boolean;
}) {
  const isPro = plan.id === "pro";
  const price = interval === "yearly" ? plan.priceYearly : plan.priceMonthly;
  const per = interval === "yearly" ? "/year" : "/month";

  const note = isPro
    ? "Billing is not connected yet, so Pro cannot be bought. Everything in it is open to everyone in the meantime."
    : null;

  // Five regions in a fixed order. The grid outside puts every card's regions on
  // the same row lines, so the two plans stay comparable rather than each one
  // laying itself out to its own content height.
  return (
    <article className={`price-card ${isPro ? "is-featured" : ""}`}>
      {isPro ? <span className="price-flag">Most useful</span> : null}

      <header className="price-region">
        <h2>{plan.name}</h2>
        <p className="price-tagline">{plan.tagline}</p>
      </header>

      <div className="price-region price-money">
        <p className="price-amount metric">
          {price === 0 ? "Free" : formatPrice(price)}
          {price === 0 ? null : <small>{per}</small>}
        </p>
        <p className="price-saving">
          {isPro && interval === "yearly" && yearlySaving(plan) > 0
            ? `Saves ${yearlySaving(plan)}% versus monthly`
            : " "}
        </p>
      </div>

      <div className="price-region">
        {current ? (
          <span className="price-current">Your current plan</span>
        ) : plan.id === "free" ? (
          <Link to={signedIn ? "/today" : "/signup"} className="secondary-button price-cta">
            {signedIn ? "Go to dashboard" : "Start free"}
          </Link>
        ) : signedIn ? (
          /* Disabled rather than removed. The card's five regions are a fixed
             order, and a missing control would leave a signed-in reader with no
             statement at all about how they get Pro. The note underneath says
             why it cannot be pressed. */
          <button type="button" className="primary-button price-cta" disabled>
            Upgrade to Pro
          </button>
        ) : (
          <Link to="/signup?plan=pro" className="primary-button price-cta">
            Start free, upgrade later
          </Link>
        )}
      </div>

      <div className="price-region">
        {note ? <p className="price-note">{note}</p> : null}
      </div>

      <ul className="price-region price-features">
        {plan.features.map((feature) => (
          <li key={feature.label} className={feature.included ? "" : "is-excluded"}>
            <span className="price-tick" aria-hidden="true">{feature.included ? "✓" : "✕"}</span>
            <span>{feature.label}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function Pricing() {
  const { plans, signedIn } = useLoaderData() as PricingData;
  const [interval, setInterval] = useState<Interval>("monthly");

  return (
    <PublicPage>
      <header className="page-head page-head-center">
        <h1>Start free. Upgrade when 50 games is not enough.</h1>
        {/* The lessons are gone from the product, so they are gone from the
            sentence that sold them. Naming a surface that no longer exists is
            the one thing a pricing page cannot do. */}
        <p>
          Free is a real product, not a teaser: the whole opening tree your games
          made, and every mistake Forma found in it. Pro is for histories long
          enough that the pattern only shows up across all of it.
        </p>

        <div className="price-toggle" role="group" aria-label="Billing interval">
          <button
            type="button"
            className={interval === "monthly" ? "is-active" : ""}
            aria-pressed={interval === "monthly"}
            onClick={() => setInterval("monthly")}
          >
            Monthly
          </button>
          <button
            type="button"
            className={interval === "yearly" ? "is-active" : ""}
            aria-pressed={interval === "yearly"}
            onClick={() => setInterval("yearly")}
          >
            Yearly
          </button>
        </div>
      </header>

      <section className="price-grid">
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} interval={interval} signedIn={signedIn} />
        ))}
      </section>

      <dl className="price-faq">
        {FAQ.map((item) => (
          <div key={item.q}>
            <dt>{item.q}</dt>
            <dd>{item.a}</dd>
          </div>
        ))}
      </dl>
    </PublicPage>
  );
}
