/**
 * @fileoverview Self-healing background recovery service for standalone headless deployments.
 *
 * Monitors active headless printer connections for sustained poll disconnects (such as
 * printer DHCP IP shifts or power cycles) and resolves boot-order races when the server
 * starts before the printer joins the LAN. When UDP multicast/broadcast discovery finds
 * the saved serial at a new IP—or when a router blocks UDP multicast and a local `/24`
 * HTTP `/detail` probe finds it—this service updates `printer_details.json`, tears down
 * the stale context, and reconnects cleanly.
 */

import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import { getConnectionFlowManager } from '../managers/ConnectionFlowManager';
import { getPrinterContextManager } from '../managers/PrinterContextManager';
import type {
  ConnectionResult,
  DiscoveredPrinter,
  PrinterClientType,
  PrinterDetails,
  StoredPrinterDetails,
} from '../types/printer';
import type { HeadlessConfig } from '../utils/HeadlessArguments';
import { applyPerPrinterDefaults } from '../utils/printerSettingsDefaults';
import { getMultiContextPollingCoordinator } from './MultiContextPollingCoordinator';
import { getPrinterDiscoveryService } from './PrinterDiscoveryService';
import { getSavedPrinterService } from './SavedPrinterService';

const INITIAL_RECOVERY_DELAY_MS = 15_000;
const RECOVERY_CHECK_INTERVAL_MS = 30_000;
const DISCONNECT_THRESHOLD = 2;
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_INTERVAL_MS = 1500;
const DISCOVERY_RETRIES = 2;
const TCP_PROBE_TIMEOUT_MS = 600;
const TCP_PROBE_CONCURRENCY = 48;
const HTTP_DETAIL_TIMEOUT_MS = 2000;
const DEFAULT_COMMAND_PORT = 8899;
const DEFAULT_HTTP_PORT = 8898;

const IGNORED_INTERFACE_PATTERN = /^(tailscale|docker|virbr|br-|veth|tun|tap)/i;

export interface AutoRecoveryContextSummary {
  id: string;
  printerDetails: PrinterDetails;
}

export interface AutoRecoveryDependencies {
  connectionManager: {
    disconnectContext(contextId: string, timeoutMs?: number): Promise<void>;
    connectWithSavedDetails(details: PrinterDetails): Promise<ConnectionResult>;
  };
  contextManager: {
    getAllContexts(): AutoRecoveryContextSummary[];
  };
  discoveryService: {
    isDiscoveryInProgress(): boolean;
    scanNetwork(
      timeout?: number,
      interval?: number,
      retries?: number
    ): Promise<DiscoveredPrinter[]>;
  };
  pollingCoordinator: {
    getPollingDataForContext(
      contextId: string
    ): { isConnected: boolean; isInitializing: boolean } | null;
  };
  savedPrinterService: {
    getLastUsedPrinter(): StoredPrinterDetails | null;
    getSavedPrinters(): StoredPrinterDetails[];
    savePrinter(printer: PrinterDetails): Promise<void>;
    updateLastConnected(serialNumber: string): Promise<void>;
  };
  subnetFallbackFinder?: (saved: StoredPrinterDetails) => Promise<DiscoveredPrinter | null>;
}

interface RecoveryCandidate {
  saved: StoredPrinterDetails;
  existingContext: AutoRecoveryContextSummary | null;
}

function isCgnatAddress(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}

function collectLocalSlash24Subnets(): Array<{ prefix: string; selfIp: string }> {
  const interfaces = os.networkInterfaces();
  const seenPrefixes = new Set<string>();
  const subnets: Array<{ prefix: string; selfIp: string }> = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || IGNORED_INTERFACE_PATTERN.test(name)) {
      continue;
    }

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal || addr.netmask !== '255.255.255.0') {
        continue;
      }
      if (isCgnatAddress(addr.address)) {
        continue;
      }

      const octets = addr.address.split('.');
      if (octets.length !== 4) {
        continue;
      }
      const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
      if (seenPrefixes.has(prefix)) {
        continue;
      }
      seenPrefixes.add(prefix);
      subnets.push({ prefix, selfIp: addr.address });
    }
  }

  return subnets;
}

function checkTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (open: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function probeFlashForgeDetail(
  ip: string,
  port: number,
  serialNumber: string,
  checkCode: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ serialNumber, checkCode });
    const req = http.request(
      {
        hostname: ip,
        port,
        path: '/detail',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: HTTP_DETAIL_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              code?: number;
              detail?: { name?: string } | null;
            };
            const detail = body.detail;
            const validDetail = detail !== null && typeof detail === 'object';
            const serialMatches = !detail?.name || detail.name === serialNumber;
            resolve(body.code === 0 && validDetail && serialMatches);
          } catch {
            resolve(false);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

async function scanSubnetHttpFallback(
  saved: StoredPrinterDetails
): Promise<DiscoveredPrinter | null> {
  const httpPort = saved.httpPort ?? DEFAULT_HTTP_PORT;
  const commandPort = saved.commandPort ?? DEFAULT_COMMAND_PORT;
  const subnets = collectLocalSlash24Subnets();
  if (subnets.length === 0) {
    return null;
  }

  const candidateIps: string[] = [];
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host++) {
      const ip = `${subnet.prefix}.${host}`;
      if (ip !== subnet.selfIp) {
        candidateIps.push(ip);
      }
    }
  }

  const openHosts: string[] = [];
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(TCP_PROBE_CONCURRENCY, candidateIps.length) },
    async () => {
      while (cursor < candidateIps.length) {
        const idx = cursor++;
        const ip = candidateIps[idx];
        if (await checkTcpPortOpen(ip, httpPort, TCP_PROBE_TIMEOUT_MS)) {
          openHosts.push(ip);
        }
      }
    }
  );
  await Promise.all(workers);

  for (const ip of openHosts) {
    const matched = await probeFlashForgeDetail(ip, httpPort, saved.SerialNumber, saved.CheckCode);
    if (matched) {
      return {
        name: saved.Name,
        ipAddress: ip,
        serialNumber: saved.SerialNumber,
        commandPort,
        eventPort: httpPort,
        status: 'Discovered',
      };
    }
  }

  return null;
}

function createDefaultDependencies(): AutoRecoveryDependencies {
  return {
    connectionManager: getConnectionFlowManager(),
    contextManager: getPrinterContextManager(),
    discoveryService: getPrinterDiscoveryService(),
    pollingCoordinator: getMultiContextPollingCoordinator(),
    savedPrinterService: getSavedPrinterService(),
  };
}

/**
 * Periodically checks headless printer contexts and automatically recovers
 * from printer IP changes, transient power cycles, or startup ordering races.
 */
export class HeadlessAutoRecoveryService {
  private readonly deps: AutoRecoveryDependencies;
  private mode: HeadlessConfig['mode'] = 'no-printers';
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isStopped = true;
  private isRunningCheck = false;
  private readonly consecutiveDisconnectedCounts = new Map<string, number>();
  private readonly unreachableLogTimestamps = new Map<string, number>();

  constructor(deps?: AutoRecoveryDependencies) {
    this.deps = deps ?? createDefaultDependencies();
  }

  /**
   * Start background recovery monitoring for headless saved-printer modes.
   */
  public start(mode: HeadlessConfig['mode']): void {
    this.stop();

    if (mode !== 'last-used' && mode !== 'all-saved') {
      this.mode = mode;
      return;
    }

    this.mode = mode;
    this.isStopped = false;

    if (this.deps.contextManager.getAllContexts().length === 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        void this.runCheck();
      }, INITIAL_RECOVERY_DELAY_MS);
      this.initialTimer.unref();
    }

    this.intervalTimer = setInterval(() => {
      void this.runCheck();
    }, RECOVERY_CHECK_INTERVAL_MS);
    this.intervalTimer.unref();

    console.log(`[AutoRecovery] Started headless auto-recovery monitor (mode: ${mode})`);
  }

  /**
   * Stop recovery timers and inhibit future checks.
   */
  public stop(): void {
    this.isStopped = true;

    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private getTargetSavedPrinters(): StoredPrinterDetails[] {
    if (this.mode === 'last-used') {
      const lastUsed = this.deps.savedPrinterService.getLastUsedPrinter();
      return lastUsed ? [lastUsed] : [];
    }

    if (this.mode === 'all-saved') {
      return this.deps.savedPrinterService.getSavedPrinters();
    }

    return [];
  }

  /**
   * Evaluate saved printer health and attempt discovery + reconnect when needed.
   */
  public async runCheck(): Promise<void> {
    if (
      this.isRunningCheck ||
      this.isStopped ||
      this.deps.discoveryService.isDiscoveryInProgress()
    ) {
      return;
    }

    this.isRunningCheck = true;

    try {
      const targetPrinters = this.getTargetSavedPrinters();
      if (targetPrinters.length === 0) {
        return;
      }

      const contexts = this.deps.contextManager.getAllContexts();
      const candidates: RecoveryCandidate[] = [];

      for (const saved of targetPrinters) {
        const existingContext =
          contexts.find((ctx) => ctx.printerDetails.SerialNumber === saved.SerialNumber) ?? null;

        if (!existingContext) {
          const nextCount = (this.consecutiveDisconnectedCounts.get(saved.SerialNumber) ?? 0) + 1;
          this.consecutiveDisconnectedCounts.set(saved.SerialNumber, nextCount);
          candidates.push({ saved, existingContext: null });
          continue;
        }

        const pollData = this.deps.pollingCoordinator.getPollingDataForContext(existingContext.id);
        if (!pollData || pollData.isInitializing || pollData.isConnected) {
          this.consecutiveDisconnectedCounts.set(saved.SerialNumber, 0);
          continue;
        }

        const nextCount = (this.consecutiveDisconnectedCounts.get(saved.SerialNumber) ?? 0) + 1;
        this.consecutiveDisconnectedCounts.set(saved.SerialNumber, nextCount);

        if (nextCount >= DISCONNECT_THRESHOLD) {
          candidates.push({ saved, existingContext });
        }
      }

      if (candidates.length === 0) {
        return;
      }

      const discovered = await this.deps.discoveryService.scanNetwork(
        DISCOVERY_TIMEOUT_MS,
        DISCOVERY_INTERVAL_MS,
        DISCOVERY_RETRIES
      );

      for (const candidate of candidates) {
        if (this.isStopped) {
          return;
        }
        await this.recoverCandidate(candidate, discovered);
      }
    } catch (error) {
      console.warn('[AutoRecovery] Recovery tick failed:', error);
    } finally {
      this.isRunningCheck = false;
    }
  }

  private async recoverCandidate(
    candidate: RecoveryCandidate,
    discovered: DiscoveredPrinter[]
  ): Promise<void> {
    const { saved, existingContext } = candidate;
    let match = discovered.find((d) => d.serialNumber === saved.SerialNumber) ?? null;

    if (!match && (saved.ClientType ?? 'new') === 'new') {
      const fallbackFinder = this.deps.subnetFallbackFinder ?? scanSubnetHttpFallback;
      match = await fallbackFinder(saved);
    }

    if (!match) {
      const now = Date.now();
      const lastLogged = this.unreachableLogTimestamps.get(saved.SerialNumber) ?? 0;
      if (now - lastLogged >= 5 * 60_000) {
        this.unreachableLogTimestamps.set(saved.SerialNumber, now);
        console.log(
          `[AutoRecovery] Printer ${saved.Name} (${saved.SerialNumber}) not reachable on network; will keep retrying`
        );
      }
      return;
    }

    const updatedCommandPort = match.commandPort ?? saved.commandPort;
    const updatedHttpPort = match.eventPort ?? saved.httpPort;

    const updatedDetails: PrinterDetails = applyPerPrinterDefaults({
      Name: saved.Name,
      IPAddress: match.ipAddress,
      SerialNumber: saved.SerialNumber,
      CheckCode: saved.CheckCode,
      ClientType: (saved.ClientType ?? 'new') as PrinterClientType,
      printerModel: saved.printerModel,
      modelType: saved.modelType,
      commandPort: updatedCommandPort,
      httpPort: updatedHttpPort,
      customCameraEnabled: saved.customCameraEnabled,
      customCameraUrl: saved.customCameraUrl,
      customLedsEnabled: saved.customLedsEnabled,
      forceLegacyMode: saved.forceLegacyMode,
      webUIEnabled: saved.webUIEnabled,
      activeSpoolData: saved.activeSpoolData,
    });

    const ipChanged = match.ipAddress !== saved.IPAddress;
    const commandPortChanged = Boolean(
      match.commandPort && match.commandPort !== saved.commandPort
    );
    const httpPortChanged = Boolean(match.eventPort && match.eventPort !== saved.httpPort);

    if (ipChanged || commandPortChanged || httpPortChanged) {
      console.log(
        `[AutoRecovery] Printer ${saved.Name} (${saved.SerialNumber}) moved ${saved.IPAddress} -> ${match.ipAddress}`
      );
      await this.deps.savedPrinterService.savePrinter(updatedDetails);
    }

    if (existingContext) {
      await this.deps.connectionManager
        .disconnectContext(existingContext.id, 3000)
        .catch((err) => console.warn('[AutoRecovery] Disconnect cleanup warning:', err));
    }

    const res = await this.deps.connectionManager.connectWithSavedDetails(updatedDetails);
    if (res.success) {
      await this.deps.savedPrinterService.updateLastConnected(saved.SerialNumber);
      this.consecutiveDisconnectedCounts.set(saved.SerialNumber, 0);
      this.unreachableLogTimestamps.delete(saved.SerialNumber);
      console.log(
        `[AutoRecovery] Connected to ${updatedDetails.Name} at ${updatedDetails.IPAddress}`
      );
    } else {
      console.warn(
        `[AutoRecovery] Reconnect attempt failed for ${updatedDetails.Name} at ${updatedDetails.IPAddress}: ${res.error ?? 'Unknown error'}`
      );
    }
  }
}

let autoRecoveryInstance: HeadlessAutoRecoveryService | null = null;

export function getHeadlessAutoRecoveryService(): HeadlessAutoRecoveryService {
  if (!autoRecoveryInstance) {
    autoRecoveryInstance = new HeadlessAutoRecoveryService();
  }
  return autoRecoveryInstance;
}
