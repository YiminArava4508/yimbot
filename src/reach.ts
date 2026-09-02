// src/reach.ts
// Whether the three outside services the daemon depends on are answering.
// Nothing is polled: every real gh, Linear and claude call reports its own
// outcome through observeReach, so the signal is exactly what the daemon
// experienced. A service nobody has called has nothing to say, and the board
// shows a warning only for one that is currently failing.
import { connect } from "node:net";
import { envOr } from "./env.ts";

export type Service = "github" | "linear" | "claude";

// The order the board lists them in, so two failing services always read the
// same way round.
const SERVICES: Service[] = ["github", "linear", "claude"];

// Where to knock when a call dies without saying why (see "timeout" below).
const HOSTS: Record<Service, string> = {
  github: "api.github.com",
  linear: "api.linear.app",
  claude: "api.anthropic.com",
};

// How long a recorded failure keeps showing without a further signal. gh and
// Linear are called every heartbeat, so their state self-heals in minutes;
// claude runs only for grouping, AC judging and refine, and without the expiry
// one failed run would leave the warning up until the next one, hours later.
function ttlMs(): number {
  const n = Number(envOr("REACH_TTL_MS", "900000"));
  return Number.isFinite(n) && n > 0 ? n : 900_000;
}

const failures = new Map<Service, number>();

export function resetReach(): void {
  failures.clear();
}

// `ttl` overrides the configured expiry, for tests that need a short one.
export function recordReach(service: Service, ok: boolean, now: number = Date.now(), ttl?: number): void {
  if (ok) failures.delete(service);
  else failures.set(service, now + (ttl ?? ttlMs()));
}

export function unreachable(now: number = Date.now()): Service[] {
  return SERVICES.filter((s) => {
    const until = failures.get(s);
    if (until === undefined) return false;
    if (now >= until) {
      failures.delete(s);
      return false;
    }
    return true;
  });
}

// What a failed call proves about the service:
//   unreachable - we never got an answer, and the error says why.
//   reached     - the service answered, just not with what we wanted (a 404, a
//                 GraphQL error, a non-zero exit).
//   timeout     - the call was killed at our own deadline. Proves nothing on its
//                 own: the claude CLI retries a transport failure internally
//                 rather than exiting, so a real Anthropic outage arrives here
//                 and nowhere else, while a slow prompt looks identical.
//                 observeReach knocks on the host to tell them apart.
//   unknown     - none of the above. Leaves the last known state standing,
//                 because guessing "reached" would blink a live warning off
//                 whenever an outage threw a phrasing we do not recognize.
export type Outcome = "unreachable" | "reached" | "timeout" | "unknown";

// Node's fetch reports a transport failure as `TypeError: fetch failed` with the
// real reason on `cause.code`; gh and other Go tools print theirs to stderr.
const NET_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NET_TEXT = [
  // What the Go net stack prints, which gh passes through for some commands.
  "no route to host",
  "could not resolve host",
  "network is unreachable",
  "connection refused",
  "temporary failure in name resolution",
  "tls handshake timeout",
  "i/o timeout",
  "connection timed out",
  "no such host",
  "server misbehaving",
  // gh's own wrapper, which replaces the above for the rest of its commands.
  "error connecting to",
  "check your internet connection",
  // undici, when the socket dies mid-response.
  "fetch failed",
  "socket hang up",
  "terminated",
];

function codeOf(err: unknown): unknown {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code ?? e?.cause?.code;
}

// The text a failed call is judged on. An execFile rejection always carries a
// stderr, even an empty one, and its message is the whole command line -- and
// the daemon's AC judge passes a Linear ticket description as an argv entry. So
// for those the message is never evidence, or a ticket that happens to mention
// "connection refused" could report claude as down for 15 minutes.
function evidence(err: unknown): string {
  const e = err as { stderr?: unknown };
  if (typeof e?.stderr === "string") return e.stderr.toLowerCase();
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

export function classifyError(err: unknown): Outcome {
  const code = codeOf(err);
  if (typeof code === "string" && NET_CODES.has(code)) return "unreachable";
  const text = evidence(err);
  if (NET_TEXT.some((t) => text.includes(t))) return "unreachable";
  // Killed at our own deadline: execFile sets killed/signal with a null exit
  // code, and runHeadless says so in as many words.
  const e = err as { killed?: unknown };
  if (e?.killed === true) return "timeout";
  if (text.includes("claude timed out after")) return "timeout";
  // A real exit code means the process ran and reported back, so the service
  // behind it answered. Same for the two wordings we build ourselves.
  if (typeof code === "number") return "reached";
  if (text.startsWith("claude exited ") || text.startsWith("linear graphql")) return "reached";
  return "unknown";
}

export type Probe = (host: string) => Promise<boolean>;

// A bare TCP connect, used only to settle a "timeout" (so at most once per
// killed call, never on a schedule). No request, no auth, no tokens: the
// question is only whether the host is there.
export const tcpProbe: Probe = (host) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port: 443 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

// Wrap one call to a service. The value and any rejection pass straight
// through; the only effect is the recorded outcome.
export async function observeReach<T>(service: Service, call: () => Promise<T>, probe: Probe = tcpProbe): Promise<T> {
  try {
    const value = await call();
    recordReach(service, true);
    return value;
  } catch (err) {
    switch (classifyError(err)) {
      case "unreachable":
        recordReach(service, false);
        break;
      case "reached":
        recordReach(service, true);
        break;
      case "timeout":
        recordReach(service, await probe(HOSTS[service]));
        break;
      case "unknown":
        break; // the last known state stands
    }
    throw err;
  }
}
