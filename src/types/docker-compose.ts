export interface DockerComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  ports?: Array<string | number>;
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
  environment?: Record<string, string | number | boolean | null> | string[];
  depends_on?: string[] | Record<string, unknown>;
  command?: string | string[];
  entrypoint?: string | string[];
  restart?: string;
  [key: string]: unknown;
}

export interface DockerComposeConfig {
  version?: string;
  services: Record<string, DockerComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

export function validateDockerComposeConfig(config: unknown): DockerComposeConfig {
  if (!isPlainObject(config)) {
    invalid('Invalid docker-compose config: expected an object');
  }

  const obj = config as Record<string, unknown>;

  if (!isPlainObject(obj.services)) {
    invalid('Invalid docker-compose config: "services" must be an object');
  }

  const services = obj.services as Record<string, unknown>;

  for (const [key, service] of Object.entries(services)) {
    if (!isPlainObject(service)) {
      invalid(`Invalid docker-compose config: service "${key}" must be an object`);
    }

    const svc = service as Record<string, unknown>;

    if (svc.ports !== undefined && !Array.isArray(svc.ports)) {
      invalid(`Invalid docker-compose config: service "${key}" has invalid "ports" (expected an array)`);
    }

    if (svc.volumes !== undefined && !Array.isArray(svc.volumes)) {
      invalid(`Invalid docker-compose config: service "${key}" has invalid "volumes" (expected an array)`);
    }

    if (svc.environment !== undefined) {
      const env = svc.environment;
      const validEnv =
        (isPlainObject(env)) ||
        (Array.isArray(env) && env.every((item) => typeof item === 'string'));
      if (!validEnv) {
        invalid(
          `Invalid docker-compose config: service "${key}" has invalid "environment" (expected an object or an array of strings)`,
        );
      }
    }

    if (svc.depends_on !== undefined) {
      const dependsOn = svc.depends_on;
      if (!Array.isArray(dependsOn) && !isPlainObject(dependsOn)) {
        invalid(
          `Invalid docker-compose config: service "${key}" has invalid "depends_on" (expected an array or an object)`,
        );
      }
    }
  }

  return config as DockerComposeConfig;
}
