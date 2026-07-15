// src/billing.js — Stripe subscription billing. All secrets come from env (never committed).
// Runs in safe "disabled" mode until STRIPE_SECRET_KEY is set, so the site never crashes.
import Stripe from "stripe";
import { q } from "./db.js";

const KEY = process.env.STRIPE_SECRET_KEY || "";
const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const SITE_URL = process.env.SITE_URL || "https://orakl.netlify.app";

export const billingEnabled = () => !!KEY;
const stripe = KEY ? new Stripe(KEY) : null;

// Create a Checkout Session and return its URL.
export async function createCheckout({ plan, email }) {
  if (!stripe) throw new Error("billing not configured");
  const price = plan === "annual" ? PRICE_ANNUAL : PRICE_MONTHLY;
  if (!price) throw new Error("price id not set");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    customer_email: email || undefined,
    allow_promotion_codes: true,
    success_url: `${SITE_URL}/?sub=success`,
    cancel_url: `${SITE_URL}/?sub=cancel`,
  });
  return session.url;
}

// Verify + handle a raw webhook payload. `rawBody` must be the untouched Buffer.
export async function handleWebhook(rawBody, signature) {
  if (!stripe) return { ok: false, reason: "billing off" };
  let event;
  if (WEBHOOK_SECRET) {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET); // throws on bad sig
  } else {
    event = JSON.parse(rawBody.toString());   // dev fallback (no verification)
  }
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const email = o.customer_details?.email || o.customer_email;
      q.userUpsert.run({ email, cid: o.customer, sid: o.subscription, status: "active", tier: "pro" });
      break;
    }
    case "customer.subscription.updated": {
      const active = ["active", "trialing"].includes(o.status);
      q.userSetStatusByCustomer.run({ cid: o.customer, sid: o.id, status: o.status, tier: active ? "pro" : "free" });
      break;
    }
    case "customer.subscription.deleted": {
      q.userSetStatusByCustomer.run({ cid: o.customer, sid: o.id, status: "canceled", tier: "free" });
      break;
    }
  }
  return { ok: true, type: event.type };
}

// Is this email an active Pro subscriber? (used by the access gate)
export function isPro(email) {
  if (!email) return false;
  const u = q.userByEmail.get({ email: String(email).toLowerCase() });
  return !!u && u.subscription_status === "active" && u.subscription_tier === "pro";
}
