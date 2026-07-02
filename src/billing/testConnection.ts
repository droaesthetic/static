import { appConfig } from "../config.js";

const stripeApiBaseUrl = "https://api.stripe.com/v1";

async function testStripe() {
  console.log("=== Stripe Configuration Test ===");
  
  if (!appConfig.stripe) {
    console.error("❌ Error: Stripe premium billing is not configured in your .env file.");
    console.error("Make sure to define both STRIPE_SECRET_KEY and STRIPE_PREMIUM_PRICE_ID.");
    process.exit(1);
  }

  const { secretKey, premiumPriceId, webhookSecret } = appConfig.stripe;
  console.log(`- Premium Price ID: ${premiumPriceId}`);
  console.log(`- Webhook Secret: ${webhookSecret ? "Configured" : "Not configured (optional for local testing)"}`);
  console.log("- Secret Key: (hidden)");

  try {
    console.log("\n1. Testing API Authentication...");
    const balanceResponse = await fetch(`${stripeApiBaseUrl}/balance`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secretKey}`
      }
    });

    const balanceData = await balanceResponse.json();
    if (!balanceResponse.ok) {
      throw new Error(`Auth failed: ${balanceData?.error?.message || balanceResponse.statusText}`);
    }
    console.log("✅ Authenticated successfully with Stripe!");

    console.log("\n2. Verifying Price ID...");
    const priceResponse = await fetch(`${stripeApiBaseUrl}/prices/${premiumPriceId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secretKey}`
      }
    });

    const priceData = await priceResponse.json();
    if (!priceResponse.ok) {
      throw new Error(`Price check failed: ${priceData?.error?.message || priceResponse.statusText}`);
    }

    if (!priceData.active) {
      console.warn("⚠️ Warning: The configured price is inactive on Stripe.");
    } else {
      console.log("✅ Price ID exists and is active!");
    }

    if (priceData.type !== "recurring") {
      console.warn("⚠️ Warning: The configured price is not recurring (subscription). Make sure it's a recurring price.");
    } else {
      console.log(`✅ Price type is recurring (subscription). Interval: ${priceData.recurring?.interval}`);
    }

    const amount = (priceData.unit_amount / 100).toFixed(2);
    console.log(`- Current Price Details: ${amount} ${priceData.currency.toUpperCase()}`);

    console.log("\n✨ Stripe Integration is configured correctly!");
  } catch (error: any) {
    console.error(`\n❌ Error testing Stripe: ${error.message}`);
    process.exit(1);
  }
}

testStripe();
