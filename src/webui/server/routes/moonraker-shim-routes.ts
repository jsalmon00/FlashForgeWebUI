/**
 * @fileoverview Moonraker HTTP compatibility shim routes for third-party integrations (e.g. PrintGuard).
 *
 * Exposes the subset of Moonraker's REST API consumed by Klipper/Moonraker clients
 * directly on the FlashForgeWebUI HTTP server so external monitors can read live state
 * and temperatures, auto-discover the multiplexed camera stream, trigger pause/resume/cancel,
 * set heater targets, and upload print jobs without requiring custom printer firmware.
 */

import express, { type Application, type Request, type Response } from 'express';
import { basename } from 'node:path';
import type { CommandResult } from '../../../types/printer-backend';
import { toAppError } from '../../../utils/error.utils';
import type { AuthenticatedRequest } from '../auth-middleware';
import { discardStagedUpload, isAllowedJobFileName, stageUpload } from '../upload-staging';
import { type RouteDependencies, resolveContext } from './route-helpers';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface ExtendedShimStatus {
  readonly printerState: string;
  readonly bedTemperature: number;
  readonly nozzleTemperature: number;
  readonly progress: number;
  readonly currentJob?: string;
  readonly bedTargetTemperature?: number;
  readonly nozzleTargetTemperature?: number;
  readonly printDuration?: number;
  readonly machineInfo?: {
    readonly PrintBed?: { readonly set?: number };
    readonly Extruder?: { readonly set?: number };
  };
}

interface ParsedMultipartUpload {
  readonly fileName: string;
  readonly fileData: Buffer;
  readonly startPrint: boolean;
}

function mapMoonrakerPrintState(printerState: string): string {
  switch (printerState.trim().toLowerCase()) {
    case 'printing':
    case 'busy':
    case 'calibrating':
    case 'heating':
      return 'printing';
    case 'paused':
    case 'pausing':
      return 'paused';
    case 'completed':
      return 'complete';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return 'standby';
  }
}

function sendMoonrakerError(res: Response, statusCode: number, message: string): void {
  res.status(statusCode).json({ error: { code: statusCode, message } });
}

function parseMultipartFormBuffer(body: Buffer, contentType: string): ParsedMultipartUpload | null {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundaryMatch) {
    return null;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');

  let startPrint = false;
  let fileName: string | null = null;
  let fileData: Buffer | null = null;

  let cursor = body.indexOf(boundaryMarker);
  while (cursor !== -1) {
    const partStart = cursor + boundaryMarker.length;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) {
      break;
    }

    const contentStart = body.subarray(partStart, partStart + 2).equals(Buffer.from('\r\n'))
      ? partStart + 2
      : partStart;
    const nextBoundary = body.indexOf(boundaryMarker, contentStart);
    if (nextBoundary === -1) {
      break;
    }

    let partEnd = nextBoundary;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }

    const sepIdx = body.indexOf(headerSeparator, contentStart);
    if (sepIdx !== -1 && sepIdx < partEnd) {
      const headersText = body.subarray(contentStart, sepIdx).toString('utf8');
      const payload = body.subarray(sepIdx + headerSeparator.length, partEnd);
      const nameMatch = /name="([^"]+)"/i.exec(headersText);
      const fieldName = nameMatch?.[1];

      if (fieldName === 'file') {
        const fileNameMatch = /filename="([^"]+)"/i.exec(headersText);
        fileName = fileNameMatch?.[1] ? basename(fileNameMatch[1]) : 'upload.gcode';
        fileData = payload;
      } else if (fieldName === 'print') {
        startPrint = payload.toString('utf8').trim().toLowerCase() === 'true';
      }
    }

    cursor = nextBoundary;
  }

  if (!fileName || !fileData) {
    return null;
  }

  return { fileName, fileData, startPrint };
}

async function runContextCommand(
  req: Request,
  res: Response,
  deps: RouteDependencies,
  executor: (contextId: string) => Promise<CommandResult>
): Promise<void> {
  try {
    const contextResult = resolveContext(req as AuthenticatedRequest, deps, {
      requireBackendReady: true,
    });
    if (!contextResult.success) {
      sendMoonrakerError(res, contextResult.statusCode, contextResult.error);
      return;
    }

    const result = await executor(contextResult.contextId);
    if (!result.success) {
      sendMoonrakerError(res, 500, result.error || 'Printer command failed');
      return;
    }

    res.status(200).json({ result: 'ok' });
  } catch (error) {
    sendMoonrakerError(res, 500, toAppError(error).message);
  }
}

/**
 * Mount unauthenticated Moonraker compatibility routes on the root Express app.
 */
export function registerMoonrakerShimRoutes(app: Application, deps: RouteDependencies): void {
  app.get('/printer/objects/query', async (req: Request, res: Response) => {
    try {
      const contextResult = resolveContext(req as AuthenticatedRequest, deps, {
        requireBackendReady: true,
      });
      if (!contextResult.success) {
        sendMoonrakerError(res, contextResult.statusCode, contextResult.error);
        return;
      }

      const statusResult = await deps.backendManager.getPrinterStatus(contextResult.contextId);
      if (!statusResult.success || !statusResult.status) {
        sendMoonrakerError(res, 500, statusResult.error || 'Failed to query printer status');
        return;
      }

      const status = statusResult.status as ExtendedShimStatus;
      const rawProgress = Number(status.progress ?? 0);
      const progress = Math.max(0, Math.min(1, rawProgress > 1 ? rawProgress / 100 : rawProgress));
      const nozzleTarget =
        status.nozzleTargetTemperature ?? status.machineInfo?.Extruder?.set ?? 0;
      const bedTarget = status.bedTargetTemperature ?? status.machineInfo?.PrintBed?.set ?? 0;

      res.status(200).json({
        result: {
          status: {
            print_stats: {
              state: mapMoonrakerPrintState(status.printerState),
              filename: status.currentJob || '',
              print_duration: status.printDuration ?? 0,
            },
            virtual_sdcard: {
              progress,
            },
            extruder: {
              temperature: status.nozzleTemperature ?? 0,
              target: nozzleTarget,
            },
            heater_bed: {
              temperature: status.bedTemperature ?? 0,
              target: bedTarget,
            },
          },
        },
      });
    } catch (error) {
      sendMoonrakerError(res, 500, toAppError(error).message);
    }
  });

  const jobActions: ReadonlyArray<{
    readonly path: string;
    readonly executor: (contextId: string) => Promise<CommandResult>;
  }> = [
    { path: '/printer/print/pause', executor: (id) => deps.backendManager.pauseJob(id) },
    { path: '/printer/print/resume', executor: (id) => deps.backendManager.resumeJob(id) },
    { path: '/printer/print/cancel', executor: (id) => deps.backendManager.cancelJob(id) },
  ];

  for (const action of jobActions) {
    app.post(action.path, async (req: Request, res: Response) => {
      await runContextCommand(req, res, deps, action.executor);
    });
  }

  app.post('/printer/gcode/script', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const rawScript =
      typeof body?.script === 'string'
        ? body.script
        : typeof req.query.script === 'string'
          ? req.query.script
          : '';
    const script = rawScript.trim();

    if (!script) {
      sendMoonrakerError(res, 400, 'Missing script parameter');
      return;
    }

    await runContextCommand(req, res, deps, async (contextId) => {
      const heaterMatch =
        /^SET_HEATER_TEMPERATURE\s+HEATER=(extruder|heater_bed)\s+TARGET=([0-9]+(?:\.[0-9]+)?)$/i.exec(
          script
        );
      if (heaterMatch) {
        const heater = heaterMatch[1].toLowerCase();
        const target = Math.round(Number.parseFloat(heaterMatch[2]));
        if (heater === 'extruder') {
          return target > 0
            ? deps.backendManager.setExtruderTemperature(contextId, target)
            : deps.backendManager.cancelExtruderTemperature(contextId);
        }
        return target > 0
          ? deps.backendManager.setBedTemperature(contextId, target)
          : deps.backendManager.cancelBedTemperature(contextId);
      }

      const cmd = script.startsWith('~') ? script : `~${script}`;
      return deps.backendManager.executeGCodeCommand(contextId, cmd);
    });
  });

  app.get('/server/webcams/list', (_req: Request, res: Response) => {
    res.status(200).json({
      result: {
        webcams: [
          {
            uid: 'flashforge-oem-camera',
            name: 'Adventurer 5M Pro Camera',
            enabled: true,
            service: 'mjpegstreamer',
            stream_url: '/?action=stream',
            snapshot_url: '/?action=snapshot',
          },
        ],
      },
    });
  });

  app.post(
    '/server/files/upload',
    express.raw({ type: 'multipart/form-data', limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      try {
        const contextResult = resolveContext(req as AuthenticatedRequest, deps, {
          requireBackendReady: true,
        });
        if (!contextResult.success) {
          sendMoonrakerError(res, contextResult.statusCode, contextResult.error);
          return;
        }

        const contentType = req.headers['content-type'] || '';
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const parsed = parseMultipartFormBuffer(body, contentType);
        if (!parsed || parsed.fileData.length === 0) {
          sendMoonrakerError(res, 400, 'Missing or empty multipart file upload');
          return;
        }

        if (!isAllowedJobFileName(parsed.fileName)) {
          sendMoonrakerError(res, 400, `Unsupported job file name: ${parsed.fileName}`);
          return;
        }

        const staged = await stageUpload(parsed.fileName, parsed.fileData);
        try {
          const result = await deps.backendManager.startJob(contextResult.contextId, {
            operation: 'start',
            filePath: staged.filePath,
            fileName: staged.fileName,
            leveling: false,
            startNow: parsed.startPrint,
          });

          if (!result.success) {
            sendMoonrakerError(res, 500, result.error || 'Failed to upload/start print job');
            return;
          }

          res.status(201).json({
            print_started: parsed.startPrint,
            item: { path: staged.fileName },
          });
        } finally {
          await discardStagedUpload(staged.id);
        }
      } catch (error) {
        sendMoonrakerError(res, 500, toAppError(error).message);
      }
    }
  );
}
