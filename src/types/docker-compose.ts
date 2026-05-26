type DockerComposeScalar = string | number | boolean | null;

type DockerComposeEnvironment =
  | Record<string, DockerComposeScalar>
  | `${string}=${string}`[];

export interface DockerComposePort {
  target?: number;
  published?: number | string;
  protocol?: "tcp" | "udp";
  mode?: "host" | "ingress";
}

export interface DockerComposeVolume {
  type?: "bind" | "volume" | "tmpfs" | "npipe" | "cluster";
  source?: string;
  target?: string;
  read_only?: boolean;
}

export interface DockerComposeService {
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  container_name?: string;
  environment?: DockerComposeEnvironment;
  ports?: Array<string | DockerComposePort>;
  volumes?: Array<string | DockerComposeVolume>;
  depends_on?: string[] | Record<string, { condition?: string }>;
  command?: string | string[];
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
}

export interface DockerComposeConfig {
  version?: string;
  services: Record<string, DockerComposeService>;
  volumes?: Record<string, Record<string, DockerComposeScalar>>;
  networks?: Record<string, Record<string, DockerComposeScalar>>;
}
