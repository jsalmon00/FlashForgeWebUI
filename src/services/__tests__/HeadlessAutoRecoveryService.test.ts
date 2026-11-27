/**
 * @fileoverview Unit tests for HeadlessAutoRecoveryService disconnect and boot-race recovery.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type {
  ConnectionResult,
  DiscoveredPrinter,
  PrinterDetails,
  StoredPrinterDetails,
} from '../../types/printer';
import {
  type AutoRecoveryContextSummary,
  type AutoRecoveryDependencies,
  HeadlessAutoRecoveryService,
} from '../HeadlessAutoRecoveryService';

function makeSavedPrinter(overrides: Partial<StoredPrinterDetails> = {}): StoredPrinterDetails {
  return {
    Name: 'SNMOME9902235',
    IPAddress: '192.168.1.193',
    SerialNumber: 'SNMOME9902235',
    CheckCode: 'a31d9729',
    ClientType: 'new',
    printerModel: 'Flashforge Adventurer 5M Pro',
    modelType: 'adventurer-5m-pro',
    commandPort: 8899,
    httpPort: 8898,
    customCameraEnabled: false,
    customCameraUrl: '',
    customLedsEnabled: false,
    forceLegacyMode: false,
    webUIEnabled: true,
    lastConnected: '2026-11-20T23:10:00.994Z',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AutoRecoveryDependencies> = {}): {
  deps: AutoRecoveryDependencies;
  disconnectContext: jest.Mock<(contextId: string, timeoutMs?: number) => Promise<void>>;
  connectWithSavedDetails: jest.Mock<(details: PrinterDetails) => Promise<ConnectionResult>>;
  scanNetwork: jest.Mock<
    (timeout?: number, interval?: number, retries?: number) => Promise<DiscoveredPrinter[]>
  >;
  savePrinter: jest.Mock<(printer: PrinterDetails) => Promise<void>>;
  updateLastConnected: jest.Mock<(serialNumber: string) => Promise<void>>;
} {
  const saved = makeSavedPrinter();
  const disconnectContext = jest.fn(async (_contextId: string, _timeoutMs?: number) => {});
  const connectWithSavedDetails = jest.fn(
    async (details: PrinterDetails): Promise<ConnectionResult> => ({
      success: true,
      printerDetails: details,
    })
  );
  const scanNetwork = jest.fn(
    async (
      _timeout?: number,
      _interval?: number,
      _retries?: number
    ): Promise<DiscoveredPrinter[]> => []
  );
  const savePrinter = jest.fn(async (_printer: PrinterDetails) => {});
  const updateLastConnected = jest.fn(async (_serialNumber: string) => {});

  const deps: AutoRecoveryDependencies = {
    connectionManager: {
      disconnectContext,
      connectWithSavedDetails,
    },
    contextManager: {
      getAllContexts: () => [],
    },
    discoveryService: {
      isDiscoveryInProgress: () => false,
      scanNetwork,
    },
    pollingCoordinator: {
      getPollingDataForContext: () => ({ isConnected: true, isInitializing: false }),
    },
    savedPrinterService: {
      getLastUsedPrinter: () => saved,
      getSavedPrinters: () => [saved],
      savePrinter,
      updateLastConnected,
    },
    subnetFallbackFinder: async () => null,
    ...overrides,
  };

  return {
    deps,
    disconnectContext,
    connectWithSavedDetails,
    scanNetwork,
    savePrinter,
    updateLastConnected,
  };
}

describe('HeadlessAutoRecoveryService', () => {
  let service: HeadlessAutoRecoveryService | null = null;

  afterEach(() => {
    service?.stop();
    service = null;
  });

  it('does not scan network when active context polling is healthy', async () => {
    const saved = makeSavedPrinter();
    const contexts: AutoRecoveryContextSummary[] = [{ id: 'ctx-1', printerDetails: saved }];
    const { deps, scanNetwork, connectWithSavedDetails } = makeDeps({
      contextManager: { getAllContexts: () => contexts },
      pollingCoordinator: {
        getPollingDataForContext: () => ({ isConnected: true, isInitializing: false }),
      },
    });

    service = new HeadlessAutoRecoveryService(deps);
    service.start('last-used');

    await service.runCheck();
    await service.runCheck();

    expect(scanNetwork).not.toHaveBeenCalled();
    expect(connectWithSavedDetails).not.toHaveBeenCalled();
  });

  it('waits for two consecutive disconnected checks before scanning and reconnecting', async () => {
    const saved = makeSavedPrinter();
    const contexts: AutoRecoveryContextSummary[] = [{ id: 'ctx-1', printerDetails: saved }];
    const { deps, scanNetwork, disconnectContext, connectWithSavedDetails } = makeDeps({
      contextManager: { getAllContexts: () => contexts },
      pollingCoordinator: {
        getPollingDataForContext: () => ({ isConnected: false, isInitializing: false }),
      },
    });

    scanNetwork.mockResolvedValue([
      {
        name: 'SNMOME9902235',
        ipAddress: '192.168.1.193',
        serialNumber: 'SNMOME9902235',
        commandPort: 8899,
        eventPort: 8898,
        status: 'Discovered',
      },
    ]);

    service = new HeadlessAutoRecoveryService(deps);
    service.start('last-used');

    await service.runCheck();
    expect(scanNetwork).not.toHaveBeenCalled();
    expect(disconnectContext).not.toHaveBeenCalled();

    await service.runCheck();
    expect(scanNetwork).toHaveBeenCalledTimes(1);
    expect(disconnectContext).toHaveBeenCalledWith('ctx-1', 3000);
    expect(connectWithSavedDetails).toHaveBeenCalledTimes(1);
  });

  it('saves updated IP and reconnects when printer DHCP address shifts from .193 to .192', async () => {
    const saved = makeSavedPrinter({ IPAddress: '192.168.1.193' });
    const contexts: AutoRecoveryContextSummary[] = [{ id: 'ctx-old', printerDetails: saved }];
    const {
      deps,
      scanNetwork,
      savePrinter,
      disconnectContext,
      connectWithSavedDetails,
      updateLastConnected,
    } = makeDeps({
      contextManager: { getAllContexts: () => contexts },
      pollingCoordinator: {
        getPollingDataForContext: () => ({ isConnected: false, isInitializing: false }),
      },
    });

    scanNetwork.mockResolvedValue([
      {
        name: 'SNMOME9902235',
        ipAddress: '192.168.1.192',
        serialNumber: 'SNMOME9902235',
        commandPort: 8899,
        eventPort: 8898,
        status: 'Discovered',
      },
    ]);

    service = new HeadlessAutoRecoveryService(deps);
    service.start('last-used');

    await service.runCheck();
    await service.runCheck();

    expect(savePrinter).toHaveBeenCalledTimes(1);
    expect(savePrinter.mock.calls[0][0].IPAddress).toBe('192.168.1.192');
    expect(disconnectContext).toHaveBeenCalledWith('ctx-old', 3000);
    expect(connectWithSavedDetails).toHaveBeenCalledTimes(1);
    expect(connectWithSavedDetails.mock.calls[0][0].IPAddress).toBe('192.168.1.192');
    expect(updateLastConnected).toHaveBeenCalledWith('SNMOME9902235');
  });

  it('discovers and connects immediately on first check when zero contexts exist (boot-order race)', async () => {
    const {
      deps,
      scanNetwork,
      disconnectContext,
      savePrinter,
      connectWithSavedDetails,
      updateLastConnected,
    } = makeDeps({
      contextManager: { getAllContexts: () => [] },
    });

    scanNetwork.mockResolvedValue([
      {
        name: 'SNMOME9902235',
        ipAddress: '192.168.1.192',
        serialNumber: 'SNMOME9902235',
        commandPort: 8899,
        eventPort: 8898,
        status: 'Discovered',
      },
    ]);

    service = new HeadlessAutoRecoveryService(deps);
    service.start('last-used');

    await service.runCheck();

    expect(scanNetwork).toHaveBeenCalledTimes(1);
    expect(disconnectContext).not.toHaveBeenCalled();
    expect(savePrinter).toHaveBeenCalledTimes(1);
    expect(savePrinter.mock.calls[0][0].IPAddress).toBe('192.168.1.192');
    expect(connectWithSavedDetails).toHaveBeenCalledTimes(1);
    expect(connectWithSavedDetails.mock.calls[0][0].IPAddress).toBe('192.168.1.192');
    expect(updateLastConnected).toHaveBeenCalledWith('SNMOME9902235');
  });
});
