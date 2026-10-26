/**
 * Minimal Infisical REST client for the drift scripts.
 *
 * @infisical/sdk 5 pulls zod 3, which is inside GHSA-mrhx-c7xc-m3w5
 * (`<4.6.6`, no patched 3.x release). These scripts only list, create, and
 * update raw secrets, so they call the same v3 routes the SDK called.
 */

export interface InfisicalSecret {
  secretKey?: string;
  secretValue?: string;
}

export interface InfisicalListResponse {
  secrets?: InfisicalSecret[];
}

export interface InfisicalSecretWrite {
  projectId: string;
  environment: string;
  secretPath: string;
  secretValue: string;
}

export class InfisicalRestClient {
  private token = "";

  constructor(private readonly siteUrl: string) {}

  useAccessToken(token: string): void {
    this.token = token.trim();
  }

  async loginUniversalAuth(clientId: string, clientSecret: string): Promise<void> {
    const response = await fetch(this.url("/api/v1/auth/universal-auth/login"), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    if (!response.ok) {
      throw new Error(`Infisical universal auth failed (${response.status})`);
    }
    const body = await response.json() as { accessToken?: string };
    if (!body.accessToken) {
      throw new Error("Infisical universal auth did not return an access token");
    }
    this.token = body.accessToken;
  }

  async listSecrets(options: {
    projectId: string;
    environment: string;
    secretPath: string;
    viewSecretValue?: boolean;
  }): Promise<InfisicalListResponse> {
    const params = new URLSearchParams({
      workspaceId: options.projectId,
      environment: options.environment,
      secretPath: options.secretPath,
      expandSecretReferences: "true",
      include_imports: "false",
      recursive: "false",
      viewSecretValue: options.viewSecretValue === false ? "false" : "true",
    });
    return this.request("GET", `/api/v3/secrets/raw?${params}`);
  }

  async createSecret(secretName: string, options: InfisicalSecretWrite): Promise<unknown> {
    return this.writeSecret("POST", secretName, options);
  }

  async updateSecret(secretName: string, options: InfisicalSecretWrite): Promise<unknown> {
    return this.writeSecret("PATCH", secretName, options);
  }

  private async writeSecret(
    method: "POST" | "PATCH",
    secretName: string,
    options: InfisicalSecretWrite,
  ): Promise<unknown> {
    return this.request(method, `/api/v3/secrets/raw/${encodeURIComponent(secretName)}`, {
      workspaceId: options.projectId,
      environment: options.environment,
      secretPath: options.secretPath,
      secretValue: options.secretValue,
    });
  }

  private url(path: string): string {
    return `${this.siteUrl.replace(/\/$/, "")}${path}`;
  }

  private async request(method: string, path: string, body?: Record<string, string>): Promise<any> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Infisical ${method} ${path.split("?")[0]} failed (${response.status})`);
    }
    return response.json();
  }
}
