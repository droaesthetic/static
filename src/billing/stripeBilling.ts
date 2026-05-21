import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig } from "../config.js";

export type StripePremiumSync = {
  userId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus: string;
  currentPeriodEnd?: string;
};

type StripeCheckoutSession = {
  id: string;
  url?: string | null;
  customer?: string | null;
  subscription?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
};

type StripeSubscription = {
  id: string;
  customer?: string | null;
  status?: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
};

type StripeInvoice = {
  customer?: string | null;
  subscription?: string | { id?: string } | null;
  metadata?: Record<string, string>;
};

type StripeEvent = {
  type: string;
  data?: { object?: unknown };
};

const stripeApiBaseUrl = "https://api.stripe.com/v1";
const webhookToleranceSeconds = 300;

export class StripeBillingService {
  static isConfigured() {
    return Boolean(appConfig.stripe);
  }

  static async createPremiumCheckoutSession(userId: string) {
    const stripe = this.requireStripeConfig();
    const successUrl = new URL("/?premium=success", appConfig.dashboardPublicUrl);
    const cancelUrl = new URL("/?premium=cancelled", appConfig.dashboardPublicUrl);
    const body = new URLSearchParams({
      mode: "subscription",
      client_reference_id: userId,
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      "line_items[0][price]": stripe.premiumPriceId,
      "line_items[0][quantity]": "1",
      "metadata[discordUserId]": userId,
      "subscription_data[metadata][discordUserId]": userId
    });

    const session = await this.request<StripeCheckoutSession>("/checkout/sessions", {
      method: "POST",
      body
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.");
    }

    return session.url;
  }

  static verifyAndParseWebhook(rawBody: Buffer, signatureHeader: string | undefined) {
    const stripe = this.requireStripeConfig();
    if (!stripe.webhookSecret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required to accept Stripe webhooks.");
    }

    if (!signatureHeader) {
      throw new Error("Missing Stripe-Signature header.");
    }

    const signature = this.parseSignatureHeader(signatureHeader);
    const signedPayload = `${signature.timestamp}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", stripe.webhookSecret)
      .update(signedPayload)
      .digest("hex");

    if (!this.secureCompareHex(signature.v1, expected)) {
      throw new Error("Invalid Stripe webhook signature.");
    }

    const ageSeconds = Math.abs(Date.now() / 1000 - signature.timestamp);
    if (ageSeconds > webhookToleranceSeconds) {
      throw new Error("Stripe webhook signature is too old.");
    }

    return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
  }

  static async resolvePremiumSyncFromEvent(event: StripeEvent): Promise<StripePremiumSync | null> {
    const object = event.data?.object;
    if (!object || typeof object !== "object") {
      return null;
    }

    if (event.type === "checkout.session.completed") {
      const session = object as StripeCheckoutSession;
      const userId = session.client_reference_id ?? session.metadata?.discordUserId;
      if (!userId || !session.subscription) {
        return null;
      }

      return {
        userId,
        stripeCustomerId: session.customer ?? undefined,
        stripeSubscriptionId: session.subscription,
        subscriptionStatus: "active"
      };
    }

    if (event.type.startsWith("customer.subscription.")) {
      return this.subscriptionToPremiumSync(object as StripeSubscription);
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = object as StripeInvoice;
      const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription?.id;

      if (!subscriptionId) {
        return null;
      }

      const subscription = await this.retrieveSubscription(subscriptionId);
      const sync = this.subscriptionToPremiumSync(subscription);
      if (!sync) {
        return null;
      }

      if (event.type === "invoice.payment_failed") {
        return {
          ...sync,
          subscriptionStatus: "payment_failed"
        };
      }

      return sync;
    }

    return null;
  }

  private static subscriptionToPremiumSync(subscription: StripeSubscription): StripePremiumSync | null {
    const userId = subscription.metadata?.discordUserId;
    if (!userId) {
      return null;
    }

    return {
      userId,
      stripeCustomerId: subscription.customer ?? undefined,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status ?? "unknown",
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : undefined
    };
  }

  private static async retrieveSubscription(subscriptionId: string) {
    return this.request<StripeSubscription>(`/subscriptions/${subscriptionId}`, { method: "GET" });
  }

  private static async request<T>(path: string, init: RequestInit) {
    const stripe = this.requireStripeConfig();
    const response = await fetch(`${stripeApiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${stripe.secretKey}`,
        ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {})
      }
    });

    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | T | undefined;
    if (!response.ok) {
      const message = typeof payload === "object" && payload && "error" in payload ? payload.error?.message : undefined;
      throw new Error(message || `Stripe request failed with HTTP ${response.status}.`);
    }

    return payload as T;
  }

  private static parseSignatureHeader(value: string) {
    const parts = Object.fromEntries(value.split(",").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key, rest.join("=")];
    }));
    const timestamp = Number.parseInt(parts.t ?? "", 10);
    const v1 = parts.v1;
    if (!Number.isFinite(timestamp) || !v1) {
      throw new Error("Malformed Stripe-Signature header.");
    }

    return { timestamp, v1 };
  }

  private static secureCompareHex(left: string, right: string) {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private static requireStripeConfig() {
    if (!appConfig.stripe) {
      throw new Error("Stripe premium billing is not configured.");
    }

    return appConfig.stripe;
  }
}
