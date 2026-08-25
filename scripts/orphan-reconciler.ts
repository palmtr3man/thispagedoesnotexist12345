import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

type System = "github" | "notion" | "supabase" | "netlify" | "infisical";
type Severity = "info" | "warning" | "critical";
interface Finding { findingId: string; ruleId: string; severity: Severity; system: System; entityType: string; entityId: string; summary: string; evidence: Record<string, unknown>; recommendedAction: string; }
interface Adapter { system: System; collect(): Promise<Finding[]>; }

const systems: System[] = ["github", "notion", "supabase", "netlify", "infisical"];
const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--apply");
const outputDir = "reports/orphan-reconciliation";
const now = new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

function finding(system: System, ruleId: string, entityType: string, entityId: string, summary: string, evidence: Record<string, unknown>, action: string, severity: Severity = "warning"): Finding {
  return { findingId: hash(`${system}:${ruleId}:${entityId}`), ruleId, severity, system, entityType, entityId, summary, evidence, recommendedAction: action };
}

// Adapters are intentionally read-only scaffolds. Provider clients can be added without changing detectors/reporting.
const adapters: Adapter[] = systems.map((system) => ({
  system,
  async collect() {
    const configured = Boolean(process.env[`${system.toUpperCase()}_RECONCILER_ENABLED`]);
    return configured ? [] : [finding(system, "SYSTEM.NOT_CONFIGURED", "system", system, `${system} adapter is not configured; no orphan claims made`, { configured }, `Configure ${system} credentials and adapter collection` , "info")];
  },
}));

function markdown(findings: Finding[]): string {
  const counts = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const lines = [`# Orphan & Drift Reconciliation`, ``, `Run ID: ${hash(now)}`, `Detected at: ${now}`, `Mode: ${dryRun ? "dry-run" : "apply (reserved; no mutations implemented)"}`, `Result: ${counts("critical") ? "FAIL" : counts("warning") ? "WARN" : "PASS"}`, ``, `## Summary`, `- Critical: ${counts("critical")}`, `- Warning: ${counts("warning")}`, `- Informational: ${counts("info")}`, `- Systems scanned: ${systems.join(", ")}`, ``];
  for (const f of findings) lines.push(`## ${f.severity.toUpperCase()}: ${f.ruleId}`, `- System: ${f.system}`, `- Entity: ${f.entityType}/${f.entityId}`, `- ${f.summary}`, `- Action: ${f.recommendedAction}`, ``);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const findings = (await Promise.all(adapters.map((a) => a.collect()))).flat();
  await mkdir(outputDir, { recursive: true });
  const report = { runId: hash(now), detectedAt: now, mode: dryRun ? "dry-run" : "apply", findings, summary: { critical: findings.filter(f => f.severity === "critical").length, warning: findings.filter(f => f.severity === "warning").length, info: findings.filter(f => f.severity === "info").length } };
  await writeFile(`${outputDir}/latest.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`${outputDir}/latest.md`, markdown(findings));
  console.log(markdown(findings));
  if (args.has("--fail-on-critical") && report.summary.critical > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
