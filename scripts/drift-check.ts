import { InfisicalClient } from "@infisical/sdk";

async function runDriftCheck() {
  const strictness = process.env.STRICTNESS || 'warn';
  console.log(`[Guardrails] Starting drift check with strictness: ${strictness}`);

  const client = new InfisicalClient({
    token: process.env.INFISICAL_TOKEN!
  });

  // 1. Fetch expected secrets from Infisical (/tuj/staging)
  const secrets = await client.getSecrets({
    environment: "staging",
    path: "/tuj"
  });

  const expectedKeys = secrets.map(s => s.secretName);
  const missingKeys: string[] = [];

  // 2. Compare against current environment
  for (const key of expectedKeys) {
    if (!process.env[key]) {
      missingKeys.push(key);
    }
  }

  // 3. Handle Drift based on Strictness
  if (missingKeys.length > 0) {
    const message = `[Drift Detected] Missing keys: ${missingKeys.join(', ')}`;
    
    if (strictness === 'fail') {
      console.error(`❌ FATAL: ${message}`);
      process.exit(1);
    } else if (strictness === 'warn') {
      console.warn(`⚠️ WARNING: ${message}`);
    }
  } else {
    console.log("✅ No drift detected. Environment is 1:1 with Infisical.");
  }
}

runDriftCheck().catch(err => {
  console.error(err);
  process.exit(1);
});